import {
  expandCustomCommandPrompt,
  expandCustomCommandTemplate,
  formatCustomCommandPrompt,
  type ExecutionPort,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import { loadZCodeCustomCommand, type ListZCodeCustomCommandsOptions } from "./custom-commands.js";
import { expandCustomCommandShellSyntax } from "./custom-command-shell-expansion.js";
import { isReservedZCodeSlashCommandName } from "./slash-command-surface.js";

const CUSTOM_COMMAND_NOT_FOUND_PATTERN = /not found/i;
const PROMPT_CUSTOM_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

export interface ResolveZCodeCustomCommandPromptOptions extends ListZCodeCustomCommandsOptions {
  executionPort?: ExecutionPort;
  sessionId?: SessionId;
  signal?: AbortSignal;
  traceContext?: TraceContext;
}

export async function resolveZCodeCustomCommandPrompt(
  input: string,
  options: ResolveZCodeCustomCommandPromptOptions = {},
): Promise<string | undefined> {
  const invocation = parsePromptCustomCommandInvocation(input);
  // Reserved names (incl. builtin `workflow`) return undefined here, same shape as "command not found": builtins are
  // builtin-prompt-command.ts expands first; the rejection here covers same-named custom commands bypassing built-in semantics (or the gate).
  if (!invocation || isReservedZCodeSlashCommandName(invocation.name)) {
    return undefined;
  }

  try {
    const command = await loadZCodeCustomCommand({
      ...options,
      name: invocation.name,
    });
    if (options.executionPort) {
      // Slash commands execute first and substitute their output, so an unsupported error
      // cannot throw before turn creation and leave the UI stuck on "thinking".
      //
      // Reuse contracts' low-level template/format functions, not expandCustomCommandPrompt:
      // its detectUnsupportedDynamicSyntax throws on `!` syntax, while this path
      // specifically supports shell expansion -- slot expandCustomCommandShellSyntax between
      // expandCustomCommandTemplate and formatCustomCommandPrompt.
      const expanded = expandCustomCommandTemplate({
        args: invocation.args,
        command,
      });
      const body = await expandCustomCommandShellSyntax({
        command,
        content: expanded.body,
        executionPort: options.executionPort,
        sessionId: options.sessionId,
        signal: options.signal,
        traceContext: options.traceContext,
        workingDirectory: options.workingDirectory ?? process.cwd(),
      });
      return formatCustomCommandPrompt({
        argumentCount: expanded.argumentCount,
        body,
        command,
        usedArgumentsPlaceholder: expanded.usedArgumentsPlaceholder,
      }).prompt;
    }
    return expandCustomCommandPrompt({
      args: invocation.args,
      command,
    }).prompt;
  } catch (error) {
    if (error instanceof Error && CUSTOM_COMMAND_NOT_FOUND_PATTERN.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

function parsePromptCustomCommandInvocation(input: string): { args: string; name: string } | null {
  const match = PROMPT_CUSTOM_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}
