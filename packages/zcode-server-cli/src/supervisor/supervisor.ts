/* oxlint-disable eslint(max-lines) -- the Supervisor owns lifecycle, Core generations and update-rollback state in one place; the startup-recovery lock fix must not split its atomic flow. */

import { type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServiceLogger } from "@zcode/services/node";
import {
  coreMessageSchema,
  SERVER_CLI_PROTOCOL_VERSION,
  type ControlRequest,
  type LifecycleState,
  type ReleaseManifest,
  type ServerStatus,
} from "../contracts.js";
import { createControlServer, type ControlHandler } from "../ipc/controlServer.js";
import { ControlRequestError } from "../ipc/controlError.js";
import { DataRootLock } from "../runtime/lock.js";
import { resolveServerLayout, type ServerLayout } from "../runtime/paths.js";
import { ReleaseManager } from "../runtime/releaseManager.js";
import { createStatusPersister } from "../runtime/statusSnapshot.js";
import { recoverSupervisorStartup } from "../runtime/startupRecovery.js";
import { waitForUpdateReady } from "../runtime/updateReadiness.js";
import { createRollbackFailure, updateErrorMessage } from "../runtime/updateErrors.js";
import { CrashBudget } from "./crashBudget.js";

// Lifecycle events use info/warn/error per ops-triage criteria (ops must see them in logs when things break);
// high-frequency heartbeat/task-activity detail goes to debug to keep production logs lean.
const log = createServiceLogger("server-supervisor");

export interface CoreLauncher {
  launch(generation: number, release?: ReleaseManifest | null): ChildProcess;
}

export interface SupervisorOptions {
  layout?: ServerLayout;
  launcher: CoreLauncher;
  version: string;
  serviceRegistered?: boolean;
  /** Tests and diagnostics may shorten the ready wait; production keeps the 15s default. */
  coreReadyTimeoutMs?: number;
  /** Tests may shorten the graceful-exit and post-kill finality waits; production defaults are 5s and 2s. */
  coreStopGraceTimeoutMs?: number;
  coreKillTimeoutMs?: number;
  now?: () => number;
  onStopped?: () => void;
}

type LifecycleOperationKind = "stop" | "restart" | "update" | "uninstall";

export class Supervisor {
  private readonly layout: ServerLayout;
  private readonly lock: DataRootLock;
  private readonly crashBudget: CrashBudget;
  private readonly releaseManager: ReleaseManager;
  private core: ChildProcess | undefined;
  private control: Awaited<ReturnType<typeof createControlServer>> | undefined;
  private state: LifecycleState = "stopped";
  private generation = 0;
  private host: string | null = null;
  private port: number | null = null;
  private startedAt: number | null = null;
  private runningTaskCount = 0;
  private lastExitReason: string | null = null;
  private readonly persistStatusSnapshot: () => Promise<void>;
  private lifecycleOperation:
    | { kind: LifecycleOperationKind; promise: Promise<unknown> }
    | undefined;
  private activeRelease: ReleaseManifest | null = null;

  public constructor(private readonly options: SupervisorOptions) {
    this.layout = options.layout ?? resolveServerLayout();
    this.lock = new DataRootLock(this.layout.lockFile);
    this.crashBudget = new CrashBudget({ now: options.now });
    this.releaseManager = new ReleaseManager(this.layout);
    this.persistStatusSnapshot = createStatusPersister(
      this.layout.statusFile,
      () => this.status(),
      (error) => log.warn("failed to persist status snapshot", error),
    );
  }

