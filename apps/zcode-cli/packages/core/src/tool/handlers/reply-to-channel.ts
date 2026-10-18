import { z } from "zod";
import { channelReplyPartsSchema, channelReplyResultSchema } from "@zcode/shared";
import type { SessionId } from "@zcode/contracts";

import type { ToolEntry, ToolHandler } from "../types.js";

const inputSchema = z.object({ parts: channelReplyPartsSchema }).strict();
const TIMEOUT_MS = 60_000;
// At most 50 names x 10 candidates each; the budget must hold the full clarification result, avoiding truncated false matches.
const OUTPUT_BYTES = 2 * 1024 * 1024;
export const replyToChannelHandler: ToolHandler = async (input, context) => {
  const parsed = inputSchema.parse(input);
  context.abortSignal.throwIfAborted();
  if (!context.sessionStore || !context.topicResourcePort?.reply)
    throw new Error("Channel reply is unavailable");
  const messages = await context.sessionStore.messages({
    sessionID: context.sessionId as SessionId,
  });
  // The tool part persists before the run, binding the actual execution input via assistant.parentID; never authorize from the newest queued message.
  const owners = messages.filter(
    ({ info, parts }) =>
      info.role === "assistant" &&
      parts.some((part) => part.type === "tool" && part.callID === context.toolCallId),
  );
  if (owners.length !== 1 || owners[0]!.info.role !== "assistant")
    throw new Error("Channel reply execution input unavailable");
  const parentId = owners[0]!.info.parentID;
  const latest = messages.find(
    ({ info }) => info.id === parentId && info.role === "user" && !info.synthetic,
  );
  const metadata = latest?.info.metadata;
  const intent =
    metadata && Object.hasOwn(metadata, "conversationInputIntent")
      ? metadata.conversationInputIntent
      : metadata?.inputIntent;
  // Channel origin belongs to the message; the send binding belongs to the task, resolved solely by the Host — continuing a chat never copies the old origin.
  const identity = z.object({ sourceCommandId: z.string().min(1) }).safeParse(intent);
  if (!identity.success)
    throw new Error("Channel reply execution input unavailable; retrying will not restore it");
  context.abortSignal.throwIfAborted();
  return context.topicResourcePort.reply(
    {
      taskId: context.sessionId,
      inputId: identity.data.sourceCommandId,
      toolCallId: context.toolCallId,
      parts: parsed.parts,
    },
    { signal: context.abortSignal, trace: context.traceContext },
  );
};
export const replyToChannelToolEntry: ToolEntry = {
  capability: "Reply to the current bot conversation with native mentions",
  metadata: {
    name: "ReplyToChannel",
    description:
      "Send an additional reply to the current Feishu/Lark conversation ONLY when the user explicitly asks you to send or mention someone. No additional tool approval is needed for this authorized conversation. Prefer trusted mention refIds; when the user supplies only a name, use mentionName and let Host resolve the current group directory and trusted task mentions. Preserve spaces inside a full name (Alex Smith is one recipient); split multiple recipients only on explicit list delimiters such as 、, commas, or newlines, never whitespace alone. Host uses name containment and automatically selects a unique candidate or a unique exact name among multiple matches. Never guess platform IDs. needs_clarification lists ALL unresolved names after checking every requested name and means NOTHING was sent. Only report the returned facts; never claim delivery or invent a match. Keep all original recipients when retrying after clarification: show candidate labels and ask the user to choose; never select an ambiguous candidate yourself. After an explicit choice use a new call with name and the returned candidateRef. For not_found/unavailable/selection_expired or truncated candidates, explain the issue and ask for a native @ mention. Group member APIs do not enumerate bots; unknown bots need a native mention first. Normal final answers are delivered automatically. After sent, do not duplicate that request. A sent message does not mean another bot responded.",
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: OUTPUT_BYTES,
    sideEffectScope: "network",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: replyToChannelHandler,
  // The provider schema has no anyOf; the field combination is still enforced by runtimeInputSchema's strict union.
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["parts"],
    properties: {
      parts: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["text", "mention", "mentionName"] },
            text: {
              type: "string",
              maxLength: 2000,
              description: "Required only for type=text; omit refId.",
            },
            refId: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description:
                "Required only for type=mention; use the current trusted reference and omit text.",
            },
            name: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description:
                "Required only for mentionName: recipient name or partial name supplied by the user; preserve internal spaces, one explicit list item per part; omit text/refId.",
            },
            candidateRef: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description:
                "Only for mentionName after the user explicitly selects a returned candidate; never invent or auto-select.",
            },
          },
        },
      },
    },
  },
  outputSchema: z.toJSONSchema(channelReplyResultSchema),
  runtimeInputSchema: inputSchema,
  runtimeOutputSchema: channelReplyResultSchema,
  permission: {
    permission: "channel.reply",
    reason: "Reply through the current authorized bot conversation",
    riskLevel: "medium",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: OUTPUT_BYTES,
    maxModelBytes: OUTPUT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: OUTPUT_BYTES, direction: "head" },
  },
  timeout: { defaultMs: TIMEOUT_MS, maxMs: TIMEOUT_MS, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Channel reply cancelled; check delivery status before retrying",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
