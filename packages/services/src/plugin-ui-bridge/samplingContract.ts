import { ServiceChannels } from "@zcode/shared";
import type { McpAppsSamplingResult } from "@zcode/shared/mcp-apps";
import { createServiceDescriptor } from "../descriptors.js";
import type { PluginUiPluginScope } from "./contract.js";

export interface PluginUiSamplingParams extends PluginUiPluginScope {
  operationId: string;
  request: import("@zcode/shared/mcp-apps").McpAppsSamplingParams;
}
export interface PluginUiCancelSamplingParams extends PluginUiPluginScope {
  operationId: string;
}

/** Stateless pass-through; the agent owns instance credentials, concurrency caps, and the single call terminal state. */
export interface IPluginUiSamplingService {
  sample(params: PluginUiSamplingParams): Promise<McpAppsSamplingResult>;
  cancelSampling(params: PluginUiCancelSamplingParams): Promise<{ cancelled: boolean }>;
}
export const IPluginUiSamplingService = createServiceDescriptor<IPluginUiSamplingService>(
  ServiceChannels.PluginUiSampling,
);
