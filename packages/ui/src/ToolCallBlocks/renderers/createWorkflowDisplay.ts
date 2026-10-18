import {
  toolCallCreateWorkflowDisplaySchema,
  type ToolCallCreateWorkflowDisplay,
} from "@zcode/shared/zcode-protocol-v4";
import { isPlainRecord } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";

/**
 * Read rules for the CreateWorkflow tool output side (display payload and plain-text
 * fallback). Split out of `create-workflow.tsx` (the oxlint max-lines 400 gate, same
 * precedent as `createWorkflowInput.ts`): pure functions, no JSX.
 */
// Structured diagnostics travel only via the display channel; safeParse raw.display with
// the packages/shared schema, falling back to plain text when missing or malformed. Never
// JSON-dump, never crash.
export function readWorkflowDisplay(raw: unknown): ToolCallCreateWorkflowDisplay | null {
  if (!isPlainRecord(raw)) {
    return null;
  }

  const parsed = toolCallCreateWorkflowDisplaySchema.safeParse(raw.display);
  return parsed.success ? parsed.data : null;
}

export function readFallbackOutputText(output: unknown): string | null {
  if (typeof output === "string") {
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (isPlainRecord(output)) {
    for (const key of ["response", "output", "text", "content"] as const) {
      const candidate = output[key];
      if (typeof candidate === "string") {
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }

  return null;
}

interface WorkflowDiagnosticPosition {
  line: number;
  column: number;
  message: string;
}

/**
 * Hover tooltip for the compile-feedback line: the lede sentence first (what did not
 * happen, what happens next), then one `L{line}:C{col} message` per diagnostic — same
 * shape as the lines the model received, so a copy can be compared directly.
 */
export function formatWorkflowFeedbackTooltip(
  lede: string,
  diagnostics: readonly WorkflowDiagnosticPosition[],
): string {
  return [
    lede,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
}

/** Script lines called out by diagnostics (first-occurrence order, deduped, positive lines only): the expanded script tints these line numbers as warnings. */
export function workflowDiagnosticLines(
  diagnostics: readonly WorkflowDiagnosticPosition[],
): number[] {
  const lines = diagnostics.map((diagnostic) => diagnostic.line).filter((line) => line > 0);
  return [...new Set(lines)];
}
