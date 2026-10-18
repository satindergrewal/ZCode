import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";

export const ZCODE_AGENT_PROVIDER = "glm" satisfies ZCodeProvider;
export const ZCODE_AGENT_PROVIDER_LABEL = "ZCode Agent";
export const ZCODE_COMMAND_AGENT_SOURCE = "zcodeAgent" satisfies CommandAgentSource;

/**
 * Provider normalization schema for persisted/relay data:
 * historical values of removed third-party providers stay valid normalization input and converge on glm;
 * any other invalid value still rejects, matching the pre-narrowing validation boundary.
 */
export const legacyZCodeProviderSchema = z
  .enum(["claude", "opencode", "gemini", "codex", "glm"])
  .transform((): typeof ZCODE_AGENT_PROVIDER => ZCODE_AGENT_PROVIDER);

export const ZCODE_ENABLED_AGENT_PROVIDERS = [
  ZCODE_AGENT_PROVIDER,
] as const satisfies readonly ZCodeProvider[];

export const ZCODE_COMMAND_AGENT_SOURCES = [
  ZCODE_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToZCodeAgent(
  _provider?: ZCodeProvider | null,
): ZCodeProvider {
  return ZCODE_AGENT_PROVIDER;
}

export function normalizeAgentProvidersToZCodeAgent(
  _providers?: ReadonlyArray<ZCodeProvider> | null,
): ZCodeProvider[] {
  return [...ZCODE_ENABLED_AGENT_PROVIDERS];
}

export function normalizeCommandAgentSourceToZCodeAgent(
  _agentSource?: CommandAgentSource | null,
): CommandAgentSource {
  return ZCODE_COMMAND_AGENT_SOURCE;
}

export function isZCodeAgentProvider(
  provider: ZCodeProvider | null | undefined,
): provider is typeof ZCODE_AGENT_PROVIDER {
  return provider === ZCODE_AGENT_PROVIDER;
}
