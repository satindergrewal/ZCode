/* eslint-disable max-lines -- Windows two-phase transport lifecycle must remain one linearized state machine. */
import { randomBytes } from "node:crypto";

import type { HelperHealth } from "@zcode/zcode-cua/broker";
import type {
  CuaHelperHandle,
  CuaHelperTransportRestartResult,
  CuaProductHelperHost,
} from "@zcode/zcode-cua/broker/server";

import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  ADDON_ENV,
  WindowsCuaChildLifecycle,
  asError,
  defaultChildProcess,
  defaultHealthProbe,
  defaultSocketPathFactory,
  isExactHealthPid,
  parseReadyMessage,
  type Generation,
  type WindowsCuaChild,
  type WindowsCuaChildProcessAdapter,
  type WindowsCuaHelperHostOptions,
} from "#src/cua-permission-broker/windowsCuaHelperHostSupport.js";

export type {
  WindowsCuaChild,
  WindowsCuaChildProcessAdapter,
  WindowsCuaHelperHostOptions,
} from "#src/cua-permission-broker/windowsCuaHelperHostSupport.js";

/** Authority-minting fallback: config-provenance nonce, same basis as node.ts's lazy-branch spawn. */
const mintRandomAuthority = (): string => randomBytes(16).toString("hex");

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;

type CuaHelperTransportHandle = Pick<CuaHelperHandle, "socketPath" | "pluginAuthority">;

export type ManagedCuaProductHelperHost = CuaProductHelperHost & {
  stop(): Promise<void>;
  checkHealth(timeoutMs?: number): Promise<unknown>;
  waitForTransport?(timeoutMs?: number): Promise<CuaHelperTransportHandle>;
};

/**
 * The Host lifecycle tail is the only serialization boundary: any fresh fork must order after the
 * previous generation's observed child exit. kill is a request, never proof a process died.
 */
export class WindowsCuaHelperHost implements ManagedCuaProductHelperHost {
  private readonly childProcess: WindowsCuaChildProcessAdapter;
  private readonly mintSocketPath: () => string;
  private readonly healthProbe: (socketPath: string, timeoutMs: number) => Promise<HelperHealth>;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly logger: ServiceLogger;
  private readonly childLifecycle: WindowsCuaChildLifecycle;
  private readonly authority: string;
  private handle: CuaHelperHandle | null = null;
  // Once transport_ready resolves outward, Agents may already hold those credentials; later
  // recoverable starts must reuse them even if full health never finished. Explicit stop clears
  // the state so a disposed pipe never resurrects.
  private lastAgentVisibleTransport: Pick<CuaHelperHandle, "socketPath"> | null = null;
  private current: Generation | null = null;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private terminationBlocker: Error | null = null;
  private startInFlight: Promise<CuaHelperHandle> | null = null;
  private startInFlightEpoch: number | null = null;
  private restartInFlight: Promise<CuaHelperHandle> | null = null;
  private restartAfterStartInFlight: Promise<CuaHelperHandle> | null = null;
  private restartPreservingTransportInFlight: Promise<CuaHelperTransportRestartResult> | null =
    null;
  private transportReadyInFlight: Promise<CuaHelperTransportHandle> | null = null;
  private transportReadyResolve: ((handle: CuaHelperTransportHandle) => void) | null = null;
  private transportReadyReject: ((error: unknown) => void) | null = null;
  private nextGeneration = 0;
  // An external stop is the disposal boundary; queued legacy start/restarts must not fork after it.
  private externalStopEpoch = 0;

  constructor(private readonly options: WindowsCuaHelperHostOptions) {
    this.childProcess = options.childProcess ?? defaultChildProcess;
    this.mintSocketPath = options.mintSocketPath ?? defaultSocketPathFactory;
    this.healthProbe = options.healthProbe ?? defaultHealthProbe;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.logger = options.logger ?? createServiceLogger("windows-cua-helper-host");
    this.childLifecycle = new WindowsCuaChildLifecycle(this.logger);
    this.authority = (options.mintPluginAuthority ?? mintRandomAuthority)();
  }

  get running(): boolean {
    return this.handle !== null;
  }
  get socketPath(): string | null {
    return this.handle?.socketPath ?? null;
  }
  get pluginAuthority(): string | null {
    return this.handle ? this.authority : null;
  }

