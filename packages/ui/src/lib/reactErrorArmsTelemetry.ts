import {
  redactTelemetryText,
  type ArmsCustomEventPayload,
  type IPlatformService,
} from "@zcode/shared";
import { logger } from "@/logger.js";

/** ARMS custom event name: renderer exceptions caught by React error boundaries */
export const REACT_ERROR_ARMS_EVENT_NAME = "perf_react_error";
/** ARMS business group */
export const REACT_ERROR_ARMS_GROUP = "react_error";

/**
 * Truncation cap for stack / componentStack.
 * React component and error stacks can get very long, and over-long ARMS fields are truncated or
 * rejected; truncating up front guarantees the critical head (the most recent throwing component) is reported.
 */
export const REACT_ERROR_STACK_MAX_LEN = 4000;

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

let armsReporter: ArmsReporter | null = null;

/**
 * Inject the ARMS reporter.
 *
 * Must run before createRoot in the renderer entry, not in a Root effect: the root-level
 * AppErrorBoundary exists to catch crashes in Root's own render -- if injection waited for a
 * Root effect, a first-frame crash would never run it and root errors would be lost.
 */
export function setReactErrorArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}

export function clearReactErrorArmsReporterForTest(): void {
  armsReporter = null;
}

/**
 * The reported copy must be redacted: on desktop, renderer stack/componentStack carry
 * `file:///Users/<name>/...` paths, and error.message may contain workspace paths or user content.
 * Shares `redactTelemetryText` with ARMS auto-collected exception events; local logs and fallback
 * recovery keep the originals. Truncation keeps the 4000 cap so the latest throwing frame survives.
 */
function redactStack(value: string): string {
  return redactTelemetryText(value, { maxLength: REACT_ERROR_STACK_MAX_LEN });
}

function buildReactErrorArmsPayload(params: {
  error: Error;
  componentStack: string;
  scope?: string;
}): ArmsCustomEventPayload {
  const errorStack = params.error.stack ? redactStack(params.error.stack) : undefined;
  const componentStack = params.componentStack ? redactStack(params.componentStack) : undefined;
  return {
    name: REACT_ERROR_ARMS_EVENT_NAME,
    group: REACT_ERROR_ARMS_GROUP,
    value: 1,
    properties: {
      error_name: params.error.name,
      error_message: redactTelemetryText(params.error.message),
      error_stack: errorStack || undefined,
      component_stack: componentStack || undefined,
      // Root-level boundaries have no scope; record them as app. Scoped boundaries use their own scope (sidebar/chat/settings/...).
      boundary_scope: params.scope ?? "app",
    },
  };
}

/**
 * Report exceptions caught by React error boundaries to ARMS RUM.
 *
 * Background: error boundaries intercept subtree render errors and stop them from reaching
 * window.onerror, while the Browser RUM SDK relies on window.onerror / unhandledrejection --
 * so boundary-caught errors are invisible to RUM by default and only surface in local logs.
 * Forward them here over the same ARMS custom-event lane as perf_crash to close that blind spot.
 */
export function reportReactErrorToArms(params: {
  error: Error;
  componentStack: string;
  scope?: string;
}): void {
  if (!armsReporter) {
    return;
  }

  try {
    const payload = buildReactErrorArmsPayload(params);
    void Promise.resolve(armsReporter.reportArmsCustomEvent(payload)).catch((error) => {
      // ARMS is observability-only: the boundary's fallback recovery must never break over telemetry.
      logger.warn("[react-error] ARMS custom event report failed", {
        scope: params.scope ?? "app",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("[react-error] ARMS custom event report threw", {
      scope: params.scope ?? "app",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
