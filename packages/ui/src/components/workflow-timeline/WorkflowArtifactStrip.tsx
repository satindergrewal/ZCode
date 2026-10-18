import type { KeyboardEvent, MouseEvent } from "react";
import { ARTIFACT_CHIP_MAX_VISIBLE } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";
import {
  WorkflowArtifactPill,
  type ArtifactPillData,
  type ArtifactPillSize,
} from "./WorkflowArtifactPill.js";

/**
 * Artifact strip: one row of artifact pills, at most three,
 * the rest folded into a monospace `+N`. Under the timeline (tool card, run-tail summary), the folded header of the completion notice, the hub's run-history rows and
 * the "recent artifacts" strip are all it — the same artifact must look the same in all four. The full list lives in the run side panel.
 *
 * ⚠ Terminology: artifact = output the script published to the user via `artifact.*`.
 *
 * Events stop at the **pill**: the strip often sits inside another clickable region (the notice row's fold toggle, the run-tail
 * summary's block toggle, the hub's history row); a pill is a button, not part of that region — **including disabled ones**: disabled
 * only makes opening a no-op, it must not also open the region (browsers dispatch no click on disabled controls; jsdom bubbles to the ancestor;
 * here both sides agree). The strip's blank and `+N` **are** part of that region: clicks on them bubble to the host, toggling the run-tail summary.
 */
function hitsPill(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button") !== null;
}

export function WorkflowArtifactStrip({
  artifacts,
  className,
  moreTestId,
  onOpenArtifact,
  pillTestId,
  size = "md",
  testId,
  truncated = false,
  variant = "pill",
}: {
  variant?: "pill" | "link";
  artifacts: readonly ArtifactPillData[];
  size?: ArtifactPillSize;
  /** Absent = every pill disabled (the callback's existence is the gate). */
  onOpenArtifact?: (artifactId: string) => void;
  //** Truncated emitter-side (over the cap or filtered) — `+N` may undercount, so `…` instead of a number. */
  truncated?: boolean;
  testId?: string;
  pillTestId?: string;
  moreTestId?: string;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  if (artifacts.length === 0) return null;
  const visible = artifacts.slice(0, ARTIFACT_CHIP_MAX_VISIBLE);
  const overflow = artifacts.length - visible.length;
  return (
    <span
      className={cn(
        "wf-motion flex min-w-0 shrink flex-wrap items-center",
        size === "md" ? "gap-1.5" : "gap-1",
        className,
      )}
      data-testid={testId}
      onClick={(event: MouseEvent<HTMLSpanElement>) => {
        if (hitsPill(event.target)) event.stopPropagation();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (hitsPill(event.target)) event.stopPropagation();
      }}
    >
      {visible.map((artifact, i) => (
        <WorkflowArtifactPill
          artifact={artifact}
          variant={variant}
          enterDelayMs={PILL_STAGGER_MS * i}
          key={artifact.id}
          size={size}
          truncateTitle
          {...(pillTestId === undefined ? {} : { testId: pillTestId })}
          {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
        />
      ))}
      {overflow > 0 || truncated ? (
        <span
          className="shrink-0 px-0.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid={moreTestId}
        >
          {intl.formatMessage(
            { id: "chat.backgroundResult.workflow.artifacts.more" },
            { count: truncated && overflow === 0 ? "…" : String(overflow) },
          )}
        </span>
      ) : null}
    </span>
  );
}
