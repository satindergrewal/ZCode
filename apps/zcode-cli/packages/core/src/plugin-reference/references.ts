// Strict canonical resolution for plugin chat references.
// Contract:
// - Accepts only Markdown link destinations of the form `plugin://stable-id`; the scheme is case-sensitive (lowercase only).
// - stable-id must be `name@marketplace`, both segments matching [A-Za-z0-9][A-Za-z0-9._-]*, total length <= 256.
// - Reject query, fragment, credentials, whitespace, control chars, and `%` (no implicit percent-decoding).
// - Identity comes from the destination only; the label never participates in parsing.

const PLUGIN_REFERENCE_SCHEME = "plugin://";
// Keeps the link syntax of mentionMarkdown: labels allow \ escapes, destinations allow <...> or the bare form.
const MARKDOWN_LINK_PATTERN = /\[(?:\\.|[^\\\]])*\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)\s])*))\)/g;
const PLUGIN_ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const MAX_PLUGIN_REFERENCES_PER_TURN = 8;
const MAX_PLUGIN_STABLE_ID_LENGTH = 256;

/**
 * Validates whether a candidate is a strictly valid plugin stable ID (`name@marketplace`).
 * Used defensively on both the parser and reminder output sides (fail closed).
 */
export function isValidPluginStableId(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > MAX_PLUGIN_STABLE_ID_LENGTH) {
    return false;
  }
  const separatorIndex = candidate.indexOf("@");
  if (separatorIndex <= 0 || separatorIndex !== candidate.lastIndexOf("@")) {
    return false;
  }
  const name = candidate.slice(0, separatorIndex);
  const marketplace = candidate.slice(separatorIndex + 1);
  // Per-segment charset checks are the entire security boundary: query/fragment/credentials/whitespace/control chars/% all fall
  // outside [A-Za-z0-9._-] and are rejected; no implicit percent-decoding, no lenient matching.
  return PLUGIN_ID_SEGMENT_PATTERN.test(name) && PLUGIN_ID_SEGMENT_PATTERN.test(marketplace);
}

function parsePluginDestination(destination: string): string | null {
  // The scheme is case-sensitive: `Plugin://` and `PLUGIN://` are not accepted.
  if (!destination.startsWith(PLUGIN_REFERENCE_SCHEME)) {
    return null;
  }
  const stableId = destination.slice(PLUGIN_REFERENCE_SCHEME.length);
  if (!isValidPluginStableId(stableId)) {
    return null;
  }
  return stableId;
}

function isPluginSchemeDestination(destination: string): boolean {
  // Count only destinations that intend the plugin scheme as invalid;
  // case variants (Plugin:// etc.) count as intended-but-unparsed so label spoofing cannot dodge the stats.
  return /^plugin:\/\//i.test(destination);
}

export interface ExtractPluginReferencesResult {
  /** References deduped by stable ID, in first-occurrence order. */
  references: string[];
  /** References dropped for exceeding the per-turn cap (fail closed; callers log debug truncated). */
  truncatedCount: number;
  /** Destinations resembling the plugin scheme that failed to parse (format-level rejections before unknown). */
  invalidCount: number;
}

/**
 * Extract plugin references (stable IDs) from canonical user text.
 * Identity comes from the link destination only; the Markdown label never participates.
 */
export function extractPluginReferences(input: string): ExtractPluginReferencesResult {
  const references: string[] = [];
  const seen = new Set<string>();
  let truncatedCount = 0;
  let invalidCount = 0;

  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  for (const match of input.matchAll(MARKDOWN_LINK_PATTERN)) {
    const destination = match[1] ?? match[2] ?? "";
    if (!isPluginSchemeDestination(destination)) {
      continue;
    }
    const stableId = parsePluginDestination(destination);
    if (stableId === null) {
      invalidCount++;
      continue;
    }
    if (seen.has(stableId)) {
      continue;
    }
    if (references.length >= MAX_PLUGIN_REFERENCES_PER_TURN) {
      truncatedCount++;
      continue;
    }
    seen.add(stableId);
    references.push(stableId);
  }

  return { references, truncatedCount, invalidCount };
}
