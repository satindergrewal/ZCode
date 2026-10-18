import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { acquireFileLock } from "@zcode/shared/node";
import { ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE } from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { isRecord, mcpOAuthCredentialKey } from "./oauth-credentials.js";

export const MCP_OAUTH_PENDING_AUTHORIZATION_KEY = "pending_authorization";

/**
 * Contention wait budget for the authorization lease.
 *
 * Zero will not do: acquireFileLock tests elapsed >= maxWaitMs before attempting to reap an
 * abandoned lock, so a zero budget times out immediately and never runs the owner-dead check;
 * after a crashed holder the whole grant flow would be dead. A short budget guarantees at least one
 * owner-dead reap before failure while keeping follower latency imperceptible in the human loop.
 */
const AUTHORIZATION_LEASE_MAX_WAIT_MS = 250;
const AUTHORIZATION_LEASE_RETRY_DELAYS_MS = [25] as const;
const AUTHORIZATION_LEASE_OWNERLESS_GRACE_MS = 100;

export interface McpOAuthAuthorizationLease {
  attemptId: string;
  release(): Promise<void>;
}

/**
 * Lease file path.
 *
 * Basename allows only hash and hyphen: the credential key prefix looks like `mcp:oauth:<hash>` and colons are
 * illegal in Windows filenames; splicing it in would break the entire grant flow on Windows.
 */
export function resolveAuthorizationLeasePath(
  credentialsFilePath: string,
  keyPrefix: string,
): string {
  return join(dirname(credentialsFilePath), `${sanitizeKeyPrefix(keyPrefix)}.authz`);
}

export function sanitizeKeyPrefix(keyPrefix: string): string {
  return keyPrefix.replaceAll(/[^a-zA-Z0-9-]/g, "-");
}

/**
 * Try to become the grant leader. Returns `undefined` without waiting when the lock is taken (caller becomes follower).
 *
 * Same-process contention is also settled by `mkdir` exclusivity: the second caller gets EEXIST and then reads
 * an owner PID that is this very process, alive, so no false reap and a correct follower downgrade; no in-process
 * registry needed.
 */
export async function tryAcquireAuthorizationLease(input: {
  credentialsFilePath: string;
  keyPrefix: string;
}): Promise<McpOAuthAuthorizationLease | undefined> {
  const leasePath = resolveAuthorizationLeasePath(input.credentialsFilePath, input.keyPrefix);
  try {
    const release = await acquireFileLock(
      leasePath,
      AUTHORIZATION_LEASE_RETRY_DELAYS_MS,
      AUTHORIZATION_LEASE_OWNERLESS_GRACE_MS,
      AUTHORIZATION_LEASE_MAX_WAIT_MS,
    );
    return {
      attemptId: randomBytes(16).toString("hex"),
      release,
    };
  } catch (error) {
    if (getErrorCode(error) === ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE) return undefined;
    // EACCES/EPERM etc. mean the credentials dir is unwritable; interactive grant can never succeed, report instead of degrading silently.
    throw error;
  }
}

export interface PendingAuthorizationRecord {
  attemptId: string;
  authorizationUrl: string;
  baselineGeneration?: string;
  expiresAt: number;
  state: string;
}

interface StoredPendingAuthorization {
  attempt_id: string;
  authorization_url: string;
  baseline_generation?: string;
  expires_at: number;
  state: string;
}

export async function publishPendingAuthorization(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  record: PendingAuthorizationRecord,
): Promise<void> {
  const stored: StoredPendingAuthorization = {
    attempt_id: record.attemptId,
    authorization_url: record.authorizationUrl,
    ...(record.baselineGeneration === undefined
      ? {}
      : { baseline_generation: record.baselineGeneration }),
    expires_at: record.expiresAt,
    state: record.state,
  };
  await credentialStore.save(pendingKey(keyPrefix), JSON.stringify(stored));
}

/** Read pending; expired counts as absent (TTL is display-only, never lock ownership). */
export async function loadPendingAuthorization(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  now = Date.now(),
): Promise<PendingAuthorizationRecord | undefined> {
  const raw = await credentialStore.load(pendingKey(keyPrefix));
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.attempt_id !== "string" ||
    typeof parsed.authorization_url !== "string" ||
    typeof parsed.state !== "string" ||
    typeof parsed.expires_at !== "number"
  ) {
    return undefined;
  }
  if (parsed.expires_at <= now) return undefined;
  return {
    attemptId: parsed.attempt_id,
    authorizationUrl: parsed.authorization_url,
    ...(typeof parsed.baseline_generation === "string"
      ? { baselineGeneration: parsed.baseline_generation }
      : {}),
    expiresAt: parsed.expires_at,
    state: parsed.state,
  };
}

/**
 * Delete only the pending published by this attempt.
 *
 * Deletion must CAS on attempt: an old leader's unconditional `finally` would wipe the new leader's
 * fresh pending and the follower loses the authorization URL. Read the current value to confirm ownership, then compare-and-delete the original.
 */
export async function deletePendingAuthorizationIfOwned(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  attemptId: string,
): Promise<boolean> {
  const key = pendingKey(keyPrefix);
  const raw = await credentialStore.load(key);
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparsable leftovers are cleaned only when still the current value.
    return await credentialStore.deleteIfValue(key, raw);
  }
  if (!isRecord(parsed) || parsed.attempt_id !== attemptId) return false;
  return await credentialStore.deleteIfValue(key, raw);
}

function pendingKey(keyPrefix: string): string {
  return mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_PENDING_AUTHORIZATION_KEY);
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
