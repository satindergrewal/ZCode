/**
 * Number/time formatting for the observation workflow tool cards (shared by GetWorkflowRun and ListWorkflowRuns).
 * Pure functions, no i18n dependency: numbers and times use the Intl default locale; only copy comes from message tables.
 */

export function formatWorkflowTokenCount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) < 1_000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) {
    return `${trimTrailingZero((value / 1_000).toFixed(1))}k`;
  }
  return `${trimTrailingZero((value / 1_000_000).toFixed(1))}M`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

const SHORT_TIMESTAMP_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Short timestamp for list rows: dense rows keep only month-day + hour:minute. */
export function formatWorkflowTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return String(epochMs);
  return SHORT_TIMESTAMP_FORMAT.format(new Date(epochMs));
}

const DURATION_MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * `40s` / `5m 10s` / `2h 15m` / `3d 2h`: the wording for every duration and age in the situation view.
 *
 * Deliberately character-identical to the GetWorkflowRun model-facing `formatWorkflowRunDuration`
 * (apps/zcode-cli/packages/core/src/tool/handlers/workflow-run-introspection.ts): for the same
 * number in the same snapshot, what the model reads and what the card draws must not diverge.
 */
export function formatWorkflowDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (total < DURATION_MS.minute) return `${Math.floor(total / DURATION_MS.second)}s`;
  if (total < DURATION_MS.hour) {
    const minutes = Math.floor(total / DURATION_MS.minute);
    return `${minutes}m ${padTwo(Math.floor((total % DURATION_MS.minute) / DURATION_MS.second))}s`;
  }
  if (total < DURATION_MS.day) {
    const hours = Math.floor(total / DURATION_MS.hour);
    return `${hours}h ${padTwo(Math.floor((total % DURATION_MS.hour) / DURATION_MS.minute))}m`;
  }
  const days = Math.floor(total / DURATION_MS.day);
  return `${days}d ${Math.floor((total % DURATION_MS.day) / DURATION_MS.hour)}h`;
}

/**
 * Bare "how long ago" duration (the "ago" suffix is assembled from the message table).
 *
 * The baseline is the snapshot's `generatedAt`, **not** `Date.now()`: reopening a three-day-old
 * transcript must still show the age at that time, or the same card drifts on every re-render.
 * Return `undefined` when either timestamp is missing -- readers omit the age entirely rather than
 * paper over an unknown with 0 or "unknown".
 */
export function formatWorkflowAge(
  generatedAt: number | undefined,
  at: number | undefined,
): string | undefined {
  if (generatedAt === undefined || at === undefined) return undefined;
  if (!Number.isFinite(generatedAt) || !Number.isFinite(at)) return undefined;
  return formatWorkflowDuration(generatedAt - at);
}
