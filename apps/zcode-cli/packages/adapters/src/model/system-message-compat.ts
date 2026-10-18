import { modelMessageContentToText, type ModelInputMessage } from "@zcode/contracts";

export function normalizeOpenAiCompatibleSystemMessages(
  messages: readonly ModelInputMessage[],
): ModelInputMessage[] {
  let leadingSystemCount = 0;
  while (messages[leadingSystemCount]?.role === "system") {
    leadingSystemCount += 1;
  }

  if (leadingSystemCount <= 1) {
    return [...messages];
  }

  const leadingSystemMessages = messages.slice(0, leadingSystemCount);
  const lastLeadingSystem = leadingSystemMessages.at(-1);

  // Some legacy OpenAI-compatible chat templates accept a single leading system.
  // Core keeps multiple segments for the Anthropic cache boundary, so merge in order only at the compat wire boundary.
  // ZCode by design: every later block carries its own left boundary; the adapter never infers or injects whitespace.
  return [
    {
      role: "system",
      content: leadingSystemMessages
        .map((message) => modelMessageContentToText(message.content))
        .join(""),
      ...(lastLeadingSystem?.cacheControl
        ? { cacheControl: { ...lastLeadingSystem.cacheControl } }
        : {}),
    },
    ...messages.slice(leadingSystemCount),
  ];
}