  waitForTransport(timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS): Promise<CuaHelperTransportHandle> {
    if (this.handle) {
      return Promise.resolve({
        socketPath: this.handle.socketPath,
        pluginAuthority: this.handle.pluginAuthority,
      });
    }
    const pending = this.transportReadyInFlight;
    if (!pending) return Promise.reject(new Error("Windows Computer Use Helper is not starting"));
    // Callers usually wrap their own bounded startup budget; this local timer protects the direct
    // caller so the transport promise cannot hang on a forever-silent Helper.
    return new Promise<CuaHelperTransportHandle>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Windows Computer Use Helper transport timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      pending.then(
        (handle) => {
          clearTimeout(timer);
          resolve(handle);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  start(): Promise<CuaHelperHandle> {
    const stopEpoch = this.externalStopEpoch;
    if (this.startInFlight && this.startInFlightEpoch === stopEpoch) return this.startInFlight;
    this.createTransportReadyPromise();
    const transportReady = this.transportReadyInFlight;
    // start() is both the cold-start entry and the on-demand recovery after an abnormal exit.
    // Prefer any already-exposed Agent-facing tuple; go fresh only when none was ever exposed (or
    // an explicit stop cleaned it).
    const preservedTransport = this.lastAgentVisibleTransport ?? undefined;
    const tracked = this.enqueue(() => this.startNow(stopEpoch, preservedTransport))
      .catch((error) => {
        // A stale start can fail after a newer generation in a stop race; settle it only while it still holds the same promise.
        if (this.transportReadyInFlight === transportReady) {
          this.rejectTransportReady(error);
        }
        throw error;
      })
      .finally(() => {
        if (this.startInFlight === tracked) {
          this.startInFlight = null;
          this.startInFlightEpoch = null;
        }
      });
    this.startInFlight = tracked;
    this.startInFlightEpoch = stopEpoch;
    // An external stop aborts the start synchronously before the caller awaits; keep the original promise semantics without creating an unhandled rejection.
    void tracked.catch(() => undefined);
    return tracked;
  }

  stop(): Promise<void> {
    const generation = this.current;
    const termination = this.invalidateForExternalStop(generation);
    return this.enqueue(async () => {
      try {
        await termination;
      } finally {
        if (generation && this.current?.id === generation.id) this.current = null;
      }
    });
  }

  restart(): Promise<CuaHelperHandle> {
    if (this.restartInFlight) return this.restartInFlight;
    const stopEpoch = this.externalStopEpoch;
    const tracked = this.enqueue(async () => {
      await this.stopNow("restart");
      return this.startNow(stopEpoch);
    }).finally(() => {
      if (this.restartInFlight === tracked) this.restartInFlight = null;
    });
    this.restartInFlight = tracked;
    return tracked;
  }

  restartAfterCurrentStart(): Promise<CuaHelperHandle> {
    if (this.restartAfterStartInFlight) return this.restartAfterStartInFlight;
    const stopEpoch = this.externalStopEpoch;
    const tracked = this.enqueue(async () => {
      await this.stopNow("permission-restart");
      return this.startNow(stopEpoch);
    }).finally(() => {
      if (this.restartAfterStartInFlight === tracked) this.restartAfterStartInFlight = null;
    });
    this.restartAfterStartInFlight = tracked;
    return tracked;
  }

  restartAfterCurrentStartPreservingTransport(
    options: { beforeFreshStart?: () => void } = {},
  ): Promise<CuaHelperTransportRestartResult> {
    if (this.restartPreservingTransportInFlight) return this.restartPreservingTransportInFlight;
    const stopEpoch = this.externalStopEpoch;
    const tracked = this.enqueue(async () => {
      // enqueue awaits the in-flight start; reading the handle here covers the grant-callback-before-first-ready race.
      const previous = this.handle ?? this.lastAgentVisibleTransport;
      await this.stopNow("preserving-transport-restart");
      if (stopEpoch !== this.externalStopEpoch)
        throw new Error("Windows Computer Use Helper startup stopped");
      if (previous) {
        // The Helper process is replaceable downstream; existing Agents bind the host-facing named
        // pipe. Reuse it on recovery so a Helper restart never strands Agents on the old pipe.
        return {
          handle: await this.startNow(stopEpoch, previous),
          reused: true,
        };
      }
      options.beforeFreshStart?.();
      this.lastAgentVisibleTransport = null;
      return { handle: await this.startNow(stopEpoch), reused: false };
    }).finally(() => {
      if (this.restartPreservingTransportInFlight === tracked)
        this.restartPreservingTransportInFlight = null;
    });
    this.restartPreservingTransportInFlight = tracked;
    return tracked;
  }

  async checkHealth(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<HelperHealth> {
    const handle = this.handle;
    if (!handle) throw new Error("Windows Computer Use Helper is not running");
    return this.healthProbe(handle.socketPath, timeoutMs);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.lifecycleTail.then(async () => {
      if (this.terminationBlocker) throw this.terminationBlocker;
      return operation();
    });
    this.lifecycleTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private startNow(
    stopEpoch: number,
    preservedTransport?: Pick<CuaHelperHandle, "socketPath">,
  ): Promise<CuaHelperHandle> {
    if (stopEpoch !== this.externalStopEpoch)
      return Promise.reject(new Error("Windows Computer Use Helper startup stopped"));
    if (this.handle) return Promise.resolve(this.handle);
    if (this.terminationBlocker) return Promise.reject(this.terminationBlocker);
    return this.startGeneration(stopEpoch, preservedTransport);
  }

  private createTransportReadyPromise(): void {
    if (this.transportReadyInFlight) return;
    this.transportReadyInFlight = new Promise<CuaHelperTransportHandle>((resolve, reject) => {
      this.transportReadyResolve = resolve;
      this.transportReadyReject = reject;
    });
    // start() owns final failure settlement; callers awaiting transport directly must not leave unhandled rejections either.
    void this.transportReadyInFlight.catch(() => undefined);
  }

  private resolveTransportReady(handle: CuaHelperTransportHandle): void {
    // transport_ready may already be consumed by a spawn env; from here the tuple is the
    // Agent-facing identity and a later full-health failure or child crash must not swap in a new
    // pipe on the next start.
    this.lastAgentVisibleTransport = {
      socketPath: handle.socketPath,
    };
    this.transportReadyResolve?.(handle);
    this.transportReadyResolve = null;
    this.transportReadyReject = null;
  }

  private rejectTransportReady(error: unknown): void {
    this.transportReadyReject?.(error);
    this.invalidateTransportReady();
  }

  private invalidateTransportReady(): void {
    // transport_ready is a generation-level promise; after the Helper exits the resolved promise
    // cannot reject, but it must be detached from the Host so the next start never reuses a dead
    // generation's tuple.
    this.transportReadyResolve = null;
    this.transportReadyReject = null;
    this.transportReadyInFlight = null;
  }

  private async stopNow(context: string): Promise<void> {
    const generation = this.current;
    if (!generation) return;
    this.handle = null;
    if (context !== "preserving-transport-restart") {
      this.lastAgentVisibleTransport = null;
    }
    generation.stopped = true;
    await this.terminateGeneration(generation, context);
    if (this.current?.id === generation.id) this.current = null;
    this.invalidateTransportReady();
  }

  private startGeneration(
    stopEpoch: number,
    preservedTransport?: Pick<CuaHelperHandle, "socketPath">,
  ): Promise<CuaHelperHandle> {
    const id = ++this.nextGeneration;
    const socketPath = preservedTransport?.socketPath ?? this.mintSocketPath();
    const argv = [
      this.options.runtime.entryPath,
      "--socket",
      socketPath,
      "--parent-pid",
      String(process.pid),
    ];
    let child: WindowsCuaChild;
    try {
      child = this.childProcess.fork(this.options.runtime.command, argv, {
        cwd: this.options.runtime.root,
        env: {
          ...process.env,
          ...this.options.runtime.commandEnv,
          [ADDON_ENV]: this.options.runtime.addonPath,
          ELECTRON_RUN_AS_NODE: "1",
        },
      });
    } catch (error) {
      const startupError = asError(error);
      // A synchronous fork failure emits no child/exit events to drive fail(); terminate this generation's transport wait explicitly.
      this.rejectTransportReady(startupError);
      this.childLifecycle.logFailure(id, undefined, "fork", startupError);
      return Promise.reject(startupError);
    }

    return new Promise<CuaHelperHandle>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let generation: Generation;
      const fail = (error: unknown, errorClass: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const original = asError(error);
        this.handle = null;
        this.rejectTransportReady(original);
        generation.stopped = true;
        this.childLifecycle.logFailure(id, child.pid, errorClass, original);
        void this.terminateGeneration(generation, errorClass).then(
          () => reject(original),
          (cleanupError) => {
            this.childLifecycle.logFailure(id, child.pid, `${errorClass}-cleanup`, cleanupError);
            reject(original);
          },
        );
      };
      const abort = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.handle = null;
        this.rejectTransportReady(error);
        reject(error);
      };
      const onError = (error: unknown) => fail(error, "child-error");
      const onExit = (code: unknown) => {
        generation.exitObserved = true;
        if (!settled)
          fail(
            new Error(`Windows Computer Use Helper exited before ready (${String(code)})`),
            "early-exit",
          );
        else if (!generation.stopped && this.current?.id === id) {
          this.handle = null;
          this.current = null;
          this.invalidateTransportReady();
          this.logger.warn(undefined, "Windows Computer Use Helper exited unexpectedly", {
            generation: id,
            pid: child.pid,
            errorClass: "unexpected-exit",
          });
          // Only mark the Helper state stale; the next CUA demand recovers via the already-published tuple. Never recycle Agents.
          this.options.onUnexpectedExit?.({ generation: id, pid: child.pid });
        }
      };
      const onMessage = (message: unknown) => {
        // ready can still arrive after stop but before the old process exits; check the generation first so a cleared tuple is never written back.
        if (generation.stopped || stopEpoch !== this.externalStopEpoch || this.current?.id !== id)
          return;
        const ready = parseReadyMessage(message);
        if (ready === "ignore") return;
        if (!ready)
          return fail(
            new Error("Invalid Windows Computer Use Helper control message"),
            "malformed-message",
          );
        if (ready.type === "error") {
          // The helper reported its own startup failure — surface the
          // diagnostic instead of discarding it as a malformed message.
          return fail(new Error(ready.message), "helper-reported-error");
        }
        if (ready.socketPath !== socketPath) return;
        if (ready.pid !== child.pid)
          return fail(new Error("ready-pid-mismatch"), "ready-pid-mismatch");
        this.resolveTransportReady({
          socketPath,
          pluginAuthority: this.authority,
        });
        if (ready.type === "transport_ready") return;
        void this.healthProbe(socketPath, this.startupTimeoutMs).then(
          (health) => {
            if (
              settled ||
              generation.stopped ||
              stopEpoch !== this.externalStopEpoch ||
              this.current?.id !== id
            )
              return;
            if (!isExactHealthPid(health, child.pid))
              return fail(new Error("health-pid-mismatch"), "health-pid-mismatch");
            settled = true;
            if (timer) clearTimeout(timer);
            const handle: CuaHelperHandle = {
              socketPath,
              // Windows uses named pipes and no macOS-style cold-start rendezvous (a pipe is not an
              // fs node; no rename handover). The Helper binds this exact pipe name; the two are
              // identical by construction.
              launchSocketPath: socketPath,
              pluginAuthority: this.authority,
              helperAppPath: this.options.runtime.entryPath,
              bundleId: health.bundleId,
              pid: health.pid,
            };
            // On merge keep the ready handle: transport_ready already saved the recoverable tuple, but storing only the tuple would drop liveness.
            this.handle = handle;
            this.logger.info(undefined, "Windows Computer Use Helper ready", {
              generation: id,
              pid: health.pid,
            });
            resolve(handle);
          },
          (error) => fail(error, "health-failed"),
        );
      };
      generation = {
        id,
        child,
        socketPath,
        stopped: false,
        exitObserved: false,
        abort,
        removeMainListeners: () => {
          this.childLifecycle.off(child, "message", onMessage, id, "cleanup-off-message");
          this.childLifecycle.off(child, "error", onError, id, "cleanup-off-error");
          this.childLifecycle.off(child, "exit", onExit, id, "cleanup-off-exit");
        },
      };
      this.current = generation;
      if (
        !this.childLifecycle.on(child, "message", onMessage, id, "setup-on-message") ||
        !this.childLifecycle.on(child, "error", onError, id, "setup-on-error") ||
        !this.childLifecycle.on(child, "exit", onExit, id, "setup-on-exit")
      ) {
        fail(new Error("Windows Computer Use Helper listener setup failed"), "listener-setup");
        return;
      }
      timer = setTimeout(
        () => fail(new Error("Windows Computer Use Helper startup timed out"), "startup-timeout"),
        this.startupTimeoutMs,
      );
      timer.unref?.();
    });
  }

  private terminateGeneration(generation: Generation, context: string): Promise<void> {
    if (generation.terminationPromise) return generation.terminationPromise;
    const termination = this.terminateGenerationOnce(generation, context);
    generation.terminationPromise = termination;
    return termination;
  }

  private async terminateGenerationOnce(generation: Generation, context: string): Promise<void> {
    try {
      await this.childLifecycle.terminate(generation, context, this.shutdownTimeoutMs);
    } catch (error) {
      this.terminationBlocker = asError(error);
      throw error;
    }
  }

  private invalidateForExternalStop(generation: Generation | null): Promise<void> {
    this.externalStopEpoch += 1;
    this.lastAgentVisibleTransport = null;
    if (!generation) {
      this.rejectTransportReady(new Error("Windows Computer Use Helper startup stopped"));
      return Promise.resolve();
    }
    this.handle = null;
    generation.stopped = true;
    generation.abort?.(new Error("Windows Computer Use Helper startup stopped"));
    // A settled generation has no abort rejecter, yet its transport tuple must still be detached so later starts never reuse dead credentials.
    this.invalidateTransportReady();
    const termination = this.terminateGeneration(generation, "stop");
    // An external stop initiates termination before the tail; consume the rejection up front so the deadline beating the tail never yields an unhandled rejection.
    void termination.catch(() => undefined);
    return termination;
  }
}
