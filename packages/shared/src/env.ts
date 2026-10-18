import type { ZCodeRuntimeEnv } from "./runtimeEnv.js";

export type ZCodeEnv = "test" | "production";
/** Package identity: app name, app id, Electron data dir, update policy; a different axis from the backend ZCodeEnv. */
export type ZCodeProductFlavor = "production" | "preview";
export type ArmsRumEnv = "local" | "prod";

// Outside builds (e2e mocha) there is no define; typeof check + fallback avoids a ReferenceError.
declare const __ZCODE_ENV__: string;
declare const __ZCODE_PRODUCT_FLAVOR__: string;

export function normalizeZCodeEnv(value: string | undefined): ZCodeEnv {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export const ZCODE_ENV = normalizeZCodeEnv(
  typeof __ZCODE_ENV__ !== "undefined" ? __ZCODE_ENV__ : undefined,
);

/**
 * Identity defaults to the backend env (test -> preview, production -> production).
 * Desktop builds inject preview explicitly via ZCODE_PREVIEW_IDENTITY=1, yielding a Preview package on production backends;
 * bundles without the define (web, CLI, tests) keep the legacy single-axis semantics.
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

// -- Runtime env vars (no compile-time bundling; read from process.env at startup) --
// Debug mode: the inspect-brk port, e.g. ZCODE_DEBUG=9230
export const RUNTIME_ZCODE_DEBUG =
  typeof process !== "undefined" ? process.env.ZCODE_DEBUG : undefined;

// Privacy-hardened build: the master switch is compiled to false. Upstream semantics are
// "no endpoint configured = no egress", but a host shell that presets reporting endpoints
// would silently re-enable every telemetry path. This build hard-disables at the single
// owner so no runtime environment (including shells exporting ZCODE_*/OTEL_* endpoints)
// can initialize data-warehouse event reporting or ARMS RUM.
export const ZCODE_TELEMETRY_ENABLED: boolean = false;

/** Warehouse event endpoint: runtime env only, disabled when unset, never baked into builds. */
export const ZCODE_TELEMETRY_REPORT_ENDPOINT =
  typeof process !== "undefined" ? (process.env.ZCODE_TELEMETRY_REPORT_ENDPOINT ?? "") : "";

/** ARMS RUM endpoint: runtime env only, disabled when unset, never baked into builds. */
export const ZCODE_ARMS_RUM_ENDPOINT =
  typeof process !== "undefined" ? (process.env.ZCODE_ARMS_RUM_ENDPOINT ?? "") : "";

/** Map the local runtime and compile-time ZCODE_ENV onto the ARMS console's environment label. */
export function mapZCodeEnvToArmsRumEnv(runtimeEnv: ZCodeRuntimeEnv): ArmsRumEnv {
  return runtimeEnv !== "development" && ZCODE_ENV === "production" ? "prod" : "local";
}
