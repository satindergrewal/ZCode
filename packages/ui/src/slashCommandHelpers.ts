/**
 * slashCommandHelpers — pure helpers for SlashCommandPlugin.tsx
 */
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import type { AgentSummary, Locale, SkillSummary, ZCodeSlashCommand } from "@zcode/shared";
import type { MentionItem } from "@/mentions/mentionTypes.js";
import { mapSubagentsToMentionItemsForTest } from "@/mentions/providers/subagentsMentionProvider.js";
import { mapSkillsToMentionItemsForTest } from "@/mentions/providers/skillsMentionProvider.js";
import {
  extractActivePromptInputTrigger,
  getActivePromptInputTokenTailLength,
} from "./lib/promptInputTriggers.js";
import type { PromptInputSuggestionItem } from "./lib/promptInputTriggers.js";

export interface SlashCommandPluginProps {
  container?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** Existing session id; null/undefined means a new draft. Decides Skill catalog authority. */
  sessionId?: string | null;
  disabled?: boolean;
  excludedCommandNames?: readonly string[];
  /**
   * App-level local commands (e.g. `/side`). The CLI catalog stays authoritative; the renderer
   * may only append "select to run a UI action" commands — never sent, never written back to
   * the CLI command list.
   */
  appCommands?: readonly AppSlashCommand[];
}

/** App-level slash command: selecting it runs a UI action (no mention inserted, nothing sent). */
export interface AppSlashCommand {
  /** Command value without the `/`, e.g. "side". */
  value: string;
  /** Localized description, shown verbatim in the `/` panel. */
  description: string;
  /** Extra search keywords; should include both English and Chinese aliases so either input matches. */
  keywords?: readonly string[];
  /** UI action run as soon as the command is selected. */
  run: () => void;
}

const APP_SLASH_SUGGESTION_ID_PREFIX = "app-slash:";

export function buildAppSlashCommandSuggestions(
  commands: readonly AppSlashCommand[],
): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.value);
    if (!value) {
      return [];
    }
    return [
      {
        id: `${APP_SLASH_SUGGESTION_ID_PREFIX}${value}`,
        trigger: "/",
        value,
        label: `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.description, ...(command.keywords ?? [])])],
      },
    ];
  });
}

export function isAppSlashCommandSuggestion(suggestion: PromptInputSuggestionItem): boolean {
  return suggestion.id.startsWith(APP_SLASH_SUGGESTION_ID_PREFIX);
}

/**
 * `/side` gating: a draft has no parent session to attach a child to, and a side chat cannot
 * nest another side chat; read-only and mobile viewport hide it, matching the fixed entry.
 */
export function shouldOfferSideSlashCommand(options: {
  isDraft: boolean;
  selectionSideChat: boolean;
  readOnly: boolean;
  isMobileViewport: boolean;
}): boolean {
  return (
    !options.isDraft && !options.selectionSideChat && !options.readOnly && !options.isMobileViewport
  );
}

export function normalizeSlashCommandValue(name: string): string {
  // The remote agent may return "/init" as the command name. Strip the leading slash for the
  // UI value, otherwise markdown insertion yields "//init" and / panel matching breaks.
  return name.trim().replace(/^\/+/, "");
}

export function buildSlashSuggestions(commands: ZCodeSlashCommand[]): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.name);
    // The UI used to keep a builtin allowlist, a GLM `/goal` fallback and a v4 append-list, so a
    // missing CLI catalog still showed partial commands and hid missing `/init`/custom commands.
    // Discovery now treats the CLI protocol catalog as the single authority; the UI appends nothing.
    if (!value) {
      return [];
    }
    return [
      {
        id: `slash:${value}`,
        trigger: "/",
        value,
        label: command.inputHint?.trim() || `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.name, command.description, command.inputHint ?? ""])],
      },
    ];
  });
}

export function buildSubagentSuggestions(
  agents: Array<
    Pick<
      AgentSummary,
      "id" | "name" | "description" | "path" | "scope" | "source" | "enabled" | "modelSelection"
    >
  >,
): PromptInputSuggestionItem[] {
  return mapSubagentsToMentionItemsForTest(agents).map((item) =>
    mapSubagentMentionItemToSuggestion(item),
  );
}

export function buildSkillSuggestions(
  skills: Array<
    Pick<SkillSummary, "id" | "name" | "description" | "path" | "scope" | "pluginName">
  >,
  locale?: Locale,
): PromptInputSuggestionItem[] {
  return mapSkillsToMentionItemsForTest(skills, locale).map((item) => ({
    id: item.id,
    trigger: "/",
    value: item.value,
    label: `$${item.value}`,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "skill", "skills", item.value])],
    data: item.data,
  }));
}

function mapSubagentMentionItemToSuggestion(item: MentionItem): PromptInputSuggestionItem {
  return {
    id: item.id,
    trigger: "/",
    value: item.value,
    label: item.label,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "subagent", "agent"])],
    data: item.data,
  };
}

export function replaceActiveSlashToken(
  textBeforeCursor: string,
  textAfterCursor: string,
  replacementToken: string,
) {
  const activeTrigger = extractActivePromptInputTrigger(textBeforeCursor);
  if (!activeTrigger || activeTrigger.trigger !== "/") {
    return null;
  }

  const tokenStart = textBeforeCursor.length - activeTrigger.query.length - 1;
  const tailLength = getActivePromptInputTokenTailLength(
    activeTrigger,
    textAfterCursor,
    replacementToken,
  );
  const prefix = textBeforeCursor.slice(0, tokenStart);
  const suffix = textAfterCursor.slice(tailLength);
  return {
    cursorOffset: prefix.length + replacementToken.length + 1,
    text: `${prefix}${replacementToken} ${suffix}`,
  };
}

export function getTextAroundCursor() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }

  const anchor = selection.anchor;
  if (anchor.type !== "text") {
    return {
      textAfterCursor: "",
      textBeforeCursor: $getRoot().getTextContent(),
    };
  }

  const node = anchor.getNode();
  if (!$isTextNode(node)) {
    return null;
  }

  const textContent = node.getTextContent();
  return {
    textAfterCursor: textContent.slice(anchor.offset),
    textBeforeCursor: textContent.slice(0, anchor.offset),
  };
}
