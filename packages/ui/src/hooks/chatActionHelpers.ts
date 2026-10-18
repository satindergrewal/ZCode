import type { ZCodeConfigOption, ZCodeProvider, ZCodeTaskMode } from "@zcode/shared";

const ZCODE_TASK_MODE_VALUES: readonly ZCodeTaskMode[] = [
  "default",
  "yolo",
  "guarded",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
];

const ZCODE_TASK_MODE_SET = new Set<string>(ZCODE_TASK_MODE_VALUES);

function normalizeZCodeModeForTaskCreation(
  modeId: string,
  _provider?: ZCodeProvider,
): ZCodeTaskMode | undefined {
  if (ZCODE_TASK_MODE_SET.has(modeId)) {
    return modeId as ZCodeTaskMode;
  }

  switch (modeId) {
    case "full-access":
    case "full_access":
      return "bypassPermissions";
    case "read-only":
    case "read_only":
      return "plan";
    case "auto-edit":
    case "auto_edit":
    case "accept-edits":
    case "accept_edits":
      return "acceptEdits";
    case "full-auto":
    case "full_auto":
      return "yolo";
    default:
      return undefined;
  }
}

function stringifyUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Bugfix: errors may carry cycles; fall back to String on JSON failure, never throw anew.
  }

  return String(value);
}

// Bugfix: agent failures may throw plain objects, not Errors.
// String(err) yields [object Object], losing the message in UI and logs.
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || String(err);
  }

  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    const normalizedMessage = stringifyUnknownValue(message);
    if (normalizedMessage !== "undefined" && normalizedMessage.length > 0) {
      return normalizedMessage;
    }
  }

  return stringifyUnknownValue(err);
}

export function readCurrentZCodeMode(
  options: readonly ZCodeConfigOption[],
  provider?: ZCodeProvider,
): ZCodeTaskMode | undefined {
  const modeOption = options.find(
    (option) => option.category === "mode" && option.type === "select",
  );
  const currentValue = modeOption?.currentValue;
  if (typeof currentValue !== "string") {
    return undefined;
  }

  // Bugfix: whitelisting local modes dropped provider-native ones at first session;
  // normalize so the UI choice matches the real agent session mode.
  return normalizeZCodeModeForTaskCreation(currentValue, provider);
}
