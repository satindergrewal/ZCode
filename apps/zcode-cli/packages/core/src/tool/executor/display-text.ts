/**
 * Byte-bound helper for display text. Split from result-display.ts: observation-style workflow display builders
 * (workflow-observation-display.ts) share one truncation semantics with legacy payload building, but the two
 * files importing each other would cycle; the helper lives in a third place both may depend on.
 */

const DISPLAY_TRUNCATION_SUFFIX = "\n...[truncated]";

export function boundDisplayText(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }

  const suffixBytes = Buffer.byteLength(DISPLAY_TRUNCATION_SUFFIX, "utf8");
  const prefix = fitUtf8Prefix(value, maxBytes - suffixBytes);
  return {
    value: `${prefix}${DISPLAY_TRUNCATION_SUFFIX}`,
    truncated: true,
  };
}

function fitUtf8Prefix(value: string, maxBytes: number): string {
  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = codePoints.slice(0, mid).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return codePoints.slice(0, low).join("");
}
