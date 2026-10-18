import { isAbsolute } from "node:path";

import type {
  ModelInputMessage,
  ModelMessageContent,
  Model,
  ModelReasoningContentBlock,
  ModelRequest,
  ModelToolCall,
  ModelToolContract,
} from "@zcode/contracts";

import { modelContentForToolResult, isErrorForToolResult } from "../runtime/helpers/tool-result.js";
import { projectMessagesForModelMediaPolicy } from "../runtime/helpers/media-budget.js";
import {
  analyzeBashCommand,
  isBashCommandPermissionSafe,
} from "../tool/handlers/bash-command-parser.js";
import { isRuntimeReadOnlyBashCommand } from "../tool/handlers/bash-semantics.js";
import type { ExecutableToolCall, ToolExecutionResult } from "../tool/types.js";
import { resolveContainedMemoryFilePath, resolveSafeMemoryFilePath } from "./memory-file-path.js";
import { auxiliaryModelOptions } from "../model/auxiliary-model-options.js";

export type MemoryAgentModelRequest = ModelRequest;

export interface MemoryAgentLoopResult {
  messages: ModelInputMessage[];
  turns: number;
}

export interface MemoryAgentToolPolicyInput {
  rootDir: string;
  toolCall: ModelToolCall;
  tools: readonly ModelToolContract[];
  workingDirectory: string;
  workspaceRoot: string;
}

export type MemoryAgentToolPolicyDecision = { allowed: true } | { allowed: false; reason: string };

const MEMORY_AGENT_READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob"]);

