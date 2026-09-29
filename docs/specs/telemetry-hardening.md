# Spec: Desktop Build Privacy Hardening (Zero Telemetry)

## Product Rules

- Desktop/CLI builds produced from this repository must **never emit telemetry by default**: data-warehouse event reporting, ARMS RUM, OTLP traces/metrics, and auto-update checks are all disabled.
- Upstream default semantics are "no endpoint configured = no egress" (see the comment in `packages/shared/src/env.ts`); this spec tightens that to "hard-disabled at build level": even if the host shell presets `ZCODE_TELEMETRY_REPORT_ENDPOINT`, `ZCODE_ARMS_RUM_ENDPOINT`, or `OTEL_EXPORTER_OTLP_*` environment variables, no telemetry path may initialize.
- Model API calls, OAuth, billing, conversation sharing, and plugin marketplace downloads are product feature traffic and out of scope for this spec.
- Auto-update checks report `device_mid`, and installing official builds would overwrite this hardened build, so they are hard-disabled as well; updates are performed by pulling new source and rebuilding manually.

## State Owners

| State | Single Owner | Notes |
| ----- | ------------ | ----- |
| Telemetry master switch | `ZCODE_TELEMETRY_ENABLED` in `packages/shared/src/env.ts` | Sole gate for data-warehouse events and ARMS RUM; compiled to `false` |
| Agent OTLP telemetry | `prepareModelTelemetryEnv` in `apps/zcode-cli/packages/telemetry/src/bootstrap.ts` | Build constant short-circuits: no identity prep, no SDK load |
| Desktop local OTLP outlets | `packages/desktop/src/main/index.ts` | When the master switch is off, exporters receive an empty env; endpoint resolution fails and they are never created |
| Auto-update | `initAutoUpdater` call in `packages/desktop/src/main/index.ts` | `enabled: false`, reusing the existing flavor-disabled path |

## Interfaces

- No exported signature changes: `ZCODE_TELEMETRY_ENABLED` remains a `boolean` constant; `prepareModelTelemetryEnv` keeps its signature and return type; `initAutoUpdater` options are unchanged.
- Downstream consumers (`telemetryCore`, `appARMSBootstrap`, `agentTelemetryEnv`, `createModelTelemetry`) keep using their existing disabled branches; no new fallback branches are added.

## Acceptance Scenarios

1. Launching the app with `ZCODE_TELEMETRY_REPORT_ENDPOINT` + `ZCODE_ARMS_RUM_ENDPOINT` + `OTEL_EXPORTER_OTLP_ENDPOINT` preset: no network requests reach those endpoints (ARMS SDK not initialized, telemetryCore early-returns, TTFT/ActionTrace exporters never created).
2. Running the CLI agent standalone with an OTEL endpoint injected: `createModelTelemetry` returns a noop implementation with `enabled: false`; the OTel SDK is never imported.
3. Build artifacts contain no hardcoded telemetry endpoints (`ZCODE_TELEMETRY_REPORT_ENDPOINT` and `ZCODE_ARMS_RUM_ENDPOINT` default to empty strings; no reporting URL is embedded in the bundle).
4. The startup log contains `[auto-update] disabled for this desktop product flavor`; no `releases/electron/manifest` request is made.
