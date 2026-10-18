import { redactTelemetryText, redactTelemetryUrl } from "@zcode/shared";

/**
 * * Redaction gate for ARMS auto-collected events before they leave the machine.
 *
 * Collectors choose fields; raw content can carry UI text (click), local paths and stacks
 * (exception), and full URLs (api/resource). appARMSBootstrap.beforeReport is the only pre-report
 * point to rewrite whole batches, so the rules live here, not in per-collector config.
 *
 * * Redaction touches only the reporting
 * copy: network aggregation ingested earlier; local logs, error surfaces, and crash archives keep originals.
 */

//** exception message cap: matches the 2000-char console normalization used in the dependency patch. */
const EXCEPTION_MESSAGE_MAX_LENGTH = 2_000;

/** stack/snapshots cap: recent throw frames always survive without shipping whole bodies to ARMS. */
const EXCEPTION_STACK_MAX_LENGTH = 4_000;

/**
 * Browser SDK click names look like click on <type-><tag>: <first 20 chars of innerText>....
 * Keep through the tag; after ": " comes element text, possibly session titles, filenames, or message bodies.
 */
const CLICK_NAME_PATTERN = /^(click on [a-z0-9-]+)(?::[\s\S]*)?$/iu;

/** Unexpected name shapes collapse to fixed buckets: still countable, content-free. */
const CLICK_NAME_FALLBACK = "click";

function isClickEvent(event: Record<string, unknown>): boolean {
  return event.event_type === "click" || event.type === "click";
}

function isExceptionEvent(event: Record<string, unknown>): boolean {
  return event.event_type === "exception";
}

function isNativeDumpEvent(event: Record<string, unknown>): boolean {
  // Native dumps come parsed from the crash collector; binary_images/threads are structured forensics, and
  // filterAndEnrichNativeCrashEvents needs binary_images to spot product binaries, so leave them untouched here.
  return event.type === "crash" && event.source === "crashReporter";
}

function isResourceEvent(event: Record<string, unknown>): boolean {
  const eventType = String(event.event_type ?? "").toLowerCase();
  return eventType === "api" || eventType === "resource" || eventType.includes("resource");
}

function redactTextField(event: Record<string, unknown>, key: string, maxLength: number): void {
  const value = event[key];
  if (typeof value !== "string" || !value) {
    return;
  }
  event[key] = redactTelemetryText(value, { maxLength });
}

function redactUrlField(event: Record<string, unknown>, key: string): void {
  const value = event[key];
  if (typeof value !== "string" || !value) {
    return;
  }
  event[key] = redactTelemetryUrl(value);
}

function redactClickEvent(event: Record<string, unknown>): void {
  const name = event.name;
  event.name =
    typeof name === "string"
      ? (CLICK_NAME_PATTERN.exec(name)?.[1] ?? CLICK_NAME_FALLBACK)
      : CLICK_NAME_FALLBACK;
  // snapshot href/src can be local paths; id/className add no diagnostic value.
  delete event.snapshots;
}

function redactExceptionEvent(event: Record<string, unknown>): void {
  if (isNativeDumpEvent(event)) {
    return;
  }
  redactTextField(event, "message", EXCEPTION_MESSAGE_MAX_LENGTH);
  redactTextField(event, "stack", EXCEPTION_STACK_MAX_LENGTH);
  // Bugfix: the jsError collector copies ErrorEvent.filename into file; on Windows installs scripts live under
  // C:\\Users\\<user>\\AppData\\...; apply the stack rules, leaving line/column structured fields alone.
  redactTextField(event, "file", EXCEPTION_MESSAGE_MAX_LENGTH);
  redactTextField(event, "snapshots", EXCEPTION_STACK_MAX_LENGTH);
}

function redactResourceEvent(event: Record<string, unknown>): void {
  redactUrlField(event, "url");
  redactUrlField(event, "name");
  redactTextField(event, "message", EXCEPTION_MESSAGE_MAX_LENGTH);
}

/**
 * Redacts the auto-collected batch in place and returns it for chaining inside beforeReport.
 *
 * Only click/exception/api-resource auto events; custom events (perf_* etc.) are redacted at
 * construction, never re-written here, so no field survives two rule sets and loses readability.
 */
export function redactArmsEventBatch(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }
    if (isClickEvent(event)) {
      redactClickEvent(event);
      continue;
    }
    if (isExceptionEvent(event)) {
      redactExceptionEvent(event);
      continue;
    }
    if (isResourceEvent(event)) {
      redactResourceEvent(event);
    }
  }
  return events;
}
