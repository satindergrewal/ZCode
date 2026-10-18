import { randomBytes } from "node:crypto";
import type { ServerRemoteHostCapability } from "@zcode/shared";

// One-shot short-lived ticket semantics, kept consistent with packages/server/src/hostCapability.ts.
// Dependency boundaries forbid importing that implementation from @zcode/server entry points, so this
// package keeps an equivalent in-memory copy; behavior follows the legacy server contract (TTL,
// single consumption, expiry cleanup).
export const DEFAULT_HOST_CAPABILITY_TTL_MS = 30_000;

export interface HostCapabilityStoreOptions {
  ttlMs?: number;
  now?: () => number;
  createCapability?: () => string;
}

export interface HostCapabilityStore {
  issue(): ServerRemoteHostCapability;
  consume(capability: string | undefined): boolean;
}

/** Short-lived one-shot desktop host capability; lives only in the Server Core process memory. */
export function createHostCapabilityStore(
  options: HostCapabilityStoreOptions = {},
): HostCapabilityStore {
  const ttlMs = options.ttlMs ?? DEFAULT_HOST_CAPABILITY_TTL_MS;
  const now = options.now ?? Date.now;
  const createCapability =
    options.createCapability ?? (() => randomBytes(32).toString("base64url"));
  const expiresByCapability = new Map<string, number>();

  const purgeExpired = (at: number): void => {
    for (const [capability, expiresAt] of expiresByCapability) {
      if (expiresAt <= at) expiresByCapability.delete(capability);
    }
  };

  return {
    issue() {
      const issuedAt = now();
      purgeExpired(issuedAt);
      const capability = createCapability();
      const expiresAt = issuedAt + ttlMs;
      expiresByCapability.set(capability, expiresAt);
      return { capability, expiresAt };
    },
    consume(capability) {
      if (!capability) return false;
      const consumedAt = now();
      const expiresAt = expiresByCapability.get(capability);
      // Delete the ticket first on every consume attempt (success, expiry, replay); only the first
      // consumption within TTL grants the trusted-host role, avoiding replayable long-lived elevation.
      expiresByCapability.delete(capability);
      purgeExpired(consumedAt);
      return expiresAt !== undefined && expiresAt > consumedAt;
    },
  };
}