export async function runMemoryAgentLoop(input: {
  abortSignal?: AbortSignal;
  executeTool: (
    toolCall: ExecutableToolCall,
    options: { abortSignal?: AbortSignal },
  ) => Promise<ToolExecutionResult>;
  maxTurns: number;
  messages: readonly ModelInputMessage[];
  model: Model;
  rootDir: string;
  tools: readonly ModelToolContract[];
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<MemoryAgentLoopResult> {
  const messages = input.messages.map(cloneModelMessage);
  let turns = 0;

  for (; turns < input.maxTurns; turns += 1) {
    input.abortSignal?.throwIfAborted();
    // A Memory initial-snapshot projection alone misses media produced later by Read and friends; every
    // provider request must run the same capability + budget policy on a request-local copy.
    const mediaProjection = projectMessagesForModelMediaPolicy(
      messages.map(cloneModelMessage),
      input.model.properties.inputFormat,
    );
    const request: ModelRequest = {
      abortSignal: input.abortSignal,
      messages: mediaProjection.messages,
      options: auxiliaryModelOptions(input.model),
      // The Memory agent's provider request keeps the main agent's true tool catalog; execution rights narrow only at the tool-use boundary.
      tools: input.tools as ModelToolContract[],
    };
    const response = await input.model.generateText(request);
    input.abortSignal?.throwIfAborted();

    const toolCalls = response.toolCalls ?? [];
    messages.push(createAssistantMessage(response.text, response.reasoning, toolCalls));
    if (toolCalls.length === 0) {
      turns += 1;
      break;
    }

    const toolMessages = await Promise.all(
      toolCalls.map(async (toolCall): Promise<ModelInputMessage> => {
        const decision = evaluateMemoryAgentToolPolicy({
          rootDir: input.rootDir,
          toolCall,
          tools: input.tools,
          workingDirectory: input.workingDirectory,
          workspaceRoot: input.workspaceRoot,
        });
        if (!decision.allowed) {
          return {
            content: decision.reason,
            isError: true,
            role: "tool",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          };
        }

        const result = await input.executeTool(
          { id: toolCall.id, input: toolCall.input, name: toolCall.name },
          { abortSignal: input.abortSignal },
        );
        return {
          content: modelContentForToolResult(result),
          isError: isErrorForToolResult(result),
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        };
      }),
    );
    messages.push(...toolMessages);
  }

  return { messages, turns };
}

export function evaluateMemoryAgentToolPolicy(
  input: MemoryAgentToolPolicyInput,
): MemoryAgentToolPolicyDecision {
  const contract = input.tools.find((tool) => tool.name === input.toolCall.name);
  // Folding the catalog miss into the Memory permission denial would skip the usual
  // No such tool error handling. This branch only closes the original call id and never enters tool execution.
  if (!contract) return denyUnavailableMemoryAgentTool(input.toolCall.name);

  if (
    input.toolCall.name === "Agent" ||
    input.toolCall.name.startsWith("mcp__") ||
    contract.sideEffectScope === "network"
  )
    return denyMemoryAgentTool(input.rootDir);

  if (input.toolCall.name === "Write" || input.toolCall.name === "Edit") {
    return isContainedMarkdownMutation(input)
      ? { allowed: true }
      : denyMemoryAgentTool(input.rootDir);
  }

  if (input.toolCall.name === "Bash") {
    const command = stringProperty(input.toolCall.input, "command");
    // The memory agent reuses the existing read-only classifier instead of re-narrowing safe env, redirects, and background execution here.
    if (
      command &&
      (isRuntimeReadOnlyBashCommand(command, {
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      }) ||
        isContainedMarkdownBashRemoval(command, input))
    ) {
      return { allowed: true };
    }
    return denyMemoryAgentBash(input.rootDir);
  }

  if (MEMORY_AGENT_READ_ONLY_TOOLS.has(input.toolCall.name)) {
    return { allowed: true };
  }

  return denyMemoryAgentTool(input.rootDir);
}

function isContainedMarkdownMutation(input: MemoryAgentToolPolicyInput): boolean {
  const filePath = stringProperty(input.toolCall.input, "file_path");
  if (!filePath?.endsWith(".md")) return false;
  try {
    return (
      resolveSafeMemoryFilePath({
        filePath,
        rootDir: input.rootDir,
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      }) !== undefined
    );
  } catch {
    return false;
  }
}

function isContainedMarkdownBashRemoval(
  command: string,
  input: MemoryAgentToolPolicyInput,
): boolean {
  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis) || analysis.commands.length !== 1) return false;
  const invocation = analysis.commands[0];
  if (!invocation || invocation.argv[0] !== "rm") return false;
  if (invocation.redirects.length > 0 || invocation.envAssignments.length > 0) return false;

  let afterOptions = false;
  let pathCount = 0;
  for (const argument of invocation.argv.slice(1)) {
    if (!afterOptions) {
      if (argument === "--") {
        afterOptions = true;
        continue;
      }
      if (argument.startsWith("-")) {
        if (argument === "--recursive" || /^-[a-zA-Z]*[rR]/u.test(argument)) return false;
        continue;
      }
    }
    if (/[*?[]/u.test(argument)) return false;
    if (!isAbsolute(argument) || !argument.endsWith(".md")) return false;
    if (resolveContainedPath(argument, input) === undefined) return false;
    pathCount += 1;
  }
  return pathCount > 0;
}

function resolveContainedPath(
  filePath: string,
  input: Pick<MemoryAgentToolPolicyInput, "rootDir" | "workingDirectory" | "workspaceRoot">,
): string | undefined {
  try {
    return resolveContainedMemoryFilePath({
      filePath,
      rootDir: input.rootDir,
      workingDirectory: input.workingDirectory,
      workspaceRoot: input.workspaceRoot,
    });
  } catch {
    return undefined;
  }
}

function createAssistantMessage(
  text: string,
  reasoning: readonly ModelReasoningContentBlock[] | undefined,
  toolCalls: readonly ModelToolCall[],
): ModelInputMessage {
  return {
    content: assistantContent(text, reasoning),
    role: "assistant",
    toolCalls: toolCalls.map((call) => ({ ...call })),
  };
}

function assistantContent(
  text: string,
  reasoning: readonly ModelReasoningContentBlock[] | undefined,
): ModelMessageContent {
  if (!reasoning?.length) return text;
  return [
    ...reasoning.map((block) => ({
      ...block,
      providerOptions: block.providerOptions ? { ...block.providerOptions } : undefined,
    })),
    ...(text ? [{ text, type: "text" as const }] : []),
  ];
}

function cloneModelMessage(message: ModelInputMessage): ModelInputMessage {
  return {
    ...message,
    cacheControl: message.cacheControl ? { ...message.cacheControl } : undefined,
    content: Array.isArray(message.content)
      ? message.content.map((block) => ({ ...block }))
      : message.content,
    toolCalls: message.toolCalls?.map((call) => ({ ...call })),
  };
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

// Denial results feed the next provider request, so keep the baseline's per-tool fixed copy (Bash vs others).
function denyMemoryAgentBash(rootDir: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `Only read-only shell commands and rm with all paths inside ${rootDir} are permitted in this context (ls, find, grep, cat, stat, wc, head, tail, and similar)`,
  };
}

function denyMemoryAgentTool(rootDir: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `only Read, Grep, Glob, read-only Bash, and Edit/Write within ${rootDir} are allowed`,
  };
}

function denyUnavailableMemoryAgentTool(toolName: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
  };
}
