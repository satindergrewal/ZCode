import type { ToolProgress } from "@zcode/shared/zcode-protocol-v4";
import { toolProgressSchema } from "@zcode/shared/zcode-protocol-v4";

export const TID_TOOL_CALL_PROGRESS = "tool-call-progress";

/** Running progress projected from legacy raw (toolCallRowAdapter passes ToolCallRow.progress through). */
export function readToolCallProgress(raw: unknown): ToolProgress | null {
  if (typeof raw !== "object" || raw === null) return null;
  const parsed = toolProgressSchema.safeParse((raw as { progress?: unknown }).progress);
  return parsed.success ? parsed.data : null;
}

/**
 * Thin progress bar in the tool summary row: determinate with a fraction, otherwise an indeterminate sweep;
 * the message follows. Colors come from brand / surface tokens only, per DESIGN.md.
 */
export function ToolCallProgressIndicator({ progress }: { progress: ToolProgress }) {
  const fraction = progress.fraction;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-2"
      data-testid={TID_TOOL_CALL_PROGRESS}
      {...(fraction !== undefined ? { "data-fraction": fraction.toFixed(3) } : {})}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={1}
      {...(fraction !== undefined ? { "aria-valuenow": fraction } : {})}
    >
      <span className="text-foreground-subtlest">·</span>
      <span className="relative inline-block h-1 w-16 shrink-0 overflow-hidden rounded-full bg-surface-hover">
        {fraction !== undefined ? (
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-brand transition-[width] duration-200"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        ) : (
          <span className="tool-call-progress-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-brand" />
        )}
      </span>
      {progress.message ? (
        <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
          {progress.message}
        </span>
      ) : null}
    </span>
  );
}
