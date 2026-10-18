import { formatPluginDisplayName } from "./pluginDisplayName.js";
import type { PluginUiImageBlock } from "./pluginUiImageBlocks.js";

/**
 * Next-turn model context attached by plugin UI via ui/update-model-context.
 * Isomorphic to code references/web elements: lives only in composer drafts and the prompt tail block, never protocol fields; user-visible and removable.
 */
export interface PluginUiModelContext {
  id: string;
  sessionId: string;
  pluginId: string;
  toolCallId: string;
  text: string;
  structuredContent?: unknown;
  /**
   * Image blocks skip the prompt tail; the composer turns them into attachments under this context for the next turn;
   * a repeat updateModelContext on the same instance replaces them too.
   */
  images?: readonly PluginUiImageBlock[];
}

export const PLUGIN_UI_MODEL_CONTEXT_BLOCK_TITLE = "# Plugin context:";
/** Per-entry text cap; truncate with ellipsis so a plugin cannot stuff a whole page into the prompt. */
export const PLUGIN_UI_MODEL_CONTEXT_MAX_CHARS = 16 * 1024;

const ITEM_HEADER = /^## Plugin (\S+) \(([^)]+)\)\s*$/m;

function truncateText(text: string): string {
  return text.length > PLUGIN_UI_MODEL_CONTEXT_MAX_CHARS
    ? `${text.slice(0, PLUGIN_UI_MODEL_CONTEXT_MAX_CHARS)}…`
    : text;
}

function buildItem(context: PluginUiModelContext): string {
  const lines = [
    `## Plugin ${context.pluginId} (${context.toolCallId})`,
    "",
    truncateText(context.text),
  ];
  if (context.structuredContent !== undefined) {
    lines.push("", "```json", JSON.stringify(context.structuredContent, null, 2), "```");
  }
  return lines.join("\n");
}

export function buildPromptWithPluginUiContexts(
  text: string,
  contexts: readonly PluginUiModelContext[],
): string {
  const content = text.trimEnd();
  if (contexts.length === 0) return content.trim();
  const block = `${PLUGIN_UI_MODEL_CONTEXT_BLOCK_TITLE}\n\n${contexts.map(buildItem).join("\n\n")}`;
  return `${content}${content ? "\n\n" : ""}${block}`.trim();
}

export interface ParsedPluginUiContextPrompt {
  visibleContent: string;
  pluginUiContexts: PluginUiModelContext[];
}

function parseItem(raw: string, index: number): PluginUiModelContext | null {
  const header = ITEM_HEADER.exec(raw);
  if (!header) return null;
  const pluginId = header[1] ?? "";
  const toolCallId = header[2] ?? "";
  if (!pluginId || !toolCallId) return null;
  let body = raw.slice(header.index + header[0].length).trim();
  let structuredContent: unknown;
  const fence = /\n?```json\n([\s\S]*?)\n```\s*$/.exec(body);
  if (fence) {
    try {
      structuredContent = JSON.parse(fence[1] ?? "");
      body = body.slice(0, fence.index).trim();
    } catch {
      // Keep invalid JSON as body text.
    }
  }
  return {
    id: `plugin-ui-context:${toolCallId}:${index}`,
    sessionId: "",
    pluginId,
    toolCallId,
    text: body,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

/** Only the prompt tail block parses; like the other four kinds, serialization and parse orders are exact inverses. */
export function parsePromptPluginUiContexts(content: string): ParsedPluginUiContextPrompt {
  const match = /(?:^|\n\n)# Plugin context:\s*\n\n([\s\S]*?)\s*$/.exec(content);
  if (!match || match[1] === undefined) return { visibleContent: content, pluginUiContexts: [] };
  const items = match[1]
    .split(/\n(?=## Plugin \S+ \([^)]+\)\s*\n)/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseItem)
    .filter((item): item is PluginUiModelContext => item !== null);
  if (items.length === 0) return { visibleContent: content, pluginUiContexts: [] };
  return {
    visibleContent: content.slice(0, match.index).trimEnd(),
    pluginUiContexts: items,
  };
}

export function formatPluginUiContextLabel(context: PluginUiModelContext): string {
  return formatPluginDisplayName(context.pluginId);
}
