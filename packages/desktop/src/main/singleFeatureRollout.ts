/**
 * * Generic mechanism for per-feature rollouts: TTL cache, in-flight dedupe, 3s request timeout,
 * and a bounded awaitFirstDecision. Parsing (each feature's resolveConfig) is injected by the caller.
 *
 * Extracted because desktopContextPromptRollout and rendererActionTraceRollout share the same
 * /api/v1/client/configs side-channel mechanics, differing only in data.configs.<key> parsing; two copied
 * 170-line implementations would quietly fork their timeout/TTL semantics.
 *
 * Semantics (matching desktopContextPromptRollout; CUA fail-close reuses them):
 * * - failure/timeout/parse error: keep the last snapshot (first-run failure means the initial snapshot from defaultValue);
 * - success without the key: treated as disabled, overwriting the cache (a stale enabled snapshot must not survive).
 */
export interface SingleFeatureRolloutConfig {
  enabled: boolean;
  configVersion?: string;
}

export interface SingleFeatureRollout<T extends SingleFeatureRolloutConfig> {
  refresh(): Promise<T>;
  getSnapshot(): T;
  /**
   * Bounded wait for one rollout decision: races the server request, falling back to the current snapshot on timeout.
   *
   * Why: the Host/Agent presentation surface freezes at process start (services/node.ts top-level
   * const + CLI --surface) while rollout requests are side-channel and never block the Host. If the first Host fork
   * beats the response, a success has no path into the frozen Host/Agent. awaitFirstDecision gives the success
   * a bounded path: the caller awaits it before the first fork, letting the spawn flow
   * read the snapshot synchronously with the real value. Stateless here; the first-only latch lives in desktop main.
   */
  awaitFirstDecision(timeoutMs: number): Promise<T>;
}

export interface SingleFeatureRolloutLogger {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export const SINGLE_FEATURE_REQUEST_TIMEOUT_MS = 3_000;
export const SINGLE_FEATURE_CACHE_TTL_MS = 60 * 60 * 1_000;

export interface CreateSingleFeatureRolloutOptions<T extends SingleFeatureRolloutConfig> {
  /** Parses /api/v1/client/configs bodies; null means invalid (treated as failure, keep last snapshot). */
  resolveConfig: (payload: unknown) => T | null;
  /** Initial snapshot: fail-open features pass {enabled:true}, fail-close {enabled:false}. */
  defaultValue: T;
  /** Log prefix, e.g. desktop-context-prompt / renderer-action-trace. */
  logTag: string;
  fetchConfig: (signal: AbortSignal) => Promise<unknown>;
  logger: SingleFeatureRolloutLogger;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

export function createSingleFeatureRollout<T extends SingleFeatureRolloutConfig>(
  options: CreateSingleFeatureRolloutOptions<T>,
): SingleFeatureRollout<T> {
  let snapshot: T = options.defaultValue;
  let snapshotExpiresAt = 0;
  let inFlight: Promise<T> | undefined;
  const timeoutMs = Math.max(options.timeoutMs ?? SINGLE_FEATURE_REQUEST_TIMEOUT_MS, 1);
  const cacheTtlMs = Math.max(options.cacheTtlMs ?? SINGLE_FEATURE_CACHE_TTL_MS, 1);

  const refresh = (): Promise<T> => {
    if (Date.now() < snapshotExpiresAt) {
      return Promise.resolve(snapshot);
    }
    if (inFlight) {
      return inFlight;
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const request = (async () => {
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`${options.logTag} config timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timeout.unref?.();
        });
        const payload = await Promise.race([
          options.fetchConfig(controller.signal),
          timeoutPromise,
        ]);
        const next = options.resolveConfig(payload);
        if (!next) {
          throw new Error(`${options.logTag} config is invalid`);
        }
        snapshot = next;
        snapshotExpiresAt = Date.now() + cacheTtlMs;
        options.logger.info?.(`[${options.logTag}] config refreshed`, {
          enabled: next.enabled,
          configVersion: next.configVersion,
        });
        return snapshot;
      } catch (error) {
        // Rollouts are side-channel: server failure/timeout never blocks the client; keep successes, default on first failure.
        options.logger.warn(`[${options.logTag}] config unavailable, using cached decision`, {
          error,
          enabled: snapshot.enabled,
        });
        return snapshot;
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        controller.abort();
      }
    })();
    inFlight = request;
    void request.then(
      () => {
        if (inFlight === request) {
          inFlight = undefined;
        }
      },
      () => {
        if (inFlight === request) {
          inFlight = undefined;
        }
      },
    );
    return request;
  };

  return {
    refresh,
    getSnapshot: () => snapshot,
    awaitFirstDecision: (timeoutMs: number) => {
      // Race refresh(): it already dedupes via TTL/in-flight with a 3s timeout and never rejects
      // (returning the last snapshot on error); the outer timeout falls back to the current snapshot. Both branches resolve,
      // so the caller (first Host fork path) is never blocked by a rejection.
      const boundedTimeout = Math.max(timeoutMs, 1);
      const fallback = new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(snapshot), boundedTimeout);
        // Side-channel timers must not hold the process open (tests/shutdown).
        timer.unref?.();
      });
      return Promise.race([refresh(), fallback]);
    },
  };
}
