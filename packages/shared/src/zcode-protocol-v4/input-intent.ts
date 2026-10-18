import { conversationQuotesSchema } from "../conversationSelection.js";
import { botGroupInputSourceSchema } from "../bots.js";
// Self-contained input facts after CLI admission.
// queue / guide / runtime / transcript all carry this one intent; no layer may rebuild its fields.
import { z } from "zod";
import { timestampSchema } from "./core.js";
import { attachmentRefSchema } from "./attachment-ref.js";
import { highspeedMessageMetaSchema } from "../highspeed.js";
import { modelSelectionSchema } from "../model-selection.js";
import { submissionModeSchema } from "./submission.js";
import { sharedContextRefSchema } from "./shared-context-ref.js";

/**
 * Structured origin of the user input: present when a plugin UI sends on the user's behalf via `ui/message`;
 * persisted rows show 'from plugin X'. Absent means the user typed it themselves.
 */
const pluginUiInputSourceSchema = z
  .object({
    kind: z.literal("pluginUi"),
    pluginId: z.string().min(1),
    toolCallId: z.string().min(1),
  })
  .strict();
export const conversationInputSourceSchema = z.discriminatedUnion("kind", [
  pluginUiInputSourceSchema,
  z
    .object({
      kind: z.literal("genUi"),
      path: z.string().min(1).max(4096),
      title: z.string().max(250).optional(),
    })
    .strict(),
]);
export type ConversationInputSource = z.infer<typeof conversationInputSourceSchema>;

export const conversationInputDeliverySchema = z
  .object({
    requested: z.enum(["auto", "startNow", "queue", "guide"]),
    admitted: z.enum(["startNow", "queue", "guide"]),
    fallbackReasonCode: z.string().optional(),
  })
  .strict();

export const conversationInputOrderSchema = z
  .object({
    admissionSeq: z.number().int().nonnegative(),
    queuePosition: z.number().int().nonnegative().optional(),
  })
  .strict();

export const conversationInputSteerSchema = z
  .object({
    state: z.enum(["notRequested", "submitting", "steering", "guided", "fellBack"]),
    reasonCode: z.string().optional(),
  })
  .strict();

export const conversationInputDispatchSchema = z
  .object({
    state: z.enum(["admitted", "queued", "reserved", "promoting", "drained"]),
    reservationId: z.string().optional(),
  })
  .strict();

export const conversationInputIntentSchema = z
  .object({
    inputOrigin: z.enum(["desktop", "mobile"]).optional(),
    botGroupSource: botGroupInputSourceSchema.optional(),
    conversationQuotes: conversationQuotesSchema.optional(),
    sourceCommandId: z.string().min(1),
    queueItemId: z.string().min(1),
    clientId: z.string().min(1),
    // compact is a queueable maintenance intent; consumption runs the compact lifecycle and never projects a user row.
    kind: z.enum(["sendText", "sendGoalCommand", "compact"]),
    text: z.string(),
    attachments: z.array(attachmentRefSchema).default([]),
    // optional exists for legacy snapshot hydration; new admission must carry a full Submission.
    modelSelection: modelSelectionSchema.optional(),
    mode: submissionModeSchema.optional(),
    planEnabled: z.boolean().optional(),
    sharedContextRefs: z.array(sharedContextRefSchema).max(1).optional(),
    delivery: conversationInputDeliverySchema,
    order: conversationInputOrderSchema,
    steer: conversationInputSteerSchema,
    dispatch: conversationInputDispatchSchema,
    admittedAt: timestampSchema,
    highspeed: highspeedMessageMetaSchema.optional(),
    provenance: z
      .object({
        sourceCommandId: z.string().min(1),
        queueItemId: z.string().min(1).optional(),
        clientId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    source: conversationInputSourceSchema.optional(),
  })
  .strict();

export type ConversationInputIntent = z.infer<typeof conversationInputIntentSchema>;
