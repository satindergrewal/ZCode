import { z } from "zod";

// Early startup or protocol failure leaves stdout unusable; process diagnostics use a dedicated one-line stderr contract.
export const ZCODE_PROCESS_DIAGNOSTIC_PREFIX = "[zcode-process-exception] ";
export const ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS = 128;
export const ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS = 4_000;
export const ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS = 16_000;
export const ZCODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS = 128 * 1024;
export const ZCODE_AGENT_LIFECYCLE_LOG_MARKER = "[zcode-agent-lifecycle-reported]";

const processErrorKindSchema = z.enum(["uncaughtException", "unhandledRejection"]);
export const zcodeProcessDiagnosticSchema = z
  .object({
    version: z.literal(1),
    errorId: z.uuid(),
    kind: processErrorKindSchema,
    origin: processErrorKindSchema,
    name: z.string().min(1).max(ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS),
    message: z.string().max(ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS),
    stack: z.string().max(ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS).optional(),
    occurredAt: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeProcessDiagnostic = z.infer<typeof zcodeProcessDiagnosticSchema>;

export function parseZCodeProcessDiagnostic(line: string): ZCodeProcessDiagnostic | undefined {
  if (
    !line.startsWith(ZCODE_PROCESS_DIAGNOSTIC_PREFIX) ||
    line.length > ZCODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS
  ) {
    return undefined;
  }
  try {
    const result = zcodeProcessDiagnosticSchema.safeParse(
      JSON.parse(line.slice(ZCODE_PROCESS_DIAGNOSTIC_PREFIX.length)),
    );
    return result.success ? result.data : undefined;
  } catch {
    // The diagnostic bypass must never break the business protocol or exit handling on a damaged frame.
    return undefined;
  }
}
