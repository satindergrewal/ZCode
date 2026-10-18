import type { LogContext, Logger } from "@zcode/contracts";

interface AiSdkWarningLoggerOptions {
  model?: unknown;
  provider?: unknown;
  warnings?: unknown;
}

type AiSdkWarningLogger = (options: AiSdkWarningLoggerOptions) => void;

type AiSdkWarningGlobal = typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: false | AiSdkWarningLogger;
};

export function installZCodeProtocolAiSdkWarningLogger(logger: Logger): void {
  // The AI SDK default warning logger writes to stdout via console.info on first use;
  // app-server --stdio uses stdout as the ZCode Protocol NDJSON frame channel, so any stray text breaks host parsing.
  (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS = (options: AiSdkWarningLoggerOptions) => {
    try {
      const warnings = Array.isArray(options.warnings) ? options.warnings : [];
      logger.warn("AI SDK model warning", {
        event: "model.sdk.warning",
        module: "bootstrap.zcode_protocol",
        status: "completed",
        model: stringValue(options.model),
        provider: stringValue(options.provider),
        warningCount: warnings.length,
        warnings: warnings.map(summarizeWarning),
      });
    } catch {
      // Warning logging must not affect real model requests; stdout purity is guaranteed by never calling console.*.
    }
  };
}

function summarizeWarning(warning: unknown): LogContext {
  if (!warning || typeof warning !== "object") {
    return { value: stringValue(warning) };
  }
  const record = warning as Record<string, unknown>;
  return {
    type: stringValue(record.type),
    feature: stringValue(record.feature),
    message: stringValue(record.message),
    details: stringValue(record.details),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
