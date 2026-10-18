const ASSISTANT_PATH_QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "“": "”",
  "‘": "’",
};
const ASSISTANT_PATH_ENCODED_QUOTE_PAIRS: Readonly<Record<string, string>> = {
  "%22": "%22",
  "%27": "%27",
  "%60": "%60",
  "%E2%80%98": "%E2%80%99",
  "%E2%80%9C": "%E2%80%9D",
};

export function isBalancedAssistantPathQuotePair(opening: string, closing: string): boolean {
  return ASSISTANT_PATH_QUOTE_PAIRS[opening] === closing;
}

export function isAssistantPathQuoteCharacter(character: string | undefined): boolean {
  return (
    character === '"' ||
    character === "'" ||
    character === "`" ||
    character === "“" ||
    character === "”" ||
    character === "‘" ||
    character === "’"
  );
}

/**
 * Only strip paired quotes around a file path; on no match keep the original so unusual model output
 * or quotes inside filenames are never silently rewritten into another path.
 */
export function stripBalancedAssistantPathQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  // rehype-harden may rewrite spaced relative targets to the quoted form; unwrap that layer only
  // when the quoted value is still a relative path, leaving true absolute paths untouched.
  if (trimmed.startsWith("/")) {
    const protectedRelative = stripBalancedAssistantPathQuotes(trimmed.slice(1));
    if (protectedRelative !== trimmed.slice(1)) {
      return protectedRelative.startsWith("./") || protectedRelative.startsWith("/")
        ? protectedRelative
        : `/${protectedRelative}`;
    }
  }

  const relativePrefix = trimmed.startsWith("./") ? "./" : "";
  const candidate = relativePrefix ? trimmed.slice(2) : trimmed;
  if (candidate.length < 2) return trimmed;

  const closingQuote = ASSISTANT_PATH_QUOTE_PAIRS[candidate[0]!];
  if (closingQuote && isBalancedAssistantPathQuotePair(candidate[0]!, candidate.at(-1)!)) {
    return `${relativePrefix}${candidate.slice(1, -1).trim()}`;
  }

  const upperCandidate = candidate.toUpperCase();
  for (const [encodedOpening, encodedClosing] of Object.entries(
    ASSISTANT_PATH_ENCODED_QUOTE_PAIRS,
  )) {
    if (
      upperCandidate.startsWith(encodedOpening) &&
      upperCandidate.endsWith(encodedClosing) &&
      candidate.length > encodedOpening.length + encodedClosing.length
    ) {
      return `${relativePrefix}${candidate.slice(encodedOpening.length, -encodedClosing.length).trim()}`;
    }
  }
  return trimmed;
}
