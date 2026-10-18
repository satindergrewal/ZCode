import { ZCodeStorageStartupGate } from "#src/zcode-agent/zcodeStorageStartupGate.js";
import { Emitter } from "@zcode/rpc";
import type { IDisposable } from "@zcode/rpc";
import type {
  ZCodeProtocolMethod,
  ZCodeProtocolNotification,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
  ZCodeProtocolTrace,
} from "@zcode/shared";
import type { V4Method } from "@zcode/shared/zcode-protocol-v4";
import type { z } from "zod";
import type { ZCodeProtocolTransport } from "./zcodeProtocolTransport.js";

//** Client-sendable methods: legacy zcodeProtocolMethods + v4/* (v4 is the end state). */
type ZCodeProtocolClientMethod = ZCodeProtocolMethod | V4Method;

interface ZCodeProtocolClientOptions {
  requireStorageStartup?: boolean;
  requestTimeoutMs?: number;
}

interface ZCodeProtocolRequestTimeoutEvent {
  method: ZCodeProtocolClientMethod;
  requestId: ZCodeProtocolRequestId;
  timeoutMs: number;
}

interface PendingRequest<T> {
  method: string;
  observation: boolean;
  timeout: ReturnType<typeof setTimeout>;
  resumeTimeout: () => void;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  resultSchema?: z.ZodType<T>;
  cleanupAbort?: () => void;
}

interface ZCodeProtocolClientRequestOptions {
  /** Observability never counts toward runtime health or idle keep-alive; default request semantics. */
  lifecycle?: "operation" | "observation";
  signal?: AbortSignal;
  trace?: ZCodeProtocolTrace;
  timeoutMs?: number;
}

const DEFAULT_ZCODE_PROTOCOL_REQUEST_TIMEOUT_MS = 3 * 60_000;

class ZCodeProtocolClientError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ZCodeProtocolClientError";
  }
}

export class ZCodeProtocolRequestTimeoutError extends Error {
  constructor(
    readonly method: ZCodeProtocolClientMethod,
    readonly requestId: ZCodeProtocolRequestId,
    readonly timeoutMs: number,
  ) {
    super(`ZCode Protocol request timed out: ${method}`);
    this.name = "ZCodeProtocolRequestTimeoutError";
  }
}

export class ZCodeProtocolClient implements IDisposable {
  readonly storageStartup: ZCodeStorageStartupGate;
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly notificationEmitter = new Emitter<ZCodeProtocolNotification>();
  private readonly requestEmitter = new Emitter<ZCodeProtocolRequest>();
  private readonly requestTimeoutEmitter = new Emitter<ZCodeProtocolRequestTimeoutEvent>();
  // Fires when business requests reach zero; observability must not keep a process alive.
  private readonly pendingDrainedEmitter = new Emitter<void>();
  private readonly closeEmitter = new Emitter<void>();
  private readonly disposables: IDisposable[] = [];
  private nextRequestId = 1;
  private disposed = false;
  private readonly requestTimeoutMs: number;

  /**
   * Whether the client is disposed (process reaped/transport closed).
   * Callers (e.g. getClient reusing an active entry) must check before reuse,
   // or the first request throws "ZCode Protocol client is disposed"
   // against a reaped-but-not-yet-onClose client.
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  readonly onNotification = this.notificationEmitter.event;
  readonly onRequest = this.requestEmitter.event;
  readonly onRequestTimeout = this.requestTimeoutEmitter.event;
  readonly onPendingRequestsDrained = this.pendingDrainedEmitter.event;
  readonly onClose = this.closeEmitter.event;

  /** Requests currently awaiting a response. */
  get pendingRequestCount(): number {
    return this.pending.size;
  }

  get pendingOperationRequestCount(): number {
    let count = 0;
    for (const pending of this.pending.values()) if (!pending.observation) count += 1;
    return count;
  }

  constructor(
    private readonly transport: ZCodeProtocolTransport,
    options?: ZCodeProtocolClientOptions,
  ) {
    this.storageStartup = new ZCodeStorageStartupGate(options?.requireStorageStartup ?? false);
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_ZCODE_PROTOCOL_REQUEST_TIMEOUT_MS;
    this.disposables.push(
      transport.onMessage((message) => this.handleMessage(message)),
      transport.onClose((event) => {
        this.storageStartup.dispose();
        const suffix = event.reason ? `: ${event.reason}` : "";
        this.rejectAll(new Error(`ZCode agent transport closed${suffix}`));
        this.closeEmitter.fire();
      }),
    );
  }

  get transportKind() {
    return this.transport.kind;
  }

