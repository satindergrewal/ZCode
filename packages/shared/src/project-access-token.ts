import { z } from "zod";
import { projectTokenSuccessCodeSchema } from "./project-access-token-response.js";
import type { ApiKeyCreationUsageScene } from "./api-key-usage-scene.js";

const SECOND_MS = 1_000;
const REFRESH_LEAD_MS = 120 * SECOND_MS;
const REFRESH_JITTER_MS = 60 * SECOND_MS;
const REFRESH_RETRY_BACKOFF_MS = 5 * SECOND_MS;

const responseSchema = z.preprocess(
  (raw) => {
    if (
      raw &&
      typeof raw === "object" &&
      "data" in raw &&
      raw.data &&
      typeof raw.data === "object" &&
      !("enable" in raw.data)
    ) {
      return { ...raw, data: { ...raw.data, enable: true } };
    }
    return raw;
  },
  z.object({
    code: projectTokenSuccessCodeSchema,
    data: z.discriminatedUnion("enable", [
      z.object({ enable: z.literal(false) }),
      z.object({
        enable: z.literal(true),
        accessToken: z.string().trim().min(1),
        tokenType: z.literal("Bearer"),
        expiresIn: z.number().finite().positive(),
        expiresAt: z.number().finite().positive(),
      }),
    ]),
  }),
);

export interface ProjectAccessTokenScope {
  readonly origin: string;
  readonly family: "bigmodel" | "zai";
  readonly accountId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly apiKeyId: string;
  readonly usageScene: ApiKeyCreationUsageScene;
  /** Login lifecycle marker; never the raw token or a short-lived token hash. */
  readonly loginGeneration: string;
}

export type ProjectAccessTokenResult =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly token: string;
      readonly expiresAt: number;
    };

export class ProjectAccessTokenError extends Error {
  constructor(readonly code: "project_token_invalid_response" | "project_token_scope_invalidated") {
    // Responses carry credentials; keep zod issues, raw responses, and tokens out of exceptions/logs.
    super(code);
    this.name = "ProjectAccessTokenError";
  }
}

/** Transient fault confirmed by the I/O adapter; carries no raw response, URL, token, or cause. */
export class ProjectAccessTokenTransientError extends Error {
  constructor() {
    super("project_token_transient_failure");
    this.name = "ProjectAccessTokenTransientError";
  }
}

interface CacheEntry {
  fingerprint?: string;
  value?: Extract<ProjectAccessTokenResult, { enabled: true }>;
  refreshAt?: number;
  pending?: Promise<ProjectAccessTokenResult>;
}

/**
 * Pure in-memory state of the account-auth owner: no networking, storage, timers, or global singletons.
 * Host and Standalone hold separate instances; issuance is injected via each one's existing I/O adapter.
 */
export class ProjectAccessTokenCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #onRefreshDeferred?: () => void;

  constructor(
    options: { now?: () => number; random?: () => number; onRefreshDeferred?: () => void } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#onRefreshDeferred = options.onRefreshDeferred;
  }

  async resolve(
    scope: ProjectAccessTokenScope,
    issue: () => Promise<unknown>,
    rejectedFingerprint?: string,
  ): Promise<ProjectAccessTokenResult> {
    const key = scopeKey(scope);
    let entry = this.#entries.get(key);
    // Clean up only the rejected PAT generation; a late 401 must not discard newer credentials or interrupt an in-flight rotation.
    if (rejectedFingerprint && entry?.fingerprint === rejectedFingerprint) {
      entry.value = undefined;
      entry.refreshAt = undefined;
    }
    if (entry?.pending) return entry.pending;
    if (entry?.value && this.#now() < Math.min(entry.refreshAt!, entry.value.expiresAt)) {
      return entry.value;
    }
    if (!entry) {
      entry = {};
      this.#entries.set(key, entry);
    }
    const current = entry;
    const startedAt = this.#now();
    // Defer issuance to a microtask and register pending first, so even synchronous reentry produces a single request.
    const pending = Promise.resolve()
      .then(() => {
        // Exit can land before the issuance microtask; even the old login's network request must not fire then.
        if (this.#entries.get(key) !== current) {
          throw new ProjectAccessTokenError("project_token_scope_invalidated");
        }
        return issue();
      })
      .then(async (raw) => {
        if (this.#entries.get(key) !== current) {
          throw new ProjectAccessTokenError("project_token_scope_invalidated");
        }
        const response = responseSchema.safeParse(raw);
        if (!response.success) throw new ProjectAccessTokenError("project_token_invalid_response");
        const data = response.data.data;
        if (!data.enable) {
          this.#entries.delete(key);
          return Object.freeze({ enabled: false } as const);
        }
        // expiresIn is counted conservatively from issuance-request start; network latency must not become extra validity.
        const expiresAt = Math.min(
          data.expiresAt * SECOND_MS,
          startedAt + data.expiresIn * SECOND_MS,
        );
        if (!Number.isFinite(expiresAt) || expiresAt <= this.#now()) {
          throw new ProjectAccessTokenError("project_token_invalid_response");
        }
        const jitter = Math.max(0, Math.min(1, this.#random())) * REFRESH_JITTER_MS;
        const fingerprint = await projectAccessTokenFingerprint(data.accessToken);
        if (this.#entries.get(key) !== current)
          throw new ProjectAccessTokenError("project_token_scope_invalidated");
        current.fingerprint = fingerprint;
        current.value = Object.freeze({
          enabled: true,
          token: data.accessToken,
          expiresAt,
        });
        current.refreshAt = expiresAt - REFRESH_LEAD_MS - jitter;
        return current.value;
      })
      .catch((error: unknown) => {
        if (this.#entries.get(key) !== current)
          throw new ProjectAccessTokenError("project_token_scope_invalidated");
        // Keep only PATs still valid and not cleared by a 401 fingerprint; auth rejections and malformed payloads must fail.
        // The downgrade joins the same pending so every concurrent caller gets one result, without extending validity.
        if (
          error instanceof ProjectAccessTokenTransientError &&
          current.value &&
          this.#now() < current.value.expiresAt
        ) {
          current.refreshAt = Math.min(
            this.#now() + REFRESH_RETRY_BACKOFF_MS,
            current.value.expiresAt,
          );
          this.#onRefreshDeferred?.();
          return current.value;
        }
        this.#entries.delete(key);
        throw error;
      })
      .finally(() => {
        if (current.pending === pending) current.pending = undefined;
      });
    current.pending = pending;
    return pending;
  }

  invalidate(scope: ProjectAccessTokenScope): void {
    this.#entries.delete(scopeKey(scope));
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** Comparison value for rejecting one PAT generation; never an account identity, never sent to model upstreams. */
export async function projectAccessTokenFingerprint(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function scopeKey(scope: ProjectAccessTokenScope): string {
  return JSON.stringify([
    scope.origin,
    scope.family,
    scope.accountId,
    scope.organizationId,
    scope.projectId,
    scope.apiKeyId,
    scope.usageScene,
    scope.loginGeneration,
  ]);
}
