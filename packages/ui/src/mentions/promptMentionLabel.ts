import type { MentionCategory } from "@/mentions/mentionTypes.js";

function unescapePromptMentionMarkdownText(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && index + 1 < text.length) {
      result += text[index + 1];
      index += 1;
      continue;
    }
    result += text[index];
  }
  return result;
}

function extractPromptMentionMarkdownLabel(text: string): string | null {
  const matched = /^\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)])*))\)$/.exec(
    text.trim(),
  );
  const label = matched?.[1];
  return label ? unescapePromptMentionMarkdownText(label) : null;
}

export function normalizePromptMentionDisplayLabel(
  category: MentionCategory,
  label: string,
  value: string,
): string {
  const markdownLabel = extractPromptMentionMarkdownLabel(label);
  let displayLabel = markdownLabel ?? label;

  if (category === "skills" && displayLabel.startsWith("$")) {
    displayLabel = displayLabel.slice(1);
  } else if (category === "sessions" && displayLabel.startsWith("#")) {
    displayLabel = displayLabel.slice(1);
  } else if (
    (category === "files" ||
      category === "subagents" ||
      category === "whiteboards" ||
      category === "plugins") &&
    displayLabel.startsWith("@")
  ) {
    displayLabel = displayLabel.slice(1);
  }

  // Old draft snapshots may write a full markdown link into the mention node text field.
  // The restored tag keeps its icon but renders the raw [skill](path) text; display takes only the human-readable label,
  // while the markdown field keeps the full original for sending.
  return displayLabel.trim() || value;
}
