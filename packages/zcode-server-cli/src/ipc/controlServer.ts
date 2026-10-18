import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import {
  controlRequestSchema,
  controlResponseSchema,
  type ControlRequest,
  type ControlResponse,
} from "../contracts.js";
import { encodeJsonLine, JsonLineDecoder } from "./framing.js";
import { ControlRequestError } from "./controlError.js";

const CONTROL_CLOSE_TIMEOUT_MS = 2_000;

export interface ControlHandler {
  (request: ControlRequest): Promise<unknown>;
}

export async function createControlServer(
  endpoint: string,
  handler: ControlHandler,
): Promise<{ server: Server; close: () => Promise<void> }> {
  await rm(endpoint, { force: true }).catch(() => undefined);
  await mkdir(endpoint.includes("/") ? endpoint.slice(0, endpoint.lastIndexOf("/")) : ".", {
    recursive: true,
  }).catch(() => undefined);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleSocket(socket, handler);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(endpoint, 0o600).catch(() => undefined);
  // server.close() only stops new connections and still waits for existing ones to finish.
  // The control socket is part of lifecycle teardown: track and destroy connections so a hung
  // same-UID client cannot hold the close callback forever and pin the Supervisor's lock and
  // lifecycle operation.
  let closePromise: Promise<void> | undefined;
  return {
    server,
    close: async () => {
      if (closePromise) return await closePromise;
      closePromise = (async () => {
        const serverClosed = new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        for (const socket of sockets) socket.destroy();
        // Waiting only for the natural server.close() callback lets half-frame or gone clients
        // pend stop/restart/uninstall forever. After destroying live connections keep a bounded
        // fallback so the endpoint and the data-root lock above always settle.
        await Promise.race([
          serverClosed,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, CONTROL_CLOSE_TIMEOUT_MS);
            timer.unref();
          }),
        ]);
        await rm(endpoint, { force: true }).catch(() => undefined);
      })();
      return await closePromise;
    },
  };
}

function handleSocket(socket: Socket, handler: ControlHandler): void {
  const decoder = new JsonLineDecoder();
  // Client timeouts destroy the socket, so a late response write can raise EPIPE/ECONNRESET
  // asynchronously. An unconsumed socket error escalates to an unhandled event and kills the
  // Supervisor; a control client hangup is a normal best-effort write failure and must not
  // affect the Supervisor lifecycle.
  socket.on("error", () => {
    socket.destroy();
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      writeResponse(socket, {
        id: randomUUID(),
        ok: false,
        error: errorResponse("invalid-frame", error),
      });
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      void dispatch(socket, frame, handler);
    }
  });
  socket.on("end", () => {
    try {
      decoder.finish();
    } catch {
      socket.destroy();
    }
  });
}

async function dispatch(socket: Socket, raw: unknown, handler: ControlHandler): Promise<void> {
  const parsed = controlRequestSchema.safeParse(raw);
  if (!parsed.success) {
    writeResponse(socket, {
      id: randomUUID(),
      ok: false,
      error: { code: "invalid-request", message: "Invalid control request" },
    });
    return;
  }
  try {
    const result = await handler(parsed.data);
    writeResponse(socket, { id: parsed.data.id, ok: true, result });
  } catch (error: unknown) {
    writeResponse(socket, {
      id: parsed.data.id,
      ok: false,
      error: errorResponse("request-failed", error),
    });
  }
}

function writeResponse(socket: Socket, response: ControlResponse): void {
  const parsed = controlResponseSchema.parse(response);
  if (socket.destroyed || socket.writableEnded) return;
  try {
    socket.write(encodeJsonLine(parsed), (error) => {
      if (error) socket.destroy();
    });
  } catch {
    socket.destroy();
  }
}

function errorResponse(
  code: string,
  error: unknown,
): { code: string; message: string; retryable?: boolean } {
  if (error instanceof ControlRequestError) {
    return { code: error.code, message: error.message.slice(0, 500), retryable: error.retryable };
  }
  return {
    code,
    message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  };
}
