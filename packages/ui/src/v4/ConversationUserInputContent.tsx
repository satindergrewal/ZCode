import { memo, useState } from "react";
import {
  Bot,
  Cable,
  GoalIcon,
  MessagesSquare,
  ScrollText,
  SquareSlash,
  WandSparkles,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { isTrustedPluginIconSource } from "@/lib/pluginIconSource.js";
import { usePluginReferenceIconProjection } from "@/v4/pluginReferenceIconContext.js";
import {
  getPromptMentionVariantClassName,
  PROMPT_MENTION_BASE_CLASS_NAME,
} from "@/mentions/mentionChip.js";
import {
  formatSkillMentionDisplayLabel,
  parseMentionMarkdown,
} from "@/mentions/mentionMarkdown.js";
import { parseV4VisibleSlashCommand } from "@/v4/slashCommands.js";

const GOAL_QUERY_TOKEN_PATTERN = /^(\s*)(\/(?:goal|target))(?=\s|$)([\s\S]*)$/i;
const EMPTY_ATTACHMENTS: readonly unknown[] = [];

export interface V4UserInputGoalQueryDisplay {
  leadingText: string;
  commandText: string;
  trailingText: string;
}

/**
 * Parse only the goal query the send entry consumes; plain bodies and same-name text with attachments stay untouched.
 * Reason: user-message rendering must not re-guess command intent from a bare `/goal` occurrence, or context prompts
 * with hidden attachment blocks get misrendered as goal control commands.
 */
export function parseV4UserInputGoalQuery(
  text: string,
  attachments: readonly unknown[] = EMPTY_ATTACHMENTS,
  contextAttachmentCount = 0,
): V4UserInputGoalQueryDisplay | null {
  const command = parseV4VisibleSlashCommand(text, attachments, {
    contextAttachmentCount,
  });
  if (!command || command.kind === "compact") return null;

  const match = GOAL_QUERY_TOKEN_PATTERN.exec(text);
  if (!match) return null;
  return {
    leadingText: match[1] ?? "",
    commandText: match[2] ?? "",
    trailingText: match[3] ?? "",
  };
}

type V4UserInputMentionPart = ReturnType<typeof parseMentionMarkdown>[number];

function normalizeCommandMentionLabel(label: string): string {
  return label.trim().replace(/^\/+/, "").toLowerCase();
}

function mentionClassName(category: Parameters<typeof getPromptMentionVariantClassName>[0]) {
  return cn(
    "mx-0.5 max-w-full",
    PROMPT_MENTION_BASE_CLASS_NAME,
    // The userInput body uses text-ui-base, consistent with assistant message bodies.
    "text-ui-base leading-6",
    getPromptMentionVariantClassName(category),
  );
}

function V4UserInputMention({
  part,
  authoritativeGoal,
  pluginIcon,
}: {
  part: Exclude<V4UserInputMentionPart, { type: "text" }>;
  authoritativeGoal: boolean;
  pluginIcon?: string;
}) {
  if (part.type === "file" || part.type === "directory") {
    return (
      <span className={mentionClassName("files")}>
        <FileDisplayInline
          path={part.label}
          options={{
            className: "inline-flex min-w-0 max-w-full items-center gap-1 align-middle",
            iconSize: 16,
            kind: part.type === "directory" ? "directory" : "file",
            fileNameClassName: "truncate text-ui-base leading-6 font-medium text-current",
          }}
        />
      </span>
    );
  }

  if (part.type === "skill") {
    return (
      <span className={mentionClassName("skills")}>
        <WandSparkles aria-hidden="true" className="size-4 shrink-0" />
        {formatSkillMentionDisplayLabel(part.label)}
      </span>
    );
  }

  if (part.type === "session") {
    return (
      <span className={mentionClassName("sessions")}>
        <MessagesSquare aria-hidden="true" className="size-4 shrink-0" />
        {part.label}
      </span>
    );
  }

  if (part.type === "plugin") {
    // Plugin references render as chips in the bubble: not the file branch, not openable as external links.
    return (
      <span className={mentionClassName("plugins")} data-plugin-mention-id={part.pluginId}>
        <PluginUserMessageIcon src={pluginIcon} />
        {part.label}
      </span>
    );
  }

  if (part.type === "subagent") {
    return (
      <span className={mentionClassName("subagents")}>
        <Bot aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.5} />
        {part.label}
      </span>
    );
  }

  const commandName = normalizeCommandMentionLabel(part.label);
  if ((commandName === "goal" || commandName === "target") && !authoritativeGoal) {
    // Legacy plain-text sniffing rendered `/goal` prompts carrying attachments as control commands.
    // V4 lets only the first goal token confirmed by the send entry use the special UI; everything else keeps the user's text.
    return `/${part.label}`;
  }

  return (
    <span
      {...(authoritativeGoal ? { "data-v4-user-input-command": "goal" } : {})}
      className={mentionClassName("commands")}
    >
      {commandName === "goal" || commandName === "target" ? (
        <GoalIcon aria-hidden="true" className="size-4 shrink-0" />
      ) : commandName === "compact" ? (
        <ScrollText aria-hidden="true" className="size-4 shrink-0" />
      ) : (
        <SquareSlash aria-hidden="true" className="size-4 shrink-0" />
      )}
      {/* Bug 根因：authoritative goal 使用原始 slash token 回显，导致用户气泡重复暴露
          The label keeps the Goal semantics and only drops the `/`; copy, edit, and protocol all use the original row.text. */}
      {part.label}
    </span>
  );
}

function PluginUserMessageIcon({ src }: { src?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = isTrustedPluginIconSource(src) && failedSrc !== src;

  if (!showImage) {
    return <Cable aria-hidden="true" className="size-4 shrink-0" />;
  }

  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-plugin-mention-icon="true"
      className="inline-block size-4 shrink-0 rounded-sm object-contain align-middle"
      onError={() => setFailedSrc(src ?? null)}
    />
  );
}

export const ConversationUserInputContent = memo(function ConversationUserInputContent({
  text,
  attachments = EMPTY_ATTACHMENTS,
  contextAttachmentCount = 0,
}: {
  text: string;
  attachments?: readonly unknown[];
  contextAttachmentCount?: number;
}) {
  const pluginIconProjection = usePluginReferenceIconProjection();
  const goalQuery = parseV4UserInputGoalQuery(text, attachments, contextAttachmentCount);
  const parts = parseMentionMarkdown(text);
  const authoritativeGoalPartIndex = goalQuery
    ? parts.findIndex(
        (part) =>
          part.type === "command" &&
          ["goal", "target"].includes(normalizeCommandMentionLabel(part.label)),
      )
    : -1;

  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "text") {
          return part.text;
        }

        return (
          <V4UserInputMention
            key={`${part.type}-${index}`}
            part={part}
            authoritativeGoal={index === authoritativeGoalPartIndex}
            pluginIcon={
              part.type === "plugin" && part.pluginId
                ? pluginIconProjection?.iconByPluginId.get(part.pluginId)
                : undefined
            }
          />
        );
      })}
    </>
  );
});