  public async start(): Promise<ServerStatus> {
    if (this.state === "ready" || this.state === "starting") return this.status();
    await this.releaseManager.ensure();
    await this.lock.acquire();
    try {
      // Startup recovery rewrites current.json and deletes update-transaction.json, so the data-root
      // single-instance lock must be taken first; otherwise a live Supervisor's apply-update races the second starter and
      // leaves memory on the new release while the on-disk current pointer rolls back to the old one.
      await recoverSupervisorStartup(
        this.releaseManager,
        this.layout.uninstalledFile,
        this.layout.serverRoot,
        async (error) => {
          this.state = "stop-failed";
          this.lastExitReason = `update rollback recovery failed: ${updateErrorMessage(error)}`;
          await this.persistStatusSnapshot();
        },
      );
      // Recovery may already have restored the current pointer; read it after recovery to avoid booting a rolled-back candidate.
      this.activeRelease = await this.releaseManager.readCurrentForExecution();
      await mkdir(this.layout.runDir, { recursive: true, mode: 0o700 });
      const handler: ControlHandler = (request) => this.handleControl(request);
      this.control = await createControlServer(this.layout.controlEndpoint, handler);
      this.state = "starting";
      log.info("supervisor started", {
        serverRoot: this.layout.serverRoot,
        version: this.options.version,
      });
      this.launchCore();
      await this.persistStatusSnapshot();
      return this.status();
    } catch (error) {
      // Releasing the lock only on recovery failure is not enough: a failed mkdir, control server, Core start or
      // initial state persist leaves the lock (and maybe a started Core) behind, and a Supervisor retry would
      // misread itself as another instance. The startup critical section releases the lock only once Core and control are both settled.
      const recoveryFailed = this.state === "stop-failed";
      let coreStopped = this.core === undefined;
      if (this.core) {
        try {
          await this.stopCore("startup-failed");
          coreStopped = true;
        } catch (stopError) {
          log.error("failed to stop Core after supervisor startup failure", stopError);
        }
      }

      let controlClosed = this.control === undefined;
      if (this.control) {
        try {
          await this.control.close();
          this.control = undefined;
          controlClosed = true;
        } catch (closeError) {
          log.error("failed to close control server after supervisor startup failure", closeError);
        }
      }

      if (coreStopped && controlClosed) {
        // The failed recovery already wrote stop-failed; even with no Core/control to settle, keep that
        // state so status keeps exposing the transaction for manual action, and release the lock to let this instance retry later.
        this.state = recoveryFailed ? "stop-failed" : "stopped";
        await this.persistStatusSnapshot().catch((snapshotError) => {
          log.warn(
            "failed to persist stopped state after supervisor startup failure",
            snapshotError,
          );
        });
        await this.lock.release();
      } else {
        this.state = "stop-failed";
        await this.persistStatusSnapshot().catch((snapshotError) => {
          log.warn(
            "failed to persist stop-failed state after supervisor startup failure",
            snapshotError,
          );
        });
      }
      throw error;
    }
  }

  public async stop(reason = "requested"): Promise<ServerStatus> {
    return await this.runLifecycleOperation("stop", () => this.stopInternal(reason));
  }

  private async stopInternal(reason: string): Promise<ServerStatus> {
    if (!this.core) {
      this.state = "stopped";
      await this.persistStatusSnapshot();
      await this.control?.close();
      this.control = undefined;
      await this.lock.release();
      if (reason !== "restart") this.options.onStopped?.();
      return this.status();
    }
    await this.stopCore(reason);
    this.state = "stopped";
    await this.persistStatusSnapshot();
    await this.control?.close();
    this.control = undefined;
    await this.lock.release();
    log.info("supervisor stopped", { reason });
    if (reason !== "restart") this.options.onStopped?.();
    return this.status();
  }

  public async restart(): Promise<ServerStatus> {
    return await this.runLifecycleOperation("restart", async () => {
      await this.stopInternal("restart");
      return await this.start();
    });
  }

