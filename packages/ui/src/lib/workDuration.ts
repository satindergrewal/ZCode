/**
 * The "worked for 1m 42s" duration copy (`chat.history.workedFor`), extracted from
 * `ConversationTurnGroup` so the workflow completion card's time cell and the turn-header
 * collapse label render identically: the same duration must look the same in both places.
 *
 * Rules: seconds round to nearest, minimum 1s; among day/hour/minute/second only non-zero
 * units render, **at most two segments** (`1h 3m`, no seconds); abbreviated units hug the
 * number, CJK unit words get a leading space.
 */
type FormatMessage = (descriptor: { id: string }) => string;

interface WorkDurationPart {
  value: number;
  /** Localized unit word (abbreviated or CJK, per locale). */
  unit: string;
}

const UNIT_IDS = {
  day: "chat.history.duration.day",
  hour: "chat.history.duration.hour",
  minute: "chat.history.duration.minute",
  second: "chat.history.duration.second",
} as const;

/** Split into `[{value, unit}]` for layouts that separate number and unit (the completion card's big digits). */
export function workDurationParts(
  durationMs: number,
  formatMessage: FormatMessage,
): WorkDurationPart[] {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: WorkDurationPart[] = [];
  if (days > 0) parts.push({ value: days, unit: formatMessage({ id: UNIT_IDS.day }) });
  if (hours > 0) parts.push({ value: hours, unit: formatMessage({ id: UNIT_IDS.hour }) });
  if (minutes > 0) parts.push({ value: minutes, unit: formatMessage({ id: UNIT_IDS.minute }) });
  if (seconds > 0 || parts.length === 0) {
    parts.push({ value: seconds, unit: formatMessage({ id: UNIT_IDS.second }) });
  }
  return parts.slice(0, 2);
}

/** Keep a space between CJK duration units and the number for readability; abbreviated units hug the number. */
export function workDurationUnitSeparator(locale: string): string {
  return locale === "zh-CN" ? " " : "";
}
