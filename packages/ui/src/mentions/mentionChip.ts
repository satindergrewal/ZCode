import type { MentionCategory } from "@/mentions/mentionTypes.js";

export const PROMPT_MENTION_BASE_CLASS_NAME =
  // align-middle on an inline-flex token aligns to the parent text baseline + x-height, not the line-box visual center.
  // Body text typed after a token sits ~1px lower; align-top lets a same-line-height token share the line-box top with body text.
  "inline-flex cursor-default items-center gap-1 align-top text-ui-base leading-5 font-medium";

export function getPromptMentionVariantClassName(category: MentionCategory): string {
  if (category === "skills") {
    return "text-skill-node-foreground";
  }
  if (category === "subagents") {
    return "text-subagent-node-foreground";
  }
  if (category === "commands") {
    return "text-command-node-foreground capitalize";
  }
  if (category === "sessions") {
    return "text-session-node-foreground";
  }
  if (category === "plugins") {
    return "text-plugin-node-foreground";
  }
  if (category === "whiteboards") {
    return "text-file-node-foreground";
  }
  return "text-file-node-foreground";
}
