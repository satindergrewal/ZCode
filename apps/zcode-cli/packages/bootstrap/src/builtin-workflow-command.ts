import { expandCustomCommandPrompt, type CustomCommandContent } from "@zcode/contracts";
import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES } from "@zcode/shared";
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "./app/bundled-skills.js";

/**
 * The built-in `/workflow` command (docs/dynamic-workflow/authoring.md "The `/workflow` command and the skill").
 *
 * It was zcode-guide's built-in plugin `commands/workflow.md`: uninstall/disable the plugin and the command and plus-menu entry vanished
 // while the ten workflow tools stayed (the 2026-09-19 incident). The command body now ships compiled with the CLI, code-defined like `/init`.
 * A prompt-type built-in command; the name enters the reserved table, so user/plugin commands of the same name no longer shadow it.
 *
 * The body deliberately reuses contracts' custom-command expansion ($ARGUMENTS substitution + the `skills:` preamble),
 // keeping the prompt the model sees byte-identical to the plugin era — no re-tuning.
 */
export const BUILTIN_WORKFLOW_COMMAND_NAME = "workflow";

const helpEntry = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find(
  (entry) => entry.name === BUILTIN_WORKFLOW_COMMAND_NAME,
);
if (!helpEntry) {
  // The shared help table is the single source for reserved words, TUI candidates, and the app catalog; without an entry the command is not addressable at all.
  throw new Error(`Missing builtin slash command help entry: ${BUILTIN_WORKFLOW_COMMAND_NAME}`);
}

const USAGE_PREFIX = `/${BUILTIN_WORKFLOW_COMMAND_NAME} `;
export const BUILTIN_WORKFLOW_COMMAND_DESCRIPTION = helpEntry.summary;
export const BUILTIN_WORKFLOW_COMMAND_ARGUMENT_HINT = helpEntry.usage.startsWith(USAGE_PREFIX)
  ? helpEntry.usage.slice(USAGE_PREFIX.length)
  : "";

/** `$ARGUMENTS` must be present: otherwise expansion appends the args as a misplaced "User arguments:" tail block. */
const BUILTIN_WORKFLOW_COMMAND_BODY = [
  `Use the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill to design and launch a dynamic workflow for this request:`,
  "",
  "$ARGUMENTS",
  "",
  "Decide the subagent topology before writing any code: how many subagents, which of them",
  "share a context, what result each one returns. Then write the script and call the",
  "`CreateWorkflow` tool. (`CreateWorkflow` is the dynamic-workflow tool. Do not use the",
  "legacy `Workflow` tool, and do not substitute the `Agent` tool.)",
  "",
].join("\n");

export const BUILTIN_WORKFLOW_COMMAND: CustomCommandContent = {
  bytesRead: Buffer.byteLength(BUILTIN_WORKFLOW_COMMAND_BODY),
  content: BUILTIN_WORKFLOW_COMMAND_BODY,
  metadata: {
    allowedTools: [],
    argumentHint: BUILTIN_WORKFLOW_COMMAND_ARGUMENT_HINT,
    description: BUILTIN_WORKFLOW_COMMAND_DESCRIPTION,
    disableNonInteractive: false,
    frontmatterKeys: ["description", "argument-hint", "skills"],
    name: BUILTIN_WORKFLOW_COMMAND_NAME,
    path: `builtin:${BUILTIN_WORKFLOW_COMMAND_NAME}`,
    rootPath: "builtin:",
    scope: "system",
    skills: [DYNAMIC_WORKFLOW_SKILL_NAME],
    source: "zcode",
  },
  sizeBytes: Buffer.byteLength(BUILTIN_WORKFLOW_COMMAND_BODY),
  truncated: false,
};

export function expandBuiltinWorkflowCommandPrompt(args: string): string {
  return expandCustomCommandPrompt({ args, command: BUILTIN_WORKFLOW_COMMAND }).prompt;
}
