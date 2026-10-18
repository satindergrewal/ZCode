import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserControlPort, Logger, McpServerConfig, TraceContext } from "@zcode/contracts";
import {
  NODE_REPL_BROWSER_BROKER_SOCKET_ENV,
  NODE_REPL_BROWSER_BROKER_TOKEN_ENV,
  nodeReplBrowserBrokerRequestSchema,
  type NodeReplBrowserBrokerRequest,
  type NodeReplBrowserBrokerResponse,
} from "@zcode/shared";

const NODE_REPL_MCP_SERVER_NAME = "node_repl";
const MAX_REQUEST_BYTES = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface NodeReplBrowserBroker {
  close(): Promise<void>;
  ready: Promise<void>;
  socketPath: string;
  token: string;
}

export function createNodeReplBrowserBroker(input: {
  browserControlPort: BrowserControlPort;
  logger: Logger;
  platform?: NodeJS.Platform | string;
}): NodeReplBrowserBroker {
  const socketPath = createSocketPath(input.platform ?? process.platform);
  const token = randomBytes(32).toString("hex");
  const server = createServer((socket) => {
    handleSocket(socket, { ...input, token }).catch((error) => {
      input.logger.warn("Node REPL browser broker request failed", {
        event: "node_repl.browser_broker.request.failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  server.on("error", (error) => {
    input.logger.error("Node REPL browser broker failed", error, {
      event: "node_repl.browser_broker.failed",
    });
  });
  server.listen(socketPath);
  server.unref();
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  return {
    ready,
    socketPath,
    token,
    close: async () => {
      // createZCodeApp is a synchronous factory; with very short lifetimes close can precede the listen callback,
      // so checking server.listening directly would miss a socket bound right after.
      await ready.catch(() => undefined);
      await closeServer(server);
      if ((input.platform ?? process.platform) !== "win32") {
        await rm(socketPath, { force: true });
      }
    },
  };
}

export function injectNodeReplBrowserBroker(
  servers: Record<string, McpServerConfig>,
  broker: NodeReplBrowserBroker | undefined,
): Record<string, McpServerConfig> {
  if (!broker) return servers;
  const nodeRepl = servers[NODE_REPL_MCP_SERVER_NAME];
  if (!nodeRepl || nodeRepl.type !== "stdio") return servers;
  return {
    ...servers,
    [NODE_REPL_MCP_SERVER_NAME]: {
      ...nodeRepl,
      env: {
        ...nodeRepl.env,
        [NODE_REPL_BROWSER_BROKER_SOCKET_ENV]: broker.socketPath,
        [NODE_REPL_BROWSER_BROKER_TOKEN_ENV]: broker.token,
      },
    },
  };
}

function createSocketPath(platform: NodeJS.Platform | string): string {
  const id = randomUUID();
  return platform === "win32"
    ? `\\\\.\\pipe\\zcode-node-repl-${id}`
    : join(tmpdir(), `znr-${id}.sock`);
}

async function handleSocket(
  socket: Socket,
  input: {
    browserControlPort: BrowserControlPort;
    logger: Logger;
    token: string;
  },
): Promise<void> {
  const abortController = new AbortController();
  let completed = false;
  let requestId = randomUUID();
  // steer makes the node_repl client abort and immediately socket.destroy(), usually while the broker is
  // still writing screenshot base64. An error listener only during readLine (removed by cleanup on resolve) is not enough:
  // during the response write there is no listener at all, so a peer-disconnect EPIPE becomes an unhandled 'error' event that
  // kills the whole Agent process (Unhandled error event -> exit 1). Keep a listener for the socket's whole lifetime and collapse
  // peer disconnects into "cancel the current request" instead of bubbling a process-level error.
  socket.on("error", (error) => {
    if (!completed) abortController.abort();
    input.logger.debug("Node REPL browser broker connection dropped", {
      event: "node_repl.browser_broker.connection.dropped",
      error: error.message,
    });
  });
  socket.once("close", () => {
    if (!completed) abortController.abort();
  });
  try {
    const raw = await readLine(socket, abortController.signal);
    const payload = JSON.parse(raw) as unknown;
    // A strict schema throws on unknown fields such as timeout; the random placeholder id used to be replaced only after a full parse,
    // so real parameter errors were swallowed by the client's response-id-mismatch secondary error.
    requestId = requestIdFromPayload(payload) ?? requestId;
    const request = nodeReplBrowserBrokerRequestSchema.parse(payload);
    requestId = request.id as ReturnType<typeof randomUUID>;
    authorizeRequest(request, input);
    const response = await executeRequest(
      request,
      input.browserControlPort,
      abortController.signal,
    );
    completed = true;
    respond(socket, response);
  } catch (error) {
    completed = true;
    respond(socket, {
      id: requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function requestIdFromPayload(payload: unknown): ReturnType<typeof randomUUID> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" && UUID_PATTERN.test(id)
    ? (id as ReturnType<typeof randomUUID>)
    : undefined;
}

function respond(socket: Socket, response: NodeReplBrowserBrokerResponse): void {
  // The peer may have destroyed the socket after the steer cancel; writing back is pointless and only earns an EPIPE.
  if (!socket.writable) return;
  socket.end(`${JSON.stringify(response)}\n`);
}

function authorizeRequest(request: NodeReplBrowserBrokerRequest, input: { token: string }): void {
  const actual = Buffer.from(request.token);
  const expected = Buffer.from(input.token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Node REPL browser broker request is not authorized");
  }
  // The shared MCP child process can no longer be bound to one session, but top-level MCP metadata still
  // must not grant Browser permission directly. The private socket token first proves the request comes from the host-launched node_repl; the
  // sessionId is then authoritatively checked by BrowserControlPort's requireSession, and subagents are rejected before reaching the port.
  if (request.runtimeScope === "subagent") {
    throw new Error("Browser is not available in subagent");
  }
}

async function executeRequest(
  request: NodeReplBrowserBrokerRequest,
  port: BrowserControlPort,
  signal: AbortSignal,
): Promise<NodeReplBrowserBrokerResponse> {
  const traceContext = request.trace as TraceContext | undefined;
  if (request.op === "list") {
    const browsers = await port.list({
      sessionId: request.sessionId,
      turnId: request.turnId,
      traceContext,
      signal,
    });
    return { id: request.id, ok: true, browsers };
  }
  const result = await port.execute({
    browserId: request.browserId,
    browserGeneration: request.browserGeneration,
    sessionId: request.sessionId,
    turnId: request.turnId,
    command: request.command,
    traceContext,
    signal,
  });
  return { id: request.id, ok: true, result };
}

async function readLine(socket: Socket, signal: AbortSignal): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        cleanup();
        reject(new Error("Node REPL browser broker request exceeded 1 MiB"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
