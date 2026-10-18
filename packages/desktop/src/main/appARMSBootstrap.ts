import { wrapStartupReporterRequest } from "./startupTelemetryDelivery.js";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import armsRum from "@arms/rum-electron";
import { ZCODE_AGENT_LIFECYCLE_LOG_MARKER } from "@zcode/shared/process-diagnostic";
import {
  ZCODE_ARMS_RUM_ENDPOINT,
  ZCODE_VERSION,
  ZCODE_TELEMETRY_ENABLED,
  mapZCodeEnvToArmsRumEnv,
} from "@zcode/shared";
import { ARMS_BROWSER_COLLECTORS, parseArmsViewName } from "../shared/armsRumShared.js";
import { redactArmsEventBatch } from "./armsEventRedaction.js";
import { ensureDesktopDeviceMidSync } from "./desktopDeviceMid.js";
import { ingestArmsApiEventsFromBatch } from "./desktopNetworkTelemetry.js";
import { desktopRuntimeEnv, runtimeApplicationName } from "./desktopRuntimeEnv.js";
import { summarizeLongTaskAttribution } from "./longTaskAttributionSummary.js";
import { logger } from "./logger.js";

// LoAF long-task snapshots (SDK top-5 attribution) do not reach SLS by default; write them into
// event.properties so attribution summaries (top durations/shares/invokerType) are queryable. No raw script names/URLs.
function enrichLongTaskAttribution(events: Array<Record<string, unknown>>): void {
  for (const event of events) {
    if (event.event_type !== "longTask") {
      continue;
    }
    const summary = summarizeLongTaskAttribution(event.snapshots, event.duration);
    if (!summary) {
      continue;
    }
    const existingProps =
      event.properties && typeof event.properties === "object"
        ? (event.properties as Record<string, unknown>)
        : {};
    event.properties = { ...existingProps, ...summary };
  }
}

function isCrashReporterEvent(event: Record<string, unknown>): boolean {
  return (
    event.event_type === "exception" && event.type === "crash" && event.source === "crashReporter"
  );
}

function normalizeExecutableName(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/\.exe$/i, "")
    : "";
}

function hasProductExecutable(
  event: Record<string, unknown>,
  applicationName: string,
  runtimeExecutableName?: string,
): boolean {
  // Fix: the app name is not the real binary name in every shape -- dev runs Electron,
  // Linux Preview runs zcode-preview. Exact match required; a prefix would swallow helper dumps.
  const expectedNames = new Set(
    [applicationName, runtimeExecutableName].map(normalizeExecutableName).filter(Boolean),
  );
  if (expectedNames.size === 0 || !Array.isArray(event.binary_images)) {
    return false;
  }
  return event.binary_images.some((image) => {
    if (!image || typeof image !== "object") {
      return false;
    }
    return expectedNames.has(normalizeExecutableName((image as Record<string, unknown>).name));
  });
}

type NativeDumpProcessRole = "main" | "renderer" | "utility" | "gpu" | "host" | "agent" | "unknown";

const nativeDumpProcessRoleAliases: Record<string, NativeDumpProcessRole> = {
  main: "main",
  browser: "main",
  main_process: "main",
  renderer: "renderer",
  utility: "utility",
  utility_host: "utility",
  gpu: "gpu",
  host: "host",
  agent: "agent",
};

function readNativeDumpProcessRole(event: Record<string, unknown>): NativeDumpProcessRole {
  const metadata =
    event.meta && typeof event.meta === "object"
      ? (event.meta as Record<string, unknown>)
      : undefined;
  // Fix: a generic process_role can come from event props or middleware and does not prove a Crashpad dump.
  // Trust only meta.process_type extracted from structured annotation RVAs by the dependency patch, so helper
  // dumps are not promoted to app_native_process by unstructured main tags, polluting Native Crash/Crash-Free.
  const processType = metadata?.process_type;
  if (typeof processType === "string") {
    return nativeDumpProcessRoleAliases[processType.trim().toLowerCase()] ?? "unknown";
  }
  return "unknown";
}

export function filterAndEnrichNativeCrashEvents(
  events: Array<Record<string, unknown>>,
  applicationName: string,
  runtimeExecutableName?: string,
): Array<Record<string, unknown>> {
  return events.filter((event) => {
    if (!isCrashReporterEvent(event)) {
      return true;
    }
    if (!hasProductExecutable(event, applicationName, runtimeExecutableName)) {
      return false;
    }
    const existingProperties =
      event.properties && typeof event.properties === "object"
        ? (event.properties as Record<string, unknown>)
        : {};
    const nativeDumpProcessRole = readNativeDumpProcessRole(event);
    // Root cause: binary_images only proves a product binary; on Linux/Windows main/renderer/utility/host
    // share one executable. Unknown roles keep the raw crashReporter event but never enter
    // app_native_process, or helper crash loops count as app native crashes and sink Crash-Free.
    // Only dumps explicitly marked main enter product KPIs.
    event.properties = {
      ...existingProperties,
      telemetry_schema_version: "2",
      // Bugfix: SDK retries push the same event through beforeReport again; keep the incident ID for dedup.
      crash_id:
        typeof existingProperties.crash_id === "string"
          ? existingProperties.crash_id
          : randomUUID(),
      crash_scope:
        nativeDumpProcessRole === "main" ? "app_native_process" : "native_dump_unattributed",
      crash_cause: "native_crash",
      crash_source: "crash_reporter_dump",
      native_dump_process_role: nativeDumpProcessRole,
    };
    return true;
  });
}

