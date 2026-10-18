import { genUiReferenceSchema, type GenUiReference } from "@zcode/shared/gen-ui";
import {
  extractAssistantDirectives,
  findAssistantDirectivePrefixStart,
  findMarkdownCodeRanges,
  findUnclosedAssistantDirectiveStart,
} from "../../lib/assistantDirectiveParser.js";
export type GenUiPart =
  | { kind: "text"; text: string }
  | { kind: "ui"; reference: GenUiReference; offset: number }
  | { kind: "pending" | "invalid" };
interface ReferenceCandidate {
  start: number;
  end: number;
  decode(): unknown;
}
// Reference fields are strings; a complete value may still stop at key/colon/comma.
// Only the JSON-args prefix hides; prose after a missing brace stays visible.
const jsonString = String.raw`"(?:[^"\\\r\n]|\\.)*"`;
const jsonParameterPrefix = new RegExp(
  String.raw`^\s*(?:${jsonString}\s*:\s*${jsonString}\s*,\s*)*(?:${jsonString}(?:\s*:\s*(?:${jsonString})?)?)?\s*$`,
);
export function projectGenUiReferences(text: string, completed: boolean): GenUiPart[] {
  const ranges = findMarkdownCodeRanges(text);
  const parts: GenUiPart[] = [];
  // Real models emit ::visualize even from the Unicode sample; reuse the arg parser,
  // validate uniformly, and keep code-fence/completion/executor rules intact.
  const candidates: ReferenceCandidate[] = extractAssistantDirectives(text, "visualize").map(
    (directive) => ({
      ...directive,
      // Replies keep the skill JSON but prefix ::visualize; the generic directive
      // parses key=value only, so decode JSON here into the same strict schema.
      decode: () =>
        directive.parameters ?? JSON.parse(directive.raw.slice(directive.raw.indexOf("{"))),
    }),
  );
  const unclosed = findUnclosedAssistantDirectiveStart(text, "visualize", ranges, {
    isParameterPrefix: (source) => jsonParameterPrefix.test(source),
  });
  if (unclosed !== null) candidates.push({ start: unclosed, end: text.length, decode: () => null });
  for (const match of text.matchAll(/visualize/gu)) {
    const start = match.index;
    const end = text.indexOf("", start + match[0].length);
    candidates.push({
      start,
      end: end < 0 ? text.length : end + 1,
      decode: () => (end < 0 ? null : JSON.parse(text.slice(start + match[0].length, end))),
    });
  }
  let cursor = 0;
  for (const candidate of candidates.sort((left, right) => left.start - right.start)) {
    const { start, end } = candidate;
    if (ranges.some(([from, to]) => start >= from && start < to) || start < cursor) continue;
    if (start > cursor) parts.push({ kind: "text", text: text.slice(cursor, start) });
    cursor = end;
    if (!completed) {
      parts.push({ kind: "pending" });
      continue;
    }
    try {
      const reference = genUiReferenceSchema.parse(candidate.decode());
      parts.push({ kind: "ui", reference, offset: start });
    } catch {
      parts.push({ kind: "invalid" });
    }
  }
  let tailEnd = text.length;
  if (!completed) {
    const prefix = findAssistantDirectivePrefixStart(text, ["visualize"], ranges);
    if (prefix !== null && prefix >= cursor) tailEnd = prefix;
    const index = text.lastIndexOf("");
    if (
      index >= cursor &&
      !ranges.some(([from, to]) => index >= from && index < to) &&
      "visualize".startsWith(text.slice(index))
    )
      tailEnd = Math.min(tailEnd, index);
  }
  const tail = text.slice(cursor, tailEnd);
  if (tail) parts.push({ kind: "text", text: tail });
  return parts;
}
