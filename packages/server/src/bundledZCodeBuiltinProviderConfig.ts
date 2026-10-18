import { materializeZCodeBuiltinProviderConfig } from "@zcode/services/node";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export interface MaterializeBundledZCodeBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** Returns the ZCode Built-in Provider Config embedded in the remote server at build time. */
export function readBundledZCodeBuiltinProviderConfig(): string {
  if (typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    throw new Error("This build does not embed the ZCode Built-in Provider Config");
  }
  return __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__;
}

/**
 * Materializes the ZCode Built-in Config atomically into the fixed per-environment copy.
 * The old process exits before upgrade; no history files growing by content hash are kept.
 */
export async function materializeBundledZCodeBuiltinProviderConfig(
  options: MaterializeBundledZCodeBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeZCodeBuiltinProviderConfig(options);
}