// Bugfix: the product backend may be production while source-run Desktop is still local dev;
// the ARMS env must be marked local by runtime shape first, keeping dev data out of prod.
const armsRumEnv = mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv);

// ARMS user.id is force-rewritten by the SDK (config.user.id is skipped on event merge, not injectable);
// user.name is not. Write device_mid into user.name so RUM logs correlate per device. device_mid
// reuses the telemetry-state.json UUID (same source as the warehouse/preload injection;
// ensureDesktopDeviceMidSync stays idempotent, no duplicate writes).
// Note: renderer events forwarded via ArmsEventBridge are re-packed by the main client under the
// main process config, so one init on main covers main+renderer reporting.
const armsDeviceMid = ensureDesktopDeviceMidSync();

// armsRum.init() returns a Promise; without await, web-contents-created/renderer injection can land
// after the first dom-ready and report nothing. Await armsInitPromise before BrowserWindow creation (see index.ts).
// SDK sendCustom only enqueues; the raw request never checks HTTP status.
// Wrap the transport when installed via the public useReporter at init, keeping SDK filtering/serialization.
const useReporter = armsRum.client.useReporter.bind(armsRum.client);
armsRum.client.useReporter = (reporter) => {
  const request = reporter.request.bind(reporter);
  reporter.request = wrapStartupReporterRequest(request, {
    acknowledged: (eventIds, delivery) =>
      logger.info("[database-startup] telemetry delivery", { eventIds, delivery }),
  });
  useReporter(reporter);
};
function startArmsRum(): Promise<void> {
  return armsRum
    .init({
      enable: true,
      version: ZCODE_VERSION,
      endpoint: ZCODE_ARMS_RUM_ENDPOINT,
      env: armsRumEnv,
      // The browser SDK is injected at dom-ready via executeJavaScript; never init again in preload/renderer (double capture).
      autoInject: true,
      browserCollectors: { ...ARMS_BROWSER_COLLECTORS },
      app: {
        name: runtimeApplicationName,
        version: ZCODE_VERSION,
        env: armsRumEnv,
        type: "electron",
        framework: "react",
      },
      user: {
        name: armsDeviceMid,
      },
      // Session sampling must be 1, else ARMS drops whole-session PV/perf/webvitals (0.1 in dev hides ~90% of page perf).
      sessionConfig: {
        sampleRate: 1,
      },
      // Electron desktop is a single-page file:///dev-server load, no History routing; false keeps full-page-load perf.
      spaMode: false,
      parseViewName: parseArmsViewName,
      collectors: {
        jsError: true,
        consoleError: true,
        crash: true,
        application: true,
        api: true,
        rpc: true,
      },
      // Main-process collectors: Electron side; the renderer side is browserCollectors + autoInject.
      // SDK tracing.sample is 0-100 (percent); 0.1 means 0.1% -- almost never hits.
      tracing: {
        enable: true,
        sample: armsRumEnv === "prod" ? 0.1 : 1,
      },
      // HTTP full-link timings come from the ARMS api batch; ingest in prod and local, local also logs a batch summary.
      beforeReport: (payload: { events?: Array<Record<string, unknown>> }) => {
        // Bugfix: the crash collector scans the shared dump dir, so descendant-process dumps appear too.
        // Keep only native crashes containing this product executable; filtering reads batch metadata, no new IO.
        const events = filterAndEnrichNativeCrashEvents(
          // Local errors with structured lifecycle reports must not be re-captured as console JS exceptions:
          // filter wrapper events by explicit marker, keep real uncaughtException and other console.error.
          (payload?.events ?? []).filter(
            (event) =>
              !(
                event.event_type === "exception" &&
                event.type === "error" &&
                event.source === "console.error" &&
                typeof event.message === "string" &&
                event.message.includes(ZCODE_AGENT_LIFECYCLE_LOG_MARKER)
              ),
          ),
          runtimeApplicationName,
          basename(process.execPath),
        );
        payload.events = events;
        ingestArmsApiEventsFromBatch(events);
        enrichLongTaskAttribution(events);
        // Privacy scrubbing runs after ingest/attribution: network aggregation normalizes interfaces its own way and
        // longTask summaries need raw snapshots; only the final leaving-the-machine copy is redacted.
        redactArmsEventBatch(events);
        if (desktopRuntimeEnv === "development") {
          const perfEvents = events.filter(
            (event) => String(event.type ?? "").toLowerCase() === "perf",
          );
          const summary = events
            .map((event) => {
              const eventType = String(event.event_type ?? "?");
              const subType = String(event.type ?? "");
              const name = String(event.name ?? "");
              if (subType === "perf") {
                return `${eventType}:perf`;
              }
              return `${eventType}:${name || subType || "?"}`;
            })
            .join(", ");
          logger.info(
            `[arms] beforeReport batch=${events.length} perf=${perfEvents.length}${summary ? ` [${summary}]` : ""}`,
          );
        }
        return payload;
      },
    })
    .then(() => {
      logger.info(`[arms] electron initialized env=${armsRumEnv} version=${ZCODE_VERSION}`);
    })
    .catch((error) => {
      logger.error("[arms] electron init failed:", error);
      throw error;
    });
}

// With the master switch off or no endpoint configured, skip SDK init.
export const armsInitPromise: Promise<void> =
  ZCODE_TELEMETRY_ENABLED && ZCODE_ARMS_RUM_ENDPOINT ? startArmsRum() : Promise.resolve();
