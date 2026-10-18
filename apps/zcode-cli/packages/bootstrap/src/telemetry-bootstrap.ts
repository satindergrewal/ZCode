import { getCapturedZCodeAgentTelemetryEnv } from "@zcode/shared";
import {
  prepareModelTelemetryEnv,
  shutdownPreparedModelTelemetry,
  type PrepareModelTelemetryOptions,
} from "@zcode/telemetry";

/**
 * Called by the official CLI async entry before the sync App is created; only puts the prepared device MID back into the business env,
 * while private config such as OTLP headers stays in the in-process capture area, never in Tool/MCP child environments.
 */
export async function prepareZCodeTelemetryEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: PrepareModelTelemetryOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const prepared = await prepareModelTelemetryEnv({
    ...getCapturedZCodeAgentTelemetryEnv(),
    ...env,
  }, {
    ...options,
    productVersion: options.productVersion ?? env.ZCODE_APP_VERSION,
  });
  const deviceMid = prepared.ZCODE_TELEMETRY_DEVICE_MID;
  return deviceMid ? { ...env, ZCODE_TELEMETRY_DEVICE_MID: deviceMid } : env;
}

/**
 * Closes the Telemetry Owner held by this process, mirroring prepareZCodeTelemetryEnv.
 * A single App/Session may only flush; only the outermost executable entry may call this.
 */
export async function shutdownZCodeTelemetry(): Promise<void> {
  await shutdownPreparedModelTelemetry();
}
