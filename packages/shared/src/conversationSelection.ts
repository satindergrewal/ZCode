import { z } from "zod";
export const CONVERSATION_SELECTION_MAX_TEXT_LENGTH = 8_000;
export const CONVERSATION_SELECTION_MAX_COUNT = 8;
export const CONVERSATION_SELECTION_MAX_TOTAL_LENGTH = 16_000;

export const conversationQuoteSchema = z.object({
  text: z.string().max(CONVERSATION_SELECTION_MAX_TEXT_LENGTH),
  path: z.string().optional(),
  senderName: z.string().optional(),
  senderId: z.string().optional(),
  messageId: z.string().optional(),
  sentAt: z.string().datetime({ offset: true }).optional(),
});
export const conversationQuotesSchema = z
  .array(conversationQuoteSchema)
  .max(CONVERSATION_SELECTION_MAX_COUNT)
  .refine(
    (quotes) =>
      quotes.reduce((sum, quote) => sum + quote.text.length, 0) <=
      CONVERSATION_SELECTION_MAX_TOTAL_LENGTH,
  );
export type ConversationSelectionText = z.infer<typeof conversationQuoteSchema>;

export function buildPromptWithConversationSelections(
  visibleContent: string,
  references: readonly ConversationSelectionText[],
): string {
  if (references.length === 0) return visibleContent;
  // File excerpts once shipped content only, losing provenance for model and history; keep paths, never internal identity fields.
  const block = [
    "# userselect:",
    "```userselect",
    JSON.stringify(references.map(({ text, path }) => (path?.trim() ? { path, text } : { text }))),
    "```",
  ].join("\n");
  return visibleContent ? `${visibleContent}\n\n${block}` : block;
}
