import type { BrowserCommandResult } from "@zcode/shared";

export type BrowserCommandDone = (
  partial: Omit<BrowserCommandResult, "elapsedMs">,
) => BrowserCommandResult;

/** Builds the structured ref-not-found error (hint: snapshot first). */
export function refNotFound(ref: string): Omit<BrowserCommandResult, "elapsedMs"> {
  return {
    ok: false,
    error: {
      code: "ref_not_found",
      message: `ref ${ref} not found (take a fresh snapshot() first)`,
    },
  };
}

/** Convenience builder for structured execution_error results. */
export function executionError(message: string): Omit<BrowserCommandResult, "elapsedMs"> {
  return { ok: false, error: { code: "execution_error", message } };
}
