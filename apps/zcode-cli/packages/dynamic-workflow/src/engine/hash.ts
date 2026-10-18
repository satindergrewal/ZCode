/**
 * In-package deterministic hash: FNV-1a (32-bit) over canonical JSON.
 * No node:crypto -- src/ stays pure and portable; the hash is only a defensive replay-time consistency check
 * (not cryptographic; collision resistance is a non-goal, determinism and portability are the point).
 */

/**
 * Canonical JSON serialization: object keys sorted by code point, so semantically equal values give a stable byte order.
 * Covers only the JSON value shapes host calls use (string/number/boolean/null/array/plain object).
 * Non-JSON values (undefined, functions) must not appear here; they serialize as null to keep the function total.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // Primitives: defer to JSON.stringify (number/boolean/string); undefined/function fall back to null.
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    // Skip undefined members, matching JSON.stringify's object semantics.
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(",")}}`;
}

/** FNV-1a 32-bit hash, as 8 hex chars. */
export function fnv1a(input: string): string {
  // FNV offset basis / prime (32-bit). Math.imul keeps the 32-bit multiply wrapping.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    // Fold in the high byte too, or low-byte-only hashing loses multi-byte-char distinction.
    hash ^= (input.charCodeAt(i) >> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  // To unsigned and zero-padded 8 hex chars.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Defensive hash of a host-call input: FNV-1a over the canonical JSON. */
export function inputHash(value: unknown): string {
  return fnv1a(canonicalJson(value));
}
