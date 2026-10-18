import type { McpAppsContentBlock } from "./hostContract.js";

/** Concatenates text blocks into one plain string; non-text blocks are skipped. */
export function concatMcpAppsTextContent(content: readonly McpAppsContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}
