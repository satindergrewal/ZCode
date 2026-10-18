import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";

/** Host→Main registration request correlation; owns only the pending transport, no sandbox or session facts. */
export interface PluginSandboxRegistrationBridge {
  register(input: PluginSandboxRegisterInput): Promise<PluginSandboxHandle>;
  accept(
    result: Partial<PluginSandboxHandle> & { requestId: string; ok: boolean; error?: string },
  ): void;
  dispose(): void;
}
