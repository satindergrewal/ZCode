import type { Plugin } from "unified";

interface MarkdownPoint {
  offset?: number;
}

interface MarkdownNode {
  children?: MarkdownNode[];
  position?: { end?: MarkdownPoint; start?: MarkdownPoint };
  title?: string | null;
  type: string;
  url?: string;
}

// Drive-letter absolute paths and UNC paths. Only those fall back to the raw source slice; plain URLs never enter this plugin's rewrite path.
// UNC here only requires a single leading backslash: in source `\\host` the `\\` is itself a
// punctuation escape, leaving one backslash after parsing -- requiring two would miss every UNC that needs recovery.
const windowsDestinationPattern = /^(?:[a-zA-Z]:[\\/]|\\)/u;

// CommonMark: `\X` in a link destination produces X only when X is ASCII punctuation; anything else stays literal.
// The four ranges !-/, :-@, [-`, {-~ are exactly all ASCII punctuation.
const punctuationEscapePattern = /\\([!-/:-@[-`{-~])/gu;

function unescapeCommonMarkPunctuation(raw: string): string {
  return raw.replace(punctuationEscapePattern, "$1");
}

/**
 * Slice the raw destination text by node shape.
 *
 * - Inline `link` / `image`: `[label](dest)` / `![alt](dest)`; take the span before the closing `)`.
 *   Windows paths contain no `](`, so taking the last separator is safe inside the gate; brackets
 *   inside label/alt then cannot skew the slice.
 * - `definition`: `[ref]: dest`; take the span after `]:`. Reference-style URL comes from the
 *   definition, where the same escape loss occurs, so it must be recovered too.
 */
function extractRawDestination(node: MarkdownNode, slice: string): string | null {
  if (node.type === "definition") {
    const marker = slice.indexOf("]:");
    return marker < 0 ? null : slice.slice(marker + 2).trim();
  }

  if (!slice.endsWith(")")) return null;
  const marker = slice.lastIndexOf("](");
  return marker < 0 ? null : slice.slice(marker + 2, -1).trim();
}

/**
 * Recover the node's un-unescapeable destination from the VFile source.
 *
 * `[x](C:\Users\developer\.zcode\a.png)` already loses `\.` to punctuation-escape handling during
 * remark-parse (`\U` `\z` `\w` survive because the next char is not punctuation), so mdast sees
 * `C:\Users\developer.zcode\a.png`. The loss happens at parse time; the existing rehype rewrite
 * plugins only see the already-mangled string and cannot recover it -- hence this remark stage.
 *
 * Only when "source unescaped per CommonMark equals node.url exactly" is the slice considered
 * correct and the recovery unambiguous; otherwise keep the status quo rather than write a maybe-wrong path.
 */
function recoverRawDestination(node: MarkdownNode, source: string): string | null {
  const url = node.url;
  if (typeof url !== "string" || !windowsDestinationPattern.test(url)) return null;
  // Titles need quote-syntax parsing to locate the destination end; a wrong slice would count the
  // quotes into the path. That case does not occur here, so just skip recovery.
  if (node.title !== null && node.title !== undefined) return null;

  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return null;

  const raw = extractRawDestination(node, source.slice(start, end));
  // Angle-bracket destinations follow different escape rules; skip recovery for them too.
  if (raw === null || !raw || raw.startsWith("<") || raw === url) return null;
  if (unescapeCommonMarkPunctuation(raw) !== url) return null;

  return raw;
}

export const windowsFileLinkEscapeRemarkPlugin: Plugin =
  function windowsFileLinkEscapeRemarkPlugin() {
    return (tree: unknown, file: unknown) => {
      const source = String(file ?? "");
      if (!source) return;

      const visit = (node: MarkdownNode): void => {
        if (node.type === "link" || node.type === "image" || node.type === "definition") {
          const raw = recoverRawDestination(node, source);
          if (raw !== null) node.url = raw;
        }

        node.children?.forEach(visit);
      };

      visit(tree as MarkdownNode);
    };
  };