  async request<T = unknown>(
    method: ZCodeProtocolClientMethod,
    params?: unknown,
    resultSchema?: z.ZodType<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T> {
    this.assertNotDisposed();
    // No request/watchdog until the real COMMIT enters the legacy request lifecycle.
    if (this.storageStartup.isWaiting) await this.storageStartup.wait(options?.signal);
    this.assertNotDisposed();
    options?.signal?.throwIfAborted();
    const id = this.nextRequestId++;
    const requestKey = String(id);
    const requestTimeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    const observation = options?.lifecycle === "observation";

    const resultPromise = new Promise<T>((resolve, reject) => {
      const expire = () => {
        const pending = this.pending.get(requestKey);
        pending?.cleanupAbort?.();
        this.deletePending(requestKey);
        const error = new ZCodeProtocolRequestTimeoutError(method, id, requestTimeoutMs);
        // A live child with an unresponsive protocol event loop needs more than a per-request timeout:
        // the process manager would keep reusing the stale client and every plugins/list stalls.
        // Surface "connection untrusted" to the owner; the owner retires the process.
        // A short resource-probe timeout means no data this round, not an agent-wide recycle.
        if (!observation) {
          this.requestTimeoutEmitter.fire({ method, requestId: id, timeoutMs: requestTimeoutMs });
        }
        reject(error);
      };
      const timeout = setTimeout(expire, requestTimeoutMs);

      const abortHandler = () => {
        const pending = this.pending.get(requestKey);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pending.cleanupAbort?.();
        this.deletePending(requestKey);
        const reason = options?.signal?.reason;
        reject(
          reason instanceof Error ? reason : new DOMException("Request aborted", "AbortError"),
        );
      };
      const pending: PendingRequest<T> = {
        method,
        observation,
        timeout,
        resumeTimeout: () => {
          pending.timeout = setTimeout(expire, requestTimeoutMs);
        },
        resolve: resolve as (value: unknown) => void,
        reject,
        resultSchema,
        cleanupAbort: () => options?.signal?.removeEventListener("abort", abortHandler),
      };
      this.pending.set(requestKey, pending as PendingRequest<unknown>);
      if (options?.signal?.aborted) {
        abortHandler();
      } else {
        options?.signal?.addEventListener("abort", abortHandler, { once: true });
      }
    });

    // Requests cancelled before send must not enter the transport, or the server runs a task
    // the client already abandoned and cannot receive.
    if (!this.pending.has(requestKey)) {
      return resultPromise;
    }

    try {
      await this.transport.send({
        id,
        method,
        params,
        ...(options?.trace ? { trace: options.trace } : {}),
      });
    } catch (error) {
      const pending = this.pending.get(requestKey);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.cleanupAbort?.();
        this.deletePending(requestKey);
      }
      throw error;
    }

    return resultPromise;
  }

  async notify(method: ZCodeProtocolClientMethod, params?: unknown): Promise<void> {
    this.assertNotDisposed();
    await this.transport.send({ method, params });
  }

  async respond(id: ZCodeProtocolRequestId, result: unknown): Promise<void> {
    this.assertNotDisposed();
    await this.transport.send({ id, result });
  }

  async respondError(
    id: ZCodeProtocolRequestId,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void> {
    this.assertNotDisposed();
    await this.transport.send({ id, error });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeLocalResources();
    this.transport.dispose();
  }

  async disposeAndWait(): Promise<void> {
    const wasDisposed = this.disposed;
    if (!wasDisposed) {
      this.disposed = true;
      this.disposeLocalResources();
    }
    if (this.transport.disposeAndWait) {
      await this.transport.disposeAndWait();
      return;
    }
    if (!wasDisposed) {
      this.transport.dispose();
    }
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") {
      return;
    }

    if ("result" in message && "id" in message) {
      this.resolveResponse(
        (message as { id: ZCodeProtocolRequestId; result: unknown }).id,
        (message as { result: unknown }).result,
      );
      return;
    }

    if ("error" in message && "id" in message) {
      const errorMessage = message as {
        id: ZCodeProtocolRequestId;
        error: { code: number; message: string; data?: unknown };
      };
      this.rejectResponse(
        errorMessage.id,
        new ZCodeProtocolClientError(
          errorMessage.error.message,
          errorMessage.error.code,
          errorMessage.error.data,
        ),
      );
      return;
    }

    if ("method" in message && "id" in message) {
      this.requestEmitter.fire(message as ZCodeProtocolRequest);
      return;
    }

    if ("method" in message) {
      if (
        message.method === "startup/storageState" &&
        this.storageStartup.accept((message as ZCodeProtocolNotification).params)
      ) {
        // Custom/legacy deployments declare no capabilities; only a valid first startup frame may
        // pause these timers (resumed after ready); terminal states never extend them.
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          if (this.storageStartup.snapshot?.phase === "ready") pending.resumeTimeout();
        }
        if (this.storageStartup.snapshot?.phase === "failed") {
          this.rejectAll(
            new Error(`SQLite startup failed: ${this.storageStartup.snapshot.errorCode}`),
          );
        }
      }
      this.notificationEmitter.fire(message as ZCodeProtocolNotification);
    }
  }

  private resolveResponse(id: ZCodeProtocolRequestId, result: unknown): void {
    const requestKey = String(id);
    const pending = this.pending.get(requestKey);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    pending.cleanupAbort?.();
    this.deletePending(requestKey);

    try {
      const parsed = pending.resultSchema ? pending.resultSchema.parse(result) : result;
      pending.resolve(parsed);
    } catch (error) {
      pending.reject(
        error instanceof Error
          ? error
          : new Error(`ZCode Protocol response parse failed: ${pending.method}`),
      );
    }
  }

  private rejectResponse(id: ZCodeProtocolRequestId, error: Error): void {
    const requestKey = String(id);
    const pending = this.pending.get(requestKey);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    pending.cleanupAbort?.();
    this.deletePending(requestKey);
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    const hadPending = this.pendingOperationRequestCount > 0;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.cleanupAbort?.();
      pending.reject(error);
    }
    this.pending.clear();
    if (hadPending && !this.disposed) {
      this.pendingDrainedEmitter.fire();
    }
  }

  private deletePending(requestKey: string): void {
    const pending = this.pending.get(requestKey);
    if (!this.pending.delete(requestKey)) {
      return;
    }
    if (!pending?.observation && this.pendingOperationRequestCount === 0 && !this.disposed) {
      this.pendingDrainedEmitter.fire();
    }
  }

  private disposeLocalResources(): void {
    this.rejectAll(new Error("ZCode Protocol client disposed"));
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.storageStartup.dispose();
    this.notificationEmitter.dispose();
    this.requestEmitter.dispose();
    this.requestTimeoutEmitter.dispose();
    this.pendingDrainedEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("ZCode Protocol client is disposed");
    }
  }
}
