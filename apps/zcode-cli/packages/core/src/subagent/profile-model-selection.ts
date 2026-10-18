import { parseSubagentMarkdownSelection, type ModelSelection } from "@zcode/shared";

/** Host and Agent share the canonical Markdown codec; provider migrations must complete at the user-storage boundary first. */
export function resolveProfileModelSelection(
  frontmatter: Record<string, unknown>,
): ModelSelection | undefined {
  return parseSubagentMarkdownSelection(frontmatter);
}
