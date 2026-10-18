/**
 * The redaction choke point for telemetry text and model identity.
 *
 * ARMS auto-collected exception/api/click events and free-text fields of custom events may carry
 * local paths, emails, full URLs, and credentials. Pure functions here, shared by desktop main's beforeReport
 * and renderer-side analytics, so every hook does not reimplement the patterns.
 *
 * Patterns mirror the CLI's apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts; the two workspaces
 * must not depend on each other, so any extension lands on both sides.
 */

import { decodeCustomModelValue } from "./custom-model-value.js";
import { migrateLegacyModelProviderId } from "./legacy-model-provider-identity.js";
import { isBuiltinModelProviderId } from "./model-provider-types.js";
import { OFFICIAL_GLM_MODEL_IDS } from "./official-glm-model-id.js";

/** Per-field default cap; ARMS truncates or rejects overlong fields, so pre-truncation guarantees the key head ships. */
export const TELEMETRY_TEXT_MAX_LENGTH = 2_048;

/** Input cap before redaction: errors may embed whole response bodies; bound then regex-scrub, keeping CPU bounded. */
const TELEMETRY_TEXT_SCAN_LIMIT = 4_096;

/** Max length of a route segment kept verbatim; longer segments are untrusted content. */
const TELEMETRY_ROUTE_SEGMENT_MAX_LENGTH = 128;

export interface RedactTelemetryTextOptions {
  /// Output cap, default {@link TELEMETRY_TEXT_MAX_LENGTH}.
  maxLength?: number;
}

/**
 * Scrub free text into reportable form: URLs without query, paths/emails/credentials as placeholders, bounded truncation.
 *
 * Acts on the reporting copy only; error display, local logs, crash archives, and classification keep the original.
 */
export function redactTelemetryText(
  value: string | undefined | null,
  options: RedactTelemetryTextOptions = {},
): string {
  if (typeof value !== "string" || !value) {
    return "";
  }

  const maxLength = options.maxLength ?? TELEMETRY_TEXT_MAX_LENGTH;
  const redacted = value
    .slice(0, TELEMETRY_TEXT_SCAN_LIMIT)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, (match) => redactTelemetryUrl(match))
    .replace(
      /(\bauthorization\b["']?\s*[:=])\s*(?:(?:Bearer|Basic)\s+)?[^\s,"'};]+/giu,
      "$1 {redacted}",
    )
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|authorization|password|passwd|secret|cookie|session)=)[^&\s]+/giu,
      "$1{redacted}",
    )
    .replace(
      /(["']?(?:api[_-]?key|token|access[_-]?token|password|passwd|secret|client[_-]?secret|cookie|set-cookie|session)["']?\s*[:=]\s*["']?)(?!\{redacted\})[^\s,"'};]+/giu,
      "$1{redacted}",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 {redacted}")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/giu, "{secret}")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "{secret}")
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "{secret}")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, "{secret}")
    .replace(/\b[^/@\s]+@[^/@\s]+\.[^/@\s]+\b/gu, "{email}")
    // Fix rationale: absolute paths in crash/exception messages carry the local username and workspace dir; normalize before leaving the machine.
    .replace(/\/(?:private\/)?(?:var\/folders|tmp)\/[^\s:;,)\]}]+/gu, "{path}")
    .replace(
      /\/(?:Users|home|root|workspace|workspaces|Volumes)\/[^/\s]+(?:\/[^\s:;,)\]}]+)*/gu,
      "{path}",
    )
    .replace(/\b[A-Za-z]:\\[^\\\s]+(?:\\[^\s:;,)\]}]+)*/gu, "{path}")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return redacted.slice(0, maxLength);
}

/**
 * Scrub a URL to protocol//host plus a normalized route; query and fragment dropped.
 *
 * file:// and local absolute paths become local_file; blob:/data: keep only the scheme;
 * unparseable returns unknown, never the original.
 */
export function redactTelemetryUrl(value: string | undefined | null): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "unknown";
  }
  if (/^blob:/iu.test(raw)) {
    return "blob";
  }
  if (/^data:/iu.test(raw)) {
    return "data";
  }
  // Bug root cause: enumerating common roots missed legal POSIX absolutes like /opt, /root, /mnt.
  if (/^file:/iu.test(raw) || /^[a-zA-Z]:[\\/]/u.test(raw) || raw.startsWith("/")) {
    return "local_file";
  }

  try {
    // Bug root cause: blanket https:// made plain text like !!! parse its host and echo back.
    // Only inputs with a scheme, or that look like host[:port][/path], enter parsing.
    const candidate = raw.includes("://")
      ? raw
      : /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(?:[/?#]|$)/iu.test(raw)
        ? `https://${raw}`
        : "";
    if (!candidate) {
      return "unknown";
    }
    const parsed = new URL(candidate);
    if (parsed.protocol === "file:" || !parsed.host) {
      return "local_file";
    }
    const route = parsed.pathname
      .split("/")
      .map((segment) => redactTelemetryRouteSegment(segment))
      .join("/");
    return `${parsed.protocol}//${parsed.host}${route}`;
  } catch {
    return "unknown";
  }
}

function redactTelemetryRouteSegment(segment: string): string {
  if (!segment) {
    return segment;
  }
  if (
    // Emails, long numeric ids, hashes, UUIDs are high-cardinality identity; never verbatim in routes.
    /@/u.test(segment) ||
    /^\d{7,}$/u.test(segment) ||
    /^[0-9a-f]{16,}$/iu.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment)
  ) {
    return "{segment}";
  }
  return segment.slice(0, TELEMETRY_ROUTE_SEGMENT_MAX_LENGTH);
}

