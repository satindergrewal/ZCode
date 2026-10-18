import type { ZCodeRuntimeEnv } from "./runtimeEnv.js";

export type ZCodeEnv = "test" | "production";
/** Installer identity: app name, app id, Electron data dir, update channel. A separate axis from backend env (`ZCodeEnv`). */
export type ZCodeProductFlavor = "production" | "preview";
export type ArmsRumEnv = "local" | "prod";

// No define in non-build environments (e.g. mocha e2e); the typeof check + fallback avoids a ReferenceError
declare const __ZCODE_ENV__: string;
declare const __ZCODE_PRODUCT_FLAVOR__: string;
declare const __ZCODE_ARMS_RUM_ENDPOINT__: string;
declare const __ZCODE_TELEMETRY_REPORT_ENDPOINT__: string;
declare const __ZCODE_AUTO_UPDATE_ENABLED__: boolean;

export function normalizeZCodeEnv(value: string | undefined): ZCodeEnv {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export const ZCODE_ENV = normalizeZCodeEnv(
  typeof __ZCODE_ENV__ !== "undefined" ? __ZCODE_ENV__ : undefined,
);

/**
 * Identity defaults to following the backend env (test -> preview, production -> production).
 * Desktop builds inject preview via `ZCODE_PREVIEW_IDENTITY=1`, yielding a Preview package on the production backend;
 * bundles built without the define (web, CLI, tests) keep the old single-axis semantics.
 */
export function normalizeZCodeProductFlavor(
  value: string | undefined,
  zcodeEnv: ZCodeEnv,
): ZCodeProductFlavor {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production" || normalized === "preview") {
    return normalized;
  }
  return zcodeEnv === "production" ? "production" : "preview";
}

export const ZCODE_PRODUCT_FLAVOR = normalizeZCodeProductFlavor(
  typeof __ZCODE_PRODUCT_FLAVOR__ !== "undefined" ? __ZCODE_PRODUCT_FLAVOR__ : undefined,
  ZCODE_ENV,
);
export const ZCODE_APP_VERSION_ENV = "ZCODE_APP_VERSION" as const;
export const ZCODE_BUILD_COMMIT_ID_ENV = "ZCODE_BUILD_COMMIT_ID" as const;

// -- Runtime env vars (not baked at build time; read from process.env at startup) --
// Enables debug mode; value is the inspect-brk port, e.g. ZCODE_DEBUG=9230
export const RUNTIME_ZCODE_DEBUG =
  typeof process !== "undefined" ? process.env.ZCODE_DEBUG : undefined;

// -- Build-time optional capabilities (see docs/desktop/build-time-optional-capabilities.md); off unless injected --
// Privacy-hardened build (docs/specs/telemetry-hardening.md): the master switch is compiled
// to false and desktop consumers treat it as the single owner of the telemetry posture, while
// the endpoints below resolve through build-time defines; scripts/build-time-config.mjs
// defaults them to empty strings, so hardened builds embed no reporting URL and no egress
// path initializes. Agent-side OTLP telemetry is gated separately in
// apps/zcode-cli/packages/telemetry (prepareModelTelemetryEnv).
export const ZCODE_TELEMETRY_ENABLED: boolean = false;
/** ARMS RUM endpoint; when empty the SDK initializes with enable=false and reports nothing. */
export const ZCODE_ARMS_RUM_ENDPOINT: string =
  typeof __ZCODE_ARMS_RUM_ENDPOINT__ !== "undefined" ? __ZCODE_ARMS_RUM_ENDPOINT__ : "";
/** Event analytics (warehouse) endpoint; no reporting when empty. */
export const ZCODE_TELEMETRY_REPORT_ENDPOINT: string =
  typeof __ZCODE_TELEMETRY_REPORT_ENDPOINT__ !== "undefined"
    ? __ZCODE_TELEMETRY_REPORT_ENDPOINT__
    : "";
/** Whether desktop auto-update is enabled. */
export const ZCODE_AUTO_UPDATE_ENABLED: boolean =
  typeof __ZCODE_AUTO_UPDATE_ENABLED__ !== "undefined" ? __ZCODE_AUTO_UPDATE_ENABLED__ : false;

/** Maps runtime state and build-time ZCODE_ENV onto the ARMS console environment label */
export function mapZCodeEnvToArmsRumEnv(runtimeEnv: ZCodeRuntimeEnv): ArmsRumEnv {
  return runtimeEnv !== "development" && ZCODE_ENV === "production" ? "prod" : "local";
}
