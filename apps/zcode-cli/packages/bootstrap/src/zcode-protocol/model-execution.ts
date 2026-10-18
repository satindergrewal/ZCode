import type { ModelRequestAuth } from "@zcode/contracts";
import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import type { SendInputOptions } from "../app/types.js";

/** Both input protocols share the execution-material projection; Secret/Ticket never enter the persistable intent. */
export function createModelExecutionContext(
  input: NonNullable<CommandPayloadMap["sendText"]["modelExecution"]>,
): NonNullable<SendInputOptions["modelExecution"]> {
  const requestAuth = input.requestAuth ? freezeRequestAuth(input.requestAuth) : undefined;
  return {
    ...(input.memoryExtraction ? { memoryExtraction: input.memoryExtraction } : {}),
    selectionScope: "execution",
    ...(requestAuth
      ? {
          requestDependencies: { requestAuth: { source: { resolve: async () => requestAuth } } },
        }
      : {}),
    ...(input.subagents ? { subagents: input.subagents } : {}),
    ...(input.selectionFallback ? { selectionFallback: input.selectionFallback } : {}),
  };
}

function freezeRequestAuth(input: ModelRequestAuth): ModelRequestAuth {
  return Object.freeze({
    ...(input.accountScope ? { accountScope: input.accountScope } : {}),
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
    ...(input.headers ? { headers: Object.freeze({ ...input.headers }) } : {}),
  });
}