/** Legacy built-in models outside the official GLM roster; still ZCode's own stable ids, not user-named. */
const TELEMETRY_LEGACY_BUILTIN_MODEL_IDS: readonly string[] = ["charglm-4", "codegeex-4", "emohaa"];

/**
 * The telemetry model allowlist: only these built-in stable model ids may enter telemetry verbatim.
 *
 * Independent of the account's runtime catalog, sourced from the hand-maintained official GLM roster:
 * fix rationale: a hand-copied list once missed GLM-5.3 / GLM-5.3-Flash / GLM-5V-Turbo, flagging flagship models
 * as custom across plan_* / perf_ui_*. Derived from the official roster, the two cannot drift.
 */
export const TELEMETRY_SAFE_BUILTIN_MODEL_IDS: ReadonlySet<string> = new Set([
  ...OFFICIAL_GLM_MODEL_IDS.map((id) => id.toLowerCase()),
  ...TELEMETRY_LEGACY_BUILTIN_MODEL_IDS,
]);

export type TelemetryProviderScope = "builtin" | "custom" | "unknown";

export interface TelemetryProviderIdentity {
  providerId: string;
  providerScope: TelemetryProviderScope;
}

/**
 * Legacy report identities (builtin:zai / builtin:zai-start-plan...) are ZCode's own fixed ids.
 *
 * Fix rationale: the V4 supervisor's /report detail uses legacyTelemetryProviderId to map runtime account:* onto
 * these legacy ids, and plan_ttft / perf_ui_* share that detail. Accepting only account:* would normalize every
 * built-in user to custom. Reuse shared's one-way migration table; unknown builtin: prefixes stay custom, never smuggled in.
 * unknown builtin: prefixes stay custom; never smuggled in by prefix.
 */
function isLegacyBuiltinTelemetryProviderId(providerId: string): boolean {
  const migrated = migrateLegacyModelProviderId(providerId);
  return migrated !== undefined && migrated !== providerId;
}

/** Built-in providers keep stable ids; custom providers are user-named, and verbatim reporting leaks private names and explodes cardinality. */
export function resolveTelemetryProviderScope(
  providerId: string | undefined | null,
): TelemetryProviderIdentity {
  const normalized = providerId?.trim();
  if (!normalized) {
    return { providerId: "", providerScope: "unknown" };
  }
  if (isBuiltinModelProviderId(normalized) || isLegacyBuiltinTelemetryProviderId(normalized)) {
    return { providerId: normalized, providerScope: "builtin" };
  }
  return { providerId: "custom", providerScope: "custom" };
}

/**
 * Strip the bare model id from a custom:<providerId>:<modelName> encoding or a <providerId>/<modelId> composite.
 * The bare id only feeds the allowlist check; whatever the provider part, it never enters telemetry verbatim.
 */
function extractBareModelId(value: string): string {
  const decoded = decodeCustomModelValue(value);
  if (decoded) {
    return decoded.modelName ?? "";
  }
  const separator = value.indexOf("/");
  return separator > 0 ? value.slice(separator + 1) : value;
}

/**
 * Keep only allowlisted built-in model ids.
 *
 * Custom-provider models and non-allowlisted built-in-provider models write custom;
 * unknown provider scope or missing model writes the empty string, matching the existing blank convention.
 */
export function resolveTelemetryModelId(
  providerScope: TelemetryProviderScope,
  modelId: string | undefined | null,
): string {
  const normalized = modelId?.trim();
  if (!normalized || providerScope === "unknown") {
    return "";
  }
  if (providerScope === "custom") {
    return "custom";
  }
  // Fix rationale: the supervisor-projected detail.model_name is a <providerId>/<modelId> composite or
  // custom: encoding; whole-string allowlist checks always miss. Strip the bare id first, then judge.
  const bareModelId = extractBareModelId(normalized).toLowerCase();
  return TELEMETRY_SAFE_BUILTIN_MODEL_IDS.has(bareModelId) ? bareModelId : "custom";
}

/**
 * Normalize the "one model value, no separate provider field" case.
 *
 * Three shapes: custom:<providerId>[:<modelName>], <providerId>/<modelId>, and a bare model id.
 * Bare ids judge directly against the allowlist, missing degrades to custom--exactly the "new built-in models
 * must default-degrade until allowlisted" rule, so callers need not pass a provider.
 */
export function sanitizeTelemetryModelValue(value: string | undefined | null): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "";
  }

  // The custom: prefix already means non-builtin; judgable without decoding user names.
  const decoded = decodeCustomModelValue(normalized);
  if (decoded) {
    return resolveTelemetryModelId(
      resolveTelemetryProviderScope(decoded.providerId).providerScope,
      decoded.modelName,
    );
  }

  const separator = normalized.indexOf("/");
  if (separator > 0) {
    const { providerScope } = resolveTelemetryProviderScope(normalized.slice(0, separator));
    return resolveTelemetryModelId(providerScope, normalized.slice(separator + 1));
  }

  return resolveTelemetryModelId("builtin", normalized);
}
