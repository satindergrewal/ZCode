import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import type { ChildProcess } from "node:child_process";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import {
  attachProcessToWindowsJobObject,
  type WindowsJobObjectController,
} from "./windows-job-object.js";

type SdkStdioDispose = (this: StdioClientTransport) => Promise<void>;

const sdkDispose = Object.getOwnPropertyDescriptor(StdioClientTransport.prototype, "_dispose")
  ?.value as SdkStdioDispose | undefined;

export type StdioRequestMetaProvider = () => Promise<Record<string, unknown> | undefined>;

export interface StdioProcessExitInfo {
  exitCode: number | null;
  exitedAt: number;
  signal: NodeJS.Signals | null;
  startedAt: number;
}

type ProcessTreeStdioServerParameters = StdioServerParameters & {
  /**
   * Per-message identity payload provider for official stdio MCP. Kept as a non-executable spawn field so that when the SDK
   * clones a sibling transport for the modern probe, server/discover and the real session share one injection boundary.
   */
  requestMetaProvider?: StdioRequestMetaProvider;
};

export interface ProcessTreeStdioClientTransportOptions {
  windowsJobObjectFactory?: (pid: number) => Promise<WindowsJobObjectController | undefined>;
}

/**
 * SDK 2.0 spawns a one-shot sibling for the stdio version probe, but its private dispose hook kills only the direct child;
 * launcher/watchdog grandchildren would orphan. Reap the whole tree in the same hook before
 * the SDK cleans pipes and read buffers. The prototype must own _dispose directly for the SDK to treat it
 * as a safely cloneable probe transport.
 */
export class ProcessTreeStdioClientTransport extends StdioClientTransport {
  private childProcess?: ChildProcess;
  private lastProcessExit?: StdioProcessExitInfo;
  private readonly requestMetaProvider?: StdioRequestMetaProvider;
  private readonly windowsJobObjectFactory: (
    pid: number,
  ) => Promise<WindowsJobObjectController | undefined>;
  private windowsJobObject?: WindowsJobObjectController;

  constructor(
    server: ProcessTreeStdioServerParameters,
    options: ProcessTreeStdioClientTransportOptions = {},
  ) {
    super(server);
    this.requestMetaProvider = server.requestMetaProvider;
    this.windowsJobObjectFactory =
      options.windowsJobObjectFactory ?? attachProcessToWindowsJobObject;
  }

  async terminateWindowsJobObject(): Promise<void> {
    const windowsJobObject = this.windowsJobObject;
    this.windowsJobObject = undefined;
    if (!windowsJobObject) return;
    try {
      windowsJobObject.terminate();
    } catch {
      // Fall through to close and the taskkill fallback.
    } finally {
      try {
        windowsJobObject.close();
      } catch {
        // Handle-close failure never blocks the SDK pipe cleanup.
      }
    }
  }

  override async send(message: JSONRPCMessage): Promise<void> {
    const requestMeta = await this.requestMetaProvider?.();
    await super.send(mergeRequestMeta(message, requestMeta));
  }

  override async start(): Promise<void> {
    const startedAt = Date.now();
    await super.start();
    const child = (this as unknown as { _process?: ChildProcess })._process;
    if (!child) return;
    this.childProcess = child;
    const recordExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      this.lastProcessExit ??= {
        exitCode,
        exitedAt: Date.now(),
        signal,
        startedAt,
      };
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      recordExit(child.exitCode, child.signalCode);
      return;
    }
    child.once("exit", recordExit);

    // Staging once merged Job Object custody and exit observation into two same-named start()s, breaking the CLI
    // build with Duplicate function implementation; both duties merge here, keeping Windows
    // tree custody and cross-platform exit records.
    if (process.platform !== "win32" || this.pid == null) return;
    try {
      this.windowsJobObject = await this.windowsJobObjectFactory(this.pid);
    } catch {
      // Keep the taskkill fallback when native custody is unavailable; an optional capability must not fail connect.
      this.windowsJobObject = undefined;
    }
  }

  get processExit(): StdioProcessExitInfo | undefined {
    return this.lastProcessExit;
  }

  get processAlive(): boolean {
    return Boolean(
      this.childProcess &&
      this.childProcess.exitCode === null &&
      this.childProcess.signalCode === null,
    );
  }
}

function mergeRequestMeta(
  message: JSONRPCMessage,
  requestMeta: Record<string, unknown> | undefined,
): JSONRPCMessage {
  // JSON-RPC responses have no method; never fabricate params onto responses. Touch only client requests and notifications.
  if (!("method" in message) || !requestMeta || Object.keys(requestMeta).length === 0) {
    return message;
  }
  const params = isRecord(message.params) ? message.params : {};
  const existingMeta = isRecord(params._meta) ? params._meta : {};
  return {
    ...message,
    params: {
      ...params,
      // Freshly parsed official identity must override caller residue so stale credentials cannot linger.
      _meta: { ...existingMeta, ...requestMeta },
    },
  } as JSONRPCMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

Object.defineProperty(ProcessTreeStdioClientTransport.prototype, "_dispose", {
  configurable: true,
  async value(this: ProcessTreeStdioClientTransport): Promise<void> {
    const pid = this.pid;
    await this.terminateWindowsJobObject();
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
      try {
        await terminateMcpStdioProcessTree(pid);
      } catch {
        // The SDK probe dispose is best effort; pipes must still be released or negotiation hangs forever.
      }
    }

    if (sdkDispose) {
      await sdkDispose.call(this);
      return;
    }
    await this.close();
  },
});