  private async stopCore(reason: string): Promise<void> {
    if (!this.core) return;
    this.state = "stopping";
    this.lastExitReason = reason;
    log.info("stopping server core", { reason, pid: this.core.pid });
    const core = this.core;
    try {
      await new Promise<void>((resolve, reject) => {
        // After SIGKILL we must not return unconditionally within two seconds: without observing the child's final state
        // the data-root lock gets released and a second Core could start. Only exit/close prove the
        // process settled; keep the Core reference and lock and fail if no finality follows the kill.
        let killTimer: NodeJS.Timeout | undefined;
        let settled = false;
        const cleanup = (): void => {
          clearTimeout(graceTimer);
          if (killTimer) clearTimeout(killTimer);
          core.off("exit", finish);
          core.off("close", finish);
          core.off("error", handleError);
        };
        const finish = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const fail = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new Error(`Server Core pid ${core.pid ?? "unknown"} did not terminate after SIGKILL`),
          );
        };
        const handleError = (error: Error): void => {
          log.warn("server core emitted an error while stopping; awaiting exit or close", error);
        };
        const forceKill = (): void => {
          log.warn("server core did not exit within grace period, sending SIGKILL", {
            pid: core.pid,
          });
          core.kill("SIGKILL");
          if (!settled) killTimer = setTimeout(fail, this.options.coreKillTimeoutMs ?? 2_000);
        };
        const graceTimer = setTimeout(() => {
          forceKill();
        }, this.options.coreStopGraceTimeoutMs ?? 5_000);
        core.once("exit", finish);
        core.once("close", finish);
        core.once("error", handleError);
        try {
          core.send({ command: "shutdown" });
        } catch {
          // A closed IPC does not mean the OS process exited; still await exit/close finality after the hard kill.
          clearTimeout(graceTimer);
          forceKill();
        }
      });
    } catch (error) {
      if (this.core === core) {
        this.state = "stop-failed";
        this.lastExitReason = error instanceof Error ? error.message : String(error);
        await this.persistStatusSnapshot();
      }
      throw error;
    }
    if (this.core === core) {
      this.core = undefined;
      this.clearCoreScopedStatus();
    }
  }

  private async applyUpdate(force: boolean): Promise<unknown> {
    const pending = await this.releaseManager.readPending();
    if (!pending) throw new Error("No pending release is prepared");
    if (this.runningTaskCount > 0 && !force) {
      throw new Error("Running tasks require --force for update");
    }
    const previous = await this.releaseManager.readCurrent();
    log.info("applying pending release", { version: pending.version, force });
    await this.stopCore("update");
    this.state = "updating";
    await this.persistStatusSnapshot();
    try {
      await this.releaseManager.applyPendingWithTransaction(previous);
      this.activeRelease = pending;
      this.state = "starting";
      this.launchCore();
      await waitForUpdateReady(() => this.state, this.options.coreReadyTimeoutMs ?? 15_000);
      await this.releaseManager.completeUpdate();
      log.info("release applied", { version: pending.version });
      return { applied: true, version: pending.version };
    } catch (error) {
      this.enterUpdateRollback();
      // If the updated Core never turns ready, stop any live child before restoring the current pointer.
      // Otherwise the timeout path overwrites this.core and orphans the new Core alongside the rolled-back old one.
      if (this.core) {
        try {
          await this.stopCore("update-rollback");
        } catch (stopError) {
          log.error("failed to stop unhealthy release during rollback", stopError);
          await this.persistStatusSnapshot();
          throw stopError;
        }
      }
      // Restore the current pointer so the next start stops using the broken release.
      log.error("release apply failed, restoring previous current pointer", error);
      try {
        await this.releaseManager.restoreCurrent(previous);
        await this.releaseManager.completeUpdate();
      } catch (rollbackError: unknown) {
        this.state = "stop-failed";
        this.lastExitReason = `rollback pointer restore failed: ${updateErrorMessage(rollbackError)}`;
        await this.persistStatusSnapshot();
        throw createRollbackFailure(error, rollbackError);
      }
      this.activeRelease = previous;
      // Rollback restores the pointer and must also immediately start the old release; otherwise the daemon sits in
      // stopped limbo and the user must restart by hand to restore service.
      this.state = "stopped";
      if (previous) {
        this.state = "starting";
        this.launchCore();
        try {
          await waitForUpdateReady(() => this.state, this.options.coreReadyTimeoutMs ?? 15_000);
        } catch (rollbackError) {
          log.error("previous release rollback failed", rollbackError);
          // On old-release ready timeout, only flipping state would strand a live Core, PID and lock behind stopped; reuse stopCore to await exit/close and stay stop-failed on error.
          if (this.core) await this.stopCore("update-rollback");
          this.state = "stopped";
        }
      }
      await this.persistStatusSnapshot();
      throw error;
    }
  }

  public status(): ServerStatus {
    return {
      protocolVersion: SERVER_CLI_PROTOCOL_VERSION,
      state: this.state,
      pid: this.core?.pid ?? null,
      port: this.port,
      host: this.host,
      version: this.options.version,
      generation: this.generation,
      startedAt: this.startedAt,
      lastExitReason: this.lastExitReason,
      serviceRegistered: this.options.serviceRegistered ?? false,
      runningTaskCount: this.runningTaskCount,
      crashBudget: this.crashBudget.snapshot(),
      updatedAt: Date.now(),
    };
  }

  private launchCore(): void {
    const generation = ++this.generation;
    const child = this.options.launcher.launch(generation, this.activeRelease);
    this.core = child;
    this.clearCoreScopedStatus();
    log.info("launching server core", { generation, pid: child.pid });
    child.on("message", (raw: unknown) => this.handleCoreMessage(child, generation, raw));
    let terminalObserved = false;
    let spawnErrorReason: string | undefined;
    const handleTerminal = (reason: string): void => {
      if (terminalObserved) return;
      terminalObserved = true;
      if (this.core !== child || this.state === "stopping" || this.state === "stopped") return;
      if (this.state === "stop-failed") {
        // Keep the lock after a failed stop; late finality only clears the dead child and must not burn crash budget
        // or start a replacement Core. The control socket and data-root lock release once the user retries stop.
        this.core = undefined;
        this.clearCoreScopedStatus();
        this.lastExitReason = reason;
        void this.persistStatusSnapshot();
        return;
      }
      this.core = undefined;
      this.clearCoreScopedStatus();
      this.state = "crashed";
      this.lastExitReason = reason;
      const decision = this.crashBudget.recordCrash();
      if (!decision.shouldRestart) {
        this.state = "crash-loop-stopped";
        log.error("server core crash budget exhausted, entering crash-loop-stopped", {
          lastExitReason: this.lastExitReason,
        });
        void this.persistStatusSnapshot();
        return;
      }
      log.warn("server core crashed, scheduling restart", {
        lastExitReason: this.lastExitReason,
        delayMs: decision.delayMs,
      });
      void this.persistStatusSnapshot();
      setTimeout(() => {
        if (this.state !== "crashed") return;
        this.state = "starting";
        this.launchCore();
      }, decision.delayMs).unref();
    };
    // When the fork execPath is missing or not executable, Node emits only error + close, never exit.
    // error and exit must share one-shot finality; otherwise an unhandled error kills the Supervisor and lets the update's
    // freshly written current pointer bypass catch/rollback.
    child.once("error", (error: Error & { code?: string }) => {
      spawnErrorReason = `core spawn error code=${error.code ?? "unknown"}: ${error.message}`;
      this.lastExitReason = spawnErrorReason;
      log.error("server core process error", error);
      void this.persistStatusSnapshot();
    });
    child.once("exit", (code, signal) => {
      handleTerminal(
        spawnErrorReason ?? `core exited code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
    child.once("close", (code, signal) => {
      handleTerminal(
        spawnErrorReason ?? `core closed code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
  }

  private handleCoreMessage(child: ChildProcess, expectedGeneration: number, raw: unknown): void {
    // The old child's message listener survives across generations; a late heartbeat/ready
    // could clobber the current Core's state. Messages must also match the current child; ready must match the start generation.
    if (this.core !== child) return;
    const parsed = coreMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.type === "ready") {
      // ready only counts for the Core currently starting; late messages during stopping/stopped/stop-failed
      // must not resurrect a Supervisor that already settled or entered an unclear final state.
      if (message.generation !== expectedGeneration || this.state !== "starting") return;
      this.state = "ready";
      this.host = message.host;
      this.port = message.port;
      this.generation = message.generation;
      this.startedAt = Date.now();
      log.info("server core ready", {
        host: this.host,
        port: this.port,
        generation: this.generation,
      });
    } else if (message.type === "heartbeat" || message.type === "task-activity") {
      this.runningTaskCount = message.runningTaskCount;
      log.debug("core activity snapshot", {
        type: message.type,
        runningTaskCount: message.runningTaskCount,
      });
    } else if (message.type === "fatal") {
      this.lastExitReason = message.message;
      log.error("server core reported fatal error", { message: message.message });
    } else if (message.type === "exit") {
      this.lastExitReason = message.reason;
      log.info("server core reported exit", { reason: message.reason });
    }
    void this.persistStatusSnapshot();
  }

  private enterUpdateRollback(): void {
    // After a candidate Core crashes, handleTerminal marks crashed and schedules the automatic restart;
    // leave crashed first during rollback file work, or the timer restarts the Core with the broken activeRelease.
    if (this.state === "crashed") this.state = "updating";
  }

  private clearCoreScopedStatus(): void {
    this.host = null;
    this.port = null;
    this.startedAt = null;
    this.runningTaskCount = 0;
  }

  private async handleControl(request: ControlRequest): Promise<unknown> {
    switch (request.command) {
      case "ping":
        return { protocolVersion: SERVER_CLI_PROTOCOL_VERSION };
      case "status":
        return this.status();
      case "stop":
        this.startAcknowledgedLifecycleOperation("stop", () =>
          this.stopInternal("control request"),
        );
        return { stopping: true };
      case "restart":
        this.startAcknowledgedLifecycleOperation("restart", async () => {
          await this.stopInternal("restart");
          await this.start();
        });
        return { restarting: true };
      case "prepare-update":
        return {
          status: this.runningTaskCount ? "blocked" : "ready",
          runningTaskCount: this.runningTaskCount,
        };
      case "apply-update":
        return await this.runLifecycleOperation("update", () =>
          this.applyUpdate(request.force === true),
        );
      case "prepare-uninstall":
        return {
          status: this.runningTaskCount ? "blocked" : "ready",
          runningTaskCount: this.runningTaskCount,
        };
      case "confirm-uninstall":
        if (request.confirmation !== "DELETE")
          throw new Error("Uninstall confirmation must be DELETE");
        // Bug fix: the spec requires a running-task check before uninstall (R2-CLI-10). The old code had
        // prepare-uninstall return blocked with no consumer, and confirm-uninstall
        // just stopped the Core and deleted data, silently interrupting running tasks. Enforce the guard at the last line of defense:
        // return a structured error and keep the current state while tasks run.
        if (this.runningTaskCount > 0) {
          throw new Error(
            `Cannot uninstall while ${this.runningTaskCount} task(s) are running; stop the server first`,
          );
        }
        log.info("uninstall confirmed, stopping server");
        this.startAcknowledgedLifecycleOperation("uninstall", () => this.stopInternal("uninstall"));
        return { uninstalled: true };
    }
  }

  private runLifecycleOperation<T>(
    kind: LifecycleOperationKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertLifecycleOperationCanStart(kind);
    const active = this.lifecycleOperation;
    if (active) {
      return active.promise as Promise<T>;
    }
    const promise = Promise.resolve().then(operation);
    this.lifecycleOperation = { kind, promise };
    void promise.then(
      () => {
        if (this.lifecycleOperation?.promise === promise) this.lifecycleOperation = undefined;
      },
      () => {
        if (this.lifecycleOperation?.promise === promise) this.lifecycleOperation = undefined;
      },
    );
    return promise;
  }

  private startAcknowledgedLifecycleOperation(
    kind: LifecycleOperationKind,
    operation: () => Promise<unknown>,
  ): void {
    // Even ack-style requests must check the gate before replying; a later background rejection would make the client believe
    // restart/uninstall was accepted when only a Supervisor-log conflict remains.
    this.assertLifecycleOperationCanStart(kind);
    const started = this.runLifecycleOperation(kind, async () => {
      // The control response must go back on the original socket first; closing the control server deadlocks against dispatch.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await operation();
    });
    void started.catch((error: unknown) => {
      log.error(`lifecycle operation ${kind} failed`, error);
    });
  }

  private assertLifecycleOperationCanStart(kind: LifecycleOperationKind): void {
    const active = this.lifecycleOperation;
    if (!active || (kind === "stop" && active.kind === "stop")) return;
    throw new ControlRequestError(
      "operation-in-progress",
      `Lifecycle operation ${active.kind} is already in progress`,
      true,
    );
  }
}
