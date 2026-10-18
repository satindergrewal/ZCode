import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Emitter } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { zcodeProtocolMessageSchema } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  ZCodeProtocolTransport,
  ZCodeProtocolTransportClosedEvent,
} from "./zcodeProtocolTransport.js";
import {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  terminateProcessTree,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";
import type { ProcessTreeSnapshot } from "#src/process/processTreeTerminator.js";
import { AgentStderrCollector, EXIT_STDERR_DRAIN_MS } from "./agentStderrCollector.js";

interface ZCodeStdioTransportOptions {
  onStderrLine?: (line: string) => void;
  ownedProcessGroupId?: number;
  ownedProcessStartedAtMs?: number;
}

const STDIO_EOF_EXIT_WAIT_MS = 1_800;
const DISPOSE_STDERR_DRAIN_MS = 3_250;
const E2E_COVERAGE_STDIO_EOF_EXIT_WAIT_MS = 5_000;
const PROCESS_TREE_FORCE_AFTER_MS = 2_000;
const PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS = 1_000;
const PROCESS_TREE_WINDOWS_EXIT_OBSERVATION_GRACE_MS = 250;
const processTreeLogger = createServiceLogger("zcode-agent-process-tree");

export class ZCodeStdioTransport implements ZCodeProtocolTransport {
  readonly kind = "stdio" as const;

  private readonly messageEmitter = new Emitter<ZCodeProtocolMessage>();
  private readonly closeEmitter = new Emitter<ZCodeProtocolTransportClosedEvent>();
  private readonly stderrCollector: AgentStderrCollector;
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private stdoutFlushed = false;
  private readersDisposed = false;
  private disposed = false;
  private closed = false;
  private disposeAndWaitPromise: Promise<void> | undefined;
  private cleanupProcessTreeSnapshot: ProcessTreeSnapshot | undefined;
  private cleanupAttemptCount = 0;
  private childExitedAtMs: number | undefined;

  readonly onMessage = this.messageEmitter.event;
  readonly onClose = this.closeEmitter.event;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options?: ZCodeStdioTransportOptions,
  ) {
    this.stderrCollector = new AgentStderrCollector(child.stderr, options?.onStderrLine);

    // ZCode Protocol stdio frames split on LF only. Node readline treats U+2028/U+2029
    // as line breaks and would halve valid JSON strings containing them.
    child.stdout.on("data", this.handleStdoutData);
    child.stdout.once("end", this.handleStdoutEnd);
    child.stdout.once("close", this.handleStdoutEnd);
    child.stdin.on("error", (error) => this.handleStreamError("stdin", error));
    child.stdout.on("error", (error) => this.handleStreamError("stdout", error));
    child.once("exit", (code, signal) => {
      this.childExitedAtMs = Date.now();
      this.fireClose({ code, signal });
      this.disposeReaders();
      void this.waitForStderrDrain();
    });
    child.once("error", (error) => {
      this.fireClose({ reason: error.message });
      this.disposeReaders();
      void this.waitForStderrDrain();
    });
  }

  async send(message: ZCodeProtocolMessage): Promise<void> {
    if (this.disposed || this.closed || this.child.killed || !this.child.stdin.writable) {
      throw new Error("ZCode agent stdio transport is closed");
    }
    const frame = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeLocalResources();
    void this.stderrCollector.waitForDrain(DISPOSE_STDERR_DRAIN_MS);
    if (!this.hasChildExited()) {
      // Agent wrappers may keep runtime/MCP children alive on Windows and POSIX;
      // killing only the parent orphan descendants or pins the workspace cwd briefly.
      const ownedProcessGroupId = this.options?.ownedProcessGroupId;
      terminateProcessTree(this.child, ownedProcessGroupId ? { ownedProcessGroupId } : {});
    }
  }

  disposeAndWait(): Promise<void> {
    if (!this.disposeAndWaitPromise) {
      const inFlight = this.disposeAndWaitOnce().finally(() => {
        if (this.disposeAndWaitPromise === inFlight) {
          this.disposeAndWaitPromise = undefined;
        }
      });
      this.disposeAndWaitPromise = inFlight;
    }
    return this.disposeAndWaitPromise;
  }

  waitForStderrDrain(): Promise<void> {
    return this.stderrCollector.waitForDrain();
  }

  private async disposeAndWaitOnce(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.disposeLocalResources();
    }
    // stdin EOF can let the CLI root exit while detached MCP keeps running.
    // Snapshot tree members before EOF: once the root is gone and the system adopts
    // children, they are unreachable by PPID.
    const cleanupStartedAtMs = Date.now();
    const forceBudgetMs = this.cleanupAttemptCount > 1 ? 0 : PROCESS_TREE_FORCE_AFTER_MS;
    // Decrementing forceAfterMs cannot bound slow CIM; at zero the waiter regains
    // taskkill+exit grace. Windows needs one absolute deadline from cleanup start,
    // threaded through snapshot/EOF/waiter, to stay inside the host 3.5s service phase.
    const windowsCleanupDeadlineAtMs =
      process.platform === "win32"
        ? cleanupStartedAtMs +
          forceBudgetMs +
          PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS +
          PROCESS_TREE_WINDOWS_EXIT_OBSERVATION_GRACE_MS
        : undefined;
    this.cleanupProcessTreeSnapshot ??= await this.captureCleanupSnapshot(
      windowsCleanupDeadlineAtMs,
    );
    const processTreeSnapshot = this.cleanupProcessTreeSnapshot;
    if (!this.hasChildExited()) {
      // app-server --stdio exits normally on stdin EOF. Hard-killing the tree skips
      // agent shutdown and pins the host to the force-kill window.
      // Let the protocol entry wind down first; fall back to tree kill on silence, still child-safe.
      this.requestStdioClose();
      // The coverage CLI bundle is uncompressed with full source maps and starts/stops slowly;
      // keep extra flush grace under coverage. The normal window covers the 1500ms exit deadline.
      const configuredEofWaitMs =
        process.env.ZCODE_E2E_COVERAGE === "1"
          ? E2E_COVERAGE_STDIO_EOF_EXIT_WAIT_MS
          : STDIO_EOF_EXIT_WAIT_MS;
      const remainingCleanupMs =
        windowsCleanupDeadlineAtMs === undefined
          ? configuredEofWaitMs
          : Math.max(windowsCleanupDeadlineAtMs - Date.now(), 0);
      await this.waitForChildExit(Math.min(configuredEofWaitMs, remainingCleanupMs));
    }
    // App shutdown must wait out SIGTERM/SIGKILL fallback for the tree;
    // even if the root exited in the EOF window, reap descendants from the saved snapshot.
    const terminationResult = await terminateProcessTreeAndWait(this.child, {
      ...(this.options?.ownedProcessGroupId
        ? { ownedProcessGroupId: this.options.ownedProcessGroupId }
        : {}),
      ...(this.options?.ownedProcessStartedAtMs
        ? {
            ownedProcessStartedAtMs: this.options.ownedProcessStartedAtMs,
            ownedProcessExitedAtMs: this.childExitedAtMs ?? Date.now(),
          }
        : {}),
      ...(processTreeSnapshot ? { snapshot: processTreeSnapshot } : {}),
      log: processTreeLogger,
      // The absolute awaiting-cleanup deadline is force margin + taskkill cap + exit grace.
      // Cap the command at 1s so the whole cleanup stays in the host's 3.5s service phase.
      windowsTaskkillTimeoutMs: PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS,
      ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
      // After a cleanup reported leftovers, the final quit retry must not wait another
      // full graceful window; go straight to force to stay in the host exit budget.
      forceAfterMs: Math.max(forceBudgetMs - (Date.now() - cleanupStartedAtMs), 0),
    });
    // After Windows taskkill confirms OS exit, the Node ChildProcess exit event may land late;
    // the waiter already checks PID liveness and identity, so re-adding root PID from a stale
    // exitCode/signalCode misreports success as leftovers and triggers useless retries.
    const remainingPids = terminationResult.remainingPids;
    await this.stderrCollector.waitForDrain(
      windowsCleanupDeadlineAtMs === undefined
        ? undefined
        : Math.max(0, Math.min(EXIT_STDERR_DRAIN_MS, windowsCleanupDeadlineAtMs - Date.now())),
    );
    if (remainingPids.length > 0) {
      // Warning-only success would let the manager drop ownership immediately and
      // quit could not rehandle leftovers. Promote leftovers to failure, keep the snapshot.
      throw new Error(
        `runtime process tree cleanup incomplete; remaining pid=${[...new Set(remainingPids)].join(",")}`,
      );
    }
  }

  private readonly handleStdoutData = (chunk: Buffer | string): void => {
    if (this.closed) {
      return;
    }
    this.stdoutBuffer += typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk);
    this.drainStdoutFrames();
  };

  private readonly handleStdoutEnd = (): void => {
    if (this.stdoutFlushed) {
      return;
    }
    this.stdoutFlushed = true;
    this.stdoutBuffer += this.stdoutDecoder.end();
    const trailing = this.stdoutBuffer;
    this.stdoutBuffer = "";
    if (trailing.length > 0 && !this.closed) {
      this.handleStdoutFrame(trailing);
    }
    this.fireClose({ reason: "stdout_closed" });
  };

  private drainStdoutFrames(): void {
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const frame = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleStdoutFrame(frame);
      if (this.closed) {
        return;
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleStdoutFrame(frame: string): void {
    const line = frame.endsWith("\r") ? frame.slice(0, -1) : frame;
    if (line.trim().length === 0) {
      return;
    }
    try {
      const parsed = zcodeProtocolMessageSchema.parse(JSON.parse(line));
      // Protocol frame dispatch once queried the system process table synchronously, stalling
      // the host loop at telemetry/streaming peaks. Runtime data plane parses/forwards only;
      // full tree queries stay behind the dispose cleanup boundary.
      this.messageEmitter.fire(parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.fireClose({ reason: `protocol_parse_error: ${reason}` });
    }
  }

  private handleStreamError(stream: "stdin" | "stdout", error: Error): void {
    // After a remote WSL/SSH agent dies instantly the host may still be writing pending requests;
    // the stdin write callback rejects and the socket raises error. Without a long-lived listener
    // zcode-server crashes on unhandled EPIPE and the UI sees a lost link, not a failed request.
    // Treat stream error as transport-closed and stop writing to the dead agent.
    this.fireClose({ reason: `${stream}_error: ${error.message}` });
  }

  private fireClose(event: ZCodeProtocolTransportClosedEvent): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeEmitter.fire(event);
  }

  private disposeReaders(): void {
    if (this.readersDisposed) {
      return;
    }
    this.readersDisposed = true;
    this.child.stdout.off("data", this.handleStdoutData);
    this.child.stdout.off("end", this.handleStdoutEnd);
    this.child.stdout.off("close", this.handleStdoutEnd);
    this.child.stdout.resume();
  }

  private disposeLocalResources(): void {
    this.disposeReaders();
    this.messageEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private requestStdioClose(): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    try {
      this.child.stdin.once("error", () => undefined);
      this.child.stdin.end();
    } catch {
      // The agent may exit mid-disposeAndWait; the EOF request fails on a half-closed stdin.
      // failure must not break the tree-kill fallback, or shutdown leaks runtimes again.
    }
  }

  private waitForChildExit(timeoutMs: number): Promise<void> {
    if (this.hasChildExited()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.child.off?.("exit", settle);
        resolve();
      };
      this.child.once("exit", settle);
      timer = setTimeout(settle, timeoutMs);
      timer.unref?.();
    });
  }

  private hasChildExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private async captureCleanupSnapshot(
    windowsCleanupDeadlineAtMs?: number,
  ): Promise<ProcessTreeSnapshot | undefined> {
    const childHadExited = this.hasChildExited();
    const liveTree = childHadExited
      ? undefined
      : await captureProcessTreeSnapshotAsync(this.child, {
          log: processTreeLogger,
          ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
          ownedProcessStartedAtMs: this.options?.ownedProcessStartedAtMs,
          // The root may exit during WMIC/CIM. No exit time at query start:
          // read the exit record after the same-round query to restore descendants, PID-reuse safe.
          resolveOwnedProcessExitedAtMs: () => this.childExitedAtMs,
        });
    if (liveTree) {
      return liveTree;
    }
    if (process.platform === "win32" && !childHadExited && this.child.pid) {
      // On query failure do not serialize a second query; descendants of a root exiting mid-query
      // captureProcessTreeSnapshotAsync already restores from the same-round table;
      // keep identities-unverifiable explicitly, or empty identities read as fully exited.
      return {
        rootPid: this.child.pid,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      };
    }
    const processGroupId = this.options?.ownedProcessGroupId;
    if (processGroupId) {
      return captureProcessGroupSnapshot(processGroupId);
    }
    const exitedTree = await captureExitedRootDescendantsSnapshotAsync(this.child.pid ?? 0, {
      log: processTreeLogger,
      ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
      ownedProcessStartedAtMs: this.options?.ownedProcessStartedAtMs,
      ownedProcessExitedAtMs: this.childExitedAtMs ?? Date.now(),
    });
    if (exitedTree) {
      return exitedTree;
    }
    // After a failed async CIM query, do not re-query inside terminateAndWait: two timeouts
    // serialize and eat the Main exit budget. Unverified snapshots keep observing the original
    // ChildProcess and report leftovers on timeout, never signaling an unverified reused PID.
    return process.platform === "win32" && this.child.pid
      ? {
          rootPid: this.child.pid,
          descendantPids: [],
          identities: [],
          identityVerification: "unavailable",
        }
      : undefined;
  }
}
