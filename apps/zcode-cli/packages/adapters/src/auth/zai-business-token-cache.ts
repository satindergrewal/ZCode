import { ProjectAccessTokenTransientError } from "@zcode/shared";

const REFRESH_LEAD_MS = 120_000;
const REFRESH_RETRY_BACKOFF_MS = 5_000;
const UNKNOWN_TTL_MS = 300_000;
const SECOND_MS = 1_000;

export interface ZaiBusinessToken {
  readonly token: string;
  readonly refreshAt: number;
  readonly expiresAt?: number;
}
interface Session {
  oauth: string;
  pending?: Promise<ZaiBusinessToken>;
  value?: ZaiBusinessToken;
  retryAt?: number;
}

/** Business JWT and PAT live differently; the cache is held only by the CLI's recredentialing adapter. */
export class ZaiBusinessTokenCache {
  #session?: Session;
  readonly #rejected = new WeakSet<ZaiBusinessToken>();

  constructor(private readonly onRefreshDeferred?: () => void) {}

  clear(): void {
    this.#session = undefined;
  }

  invalidate(value: ZaiBusinessToken): void {
    // A late stale 401 never clears a business JWT another request already refreshed.
    this.#rejected.add(value);
    if (this.#session?.value === value) this.#session.value = undefined;
  }

  wasRejected(value: ZaiBusinessToken): boolean {
    return this.#rejected.has(value);
  }

  async resolve(oauth: string, exchange: () => Promise<unknown>): Promise<ZaiBusinessToken> {
    if (this.#session?.oauth !== oauth) this.#session = { oauth };
    const session = this.#session;
    if (session.pending) return session.pending;
    if (
      session.value &&
      Date.now() <
        Math.min(session.retryAt ?? session.value.refreshAt, session.value.expiresAt ?? Infinity)
    )
      return session.value;
    const startedAt = Date.now();
    const pending = Promise.resolve()
      .then(() => {
        if (this.#session !== session) throw new Error("project_token_scope_invalidated");
        return exchange();
      })
      .then((raw) => {
        if (this.#session !== session) throw new Error("project_token_scope_invalidated");
        const response = raw as {
          code?: unknown;
          data?: {
            access_token?: string;
            accessToken?: string;
            expires_in?: number;
            expiresIn?: number;
          };
        };
        if (response.code != null && ![0, 200, "0", "200"].includes(response.code as number))
          throw new Error("project_token_login_failed");
        const data = response.data;
        const token = data?.access_token?.trim() || data?.accessToken?.trim();
        if (!token) throw new Error("project_token_login_failed");
        const ttl = data?.expires_in ?? data?.expiresIn;
        const deadlines = [
          readJwtExpiry(token),
          typeof ttl === "number" && Number.isFinite(ttl) ? startedAt + ttl * SECOND_MS : undefined,
        ].filter((value): value is number => value !== undefined);
        const expiresAt = deadlines.length ? Math.min(...deadlines) : undefined;
        const cacheUntil = expiresAt ?? startedAt + UNKNOWN_TTL_MS;
        if (cacheUntil <= Date.now()) throw new Error("project_token_login_failed");
        const value = Object.freeze({ token, expiresAt, refreshAt: cacheUntil - REFRESH_LEAD_MS });
        session.value = value;
        session.retryAt = undefined;
        return value;
      })
      .catch((error: unknown) => {
        if (this.#session !== session) throw new Error("project_token_scope_invalidated");
        const value = session.value;
        // With the true lifetime unknown, never downgrade; keep the object identity so a late 401 can still reject that JWT generation.
        if (
          error instanceof ProjectAccessTokenTransientError &&
          value &&
          !this.wasRejected(value) &&
          value.expiresAt !== undefined &&
          Date.now() < value.expiresAt
        ) {
          session.retryAt = Math.min(Date.now() + REFRESH_RETRY_BACKOFF_MS, value.expiresAt);
          this.onRefreshDeferred?.();
          return value;
        }
        session.value = undefined;
        session.retryAt = undefined;
        throw error;
      })
      .finally(() => {
        // Downgrade and cleanup belong to the shared pending; every concurrent caller gets the same outcome.
        if (session.pending === pending) session.pending = undefined;
      });
    session.pending = pending;
    return pending;
  }
}

function readJwtExpiry(token: string): number | undefined {
  try {
    const raw = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof raw.exp === "number" && Number.isFinite(raw.exp)
      ? raw.exp * SECOND_MS
      : undefined;
  } catch {
    return undefined;
  }
}
