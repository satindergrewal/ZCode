import {
  findMarkdownCodeRanges,
  overlapsAssistantTextRanges,
  type AssistantTextRange,
} from "@/lib/assistantDirectiveParser.js";
import { extractZCodeFileCitationDirectives } from "@/lib/zcodeFileCitation.js";

function resolveCitationFileName(path: string): string {
  const normalizedPath = path.trim().replaceAll("\\", "/");
  return normalizedPath.split("/").at(-1) ?? normalizedPath;
}

/**
 * `![alt](dest ...)` image syntax. dest may be `<...>`-wrapped (spaces allowed) or a bare URL;
 * a trailing title is kept verbatim - only the leading `!` is removed, no other byte changes.
 */
const markdownImagePattern = /!(\[[^\]]*\]\((?:<[^>\n]*>|[^)\s]*)(?:[^)\n]*)\))/gu;

/** Image destinations that make a visitor browser hit third parties: absolute http(s) and scheme-relative `//host`. */
function isRemoteImageDestination(destination: string): boolean {
  const trimmed = destination.trim().replace(/^<|>$/gu, "");
  return /^(?:https?:)?\/\//iu.test(trimmed);
}

function readImageDestination(imageSyntax: string): string {
  // imageSyntax looks like `[alt](dest "title")`; take from the first `(` to the first blank/end.
  const open = imageSyntax.indexOf("(");
  const inner = imageSyntax.slice(open + 1, -1);
  if (inner.startsWith("<")) return inner.slice(0, inner.indexOf(">") + 1);
  const whitespace = inner.search(/\s/u);
  return whitespace < 0 ? inner : inner.slice(0, whitespace);
}

/**
 * Degrades remote images to plain links.
 *
 * The public share page (ConversationShareReadonlyTimeline) passes no workspacePath /
 * sessionId / readAttachment, so MarkdownImage falls back to `displaySrc = resolvedSrc`
 * and renders `<img src={remote} loading="lazy">`: any anonymous visitor silently fires requests to
 * publisher-chosen third parties on load, leaking IP / UA / Referer - a publisher-controlled tracking
 * pixel. This streamdown build has no allowedImagePrefixes (linkSafety is off too),
 * so strip at the only public-projection choke point: `![alt](url)` -> `[alt](url)`;
 * no auto requests, nothing lost, load on click, effective for already-published shares.
 * Only http(s) and scheme-relative: data: hits no network; relative paths stay same-origin.
 */
function degradeRemoteImages(
  markdown: string,
  protectedRanges: readonly AssistantTextRange[],
): string {
  const matches = [...markdown.matchAll(markdownImagePattern)].filter(
    (match) =>
      !overlapsAssistantTextRanges(match.index, match.index + match[0].length, protectedRanges) &&
      isRemoteImageDestination(readImageDestination(match[1]!)),
  );
  let result = markdown;
  // Replace back-to-front so earlier rewrites never invalidate later indices.
  for (const match of matches.reverse()) {
    result = `${result.slice(0, match.index)}${match[1]!}${result.slice(match.index + match[0].length)}`;
  }
  return result;
}

/**
 * Share bodies must not hand local citation directives to MessageResponse: they leak paths and
 * would be interpreted as file ops under workspace authority. The public projection keeps only the uniquely
 * matched artifact display name; protocol examples inside code fences stay parser-protected and verbatim.
 *
 * Also strips remote-image auto-loading, see degradeRemoteImages.
 */
export function normalizeConversationShareMarkdown(
  markdown: string,
  artifactNames: ReadonlyMap<string, string> = new Map(),
): string {
  const protectedRanges = findMarkdownCodeRanges(markdown);
  const directives = extractZCodeFileCitationDirectives(markdown).filter(
    (directive) => !overlapsAssistantTextRanges(directive.start, directive.end, protectedRanges),
  );

  let result = markdown;
  for (const directive of [...directives].reverse()) {
    const fileName = directive.path ? resolveCitationFileName(directive.path) : "";
    const candidates = [...artifactNames.values()].filter(
      (displayName) => displayName.trim().toLowerCase() === fileName.toLowerCase(),
    );
    const replacement = candidates.length === 1 ? candidates[0]!.trim() : "";
    result = `${result.slice(0, directive.start)}${replacement}${result.slice(directive.end)}`;
  }
  // Citation stripping only shortens the body and adds no image syntax, but code-fence ranges can shift left,
  // so recompute protected ranges on the rewritten body before degrading images.
  return degradeRemoteImages(result, findMarkdownCodeRanges(result));
}
