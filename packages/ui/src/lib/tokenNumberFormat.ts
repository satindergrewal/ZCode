export function formatCompactTokenNumber(
  locale: string,
  value: number,
  options: { maximumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  const maximumFractionDigits = options.maximumFractionDigits ?? 1;
  const absValue = Math.abs(value);

  // Token counts stay locale-aware compact: zh renders CJK myriad-unit scales, en renders K/M/B.
  // A Start Plan English long-unit fix once forced every locale to K/M/B.
  return new Intl.NumberFormat(locale || undefined, {
    notation: absValue >= 1_000 ? "compact" : "standard",
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatModelContextWindowLabel(contextWindow: number, _locale = "en-US"): string {
  // The model list capacity badge is a technical spec; it must not switch to CJK myriad units under zh locale.
  return formatCompactTokenNumber("en-US", contextWindow);
}
