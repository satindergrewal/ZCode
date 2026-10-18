import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { buildPresetLabels } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workDurationParts, workDurationUnitSeparator } from "@/lib/workDuration.js";
import type { WorkflowCompletionArtifact } from "./WorkflowArtifactTile.js";
import {
  WORKFLOW_RUN_KIND_ID,
  WorkflowCardHeader,
  WorkflowRunStatus,
} from "./WorkflowCardChrome.js";
import {
  completionArtifactCellCount,
  completionArtifactLayout,
  WorkflowCompletionArtifacts,
} from "./WorkflowCompletionArtifacts.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";

export { COMPLETION_INDEX_MAX } from "./WorkflowCompletionArtifacts.js";

/**
 * Completion card: the turn where the main agent digests a **completed** workflow notification;
 * the card lands at the turn's tail. The order is the argument — header -> what this run **delivered** (deliverable row) -> what else it **produced** (artifact index,
 * one per row) -> **what it cost** (four number cells). Hairlines between the three, like a receipt. The artifact section lives in `WorkflowCompletionArtifacts`.
 *
 * Pure presentation: the artifact list, the four numbers and each item's preview are handed in by the host (previews read bytes; that is the host's job).
 * No chevron — nothing to expand; the card is not a toggle.
 *
 * Honest numbers: a cell without data writes `—`, never 0.
 */
export interface WorkflowCompletionFigures {
  durationMs?: number;
  tokens?: number;
  subagents?: number;
  //** Phases entered (`run.phases`); scripts without phase() markers cannot have it — write `—`. */
  phases?: number;
}

export interface WorkflowCompletionCardProps {
  name: string;
  figures: WorkflowCompletionFigures;
  artifacts: readonly WorkflowCompletionArtifact[];
  //** Truncated emitter-side: the N in "n more" writes `…`. */
  artifactsTruncated?: boolean;
  //** Preview for the framed cell (only the deliverable row has a frame); absent (or returning undefined) means the paper glyph. */
  renderPreview?: (artifact: WorkflowCompletionArtifact) => ReactNode;
  onOpenRun?: () => void;
  onOpenArtifact?: (artifactId: string) => void;
  /**
   * 表头状态之前的插槽：「已保存」芯片（docs/dynamic-workflow/transcript-and-notifications.md
   * 「Saving the run, and running it again」）。宿主建，卡只摆。
   */
  headerLeading?: ReactNode;
  /** 表头 ⤢ 之前的插槽：「保存」/「再次运行」。缺席即这张卡没有会话上下文，或两道门关着。 */
  headerTrailing?: ReactNode;
  testIdKey: string;
}

/** Number roll-up duration; all four cells share the beat, chained after the strip's staggered pills. */
const COUNT_UP_MS = 640;

/**
 * Compact token notation: `812` / `386.4k` / `1.30M`. One decimal in the thousands, two in the millions — fixed widths keep the four cells'
 * monospace digits aligned across runs. Full values go into the title.
 */
export function formatCompactCount(count: number): { value: string; unit: string } {
  if (count < 1_000) return { value: count.toLocaleString(), unit: "" };
  if (count < 1_000_000) return { value: (count / 1_000).toFixed(1), unit: "k" };
  return { value: (count / 1_000_000).toFixed(2), unit: "M" };
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** Roll numbers only when the browser **explicitly** reports "reduce motion" off; unquerable (static render, jsdom) lands the final value directly. */
function motionAllowed(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: no-preference)").matches
  );
}

/**
 * Numbers count 0 up to target. **The first frame is the target** (static render, tests and reduced-motion all see the final value);
 * after mount it resets to 0 and rolls up — "the page is complete at rest".
 */
function useCountUp(target: number | undefined): number | undefined {
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (target === undefined || !motionAllowed() || typeof requestAnimationFrame !== "function") {
      setShown(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / COUNT_UP_MS);
      setShown(Math.round(target * easeOutCubic(progress)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    setShown(0);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

function Figure({
  delayMs,
  label,
  parts,
  testKey,
  title,
}: {
  testKey: string;
  label: string;
  //** `[number, unit]` pairs; absent means `—`. */
  parts: readonly { value: string; unit: string }[] | undefined;
  title?: string;
  delayMs: number;
}) {
  const { intl } = useZCodeIntl();
  const unavailable = intl.formatMessage({ id: "chat.toolCall.workflow.completion.unavailable" });
  const style: CSSProperties = { animationDelay: `${delayMs}ms`, animationFillMode: "backwards" };
  return (
    <div
      className="wf-arrive flex min-w-0 flex-col"
      data-testid={`workflow-completion-figure-${testKey}`}
      data-value={
        parts === undefined ? undefined : parts.map((part) => part.value + part.unit).join(" ")
      }
      style={style}
    >
      <span
        aria-label={parts === undefined ? unavailable : undefined}
        className={cn(
          "whitespace-nowrap font-mono text-ui-lg leading-tight tabular-nums",
          parts === undefined ? "text-foreground-subtlest" : "font-medium text-foreground",
        )}
        title={title}
      >
        {parts === undefined
          ? "—"
          : parts.map((part, index) => (
              <span key={index}>
                {index > 0 ? " " : null}
                {part.value}
                {part.unit.length === 0 ? null : (
                  <span className="text-ui-sm font-normal text-foreground-subtle">{part.unit}</span>
                )}
              </span>
            ))}
      </span>
      <span className="truncate text-ui-sm text-foreground-subtle">{label}</span>
    </div>
  );
}

export function WorkflowCompletionCard({
  artifacts,
  artifactsTruncated = false,
  figures,
  headerLeading,
  headerTrailing,
  name,
  onOpenArtifact,
  onOpenRun,
  renderPreview,
  testIdKey,
}: WorkflowCompletionCardProps) {
  const { intl, locale } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const labels = useMemo(
    () => buildPresetLabels((descriptor, values) => intl.formatMessage(descriptor, values)),
    [intl],
  );

  const layout = useMemo(
    () => completionArtifactLayout(artifacts, artifactsTruncated),
    [artifacts, artifactsTruncated],
  );

  // The four cells' numbers roll up; duration rolls milliseconds, then splits into "11m 48s".
  const durationMs = useCountUp(figures.durationMs);
  const tokens = useCountUp(figures.tokens);
  const subagents = useCountUp(figures.subagents);
  const phases = useCountUp(figures.phases);
  const separator = workDurationUnitSeparator(locale);
  const timeParts =
    durationMs === undefined
      ? undefined
      : workDurationParts(durationMs, format).map((part) => ({
          value: String(part.value),
          unit: `${separator}${part.unit}`,
        }));
  const tokenParts = tokens === undefined ? undefined : [formatCompactCount(tokens)];
  const plain = (value: number | undefined) =>
    value === undefined ? undefined : [{ value: value.toLocaleString(), unit: "" }];

  const figureDelay = PILL_STAGGER_MS * (completionArtifactCellCount(layout) + 1);

  return (
    <section
      aria-label={format({ id: WORKFLOW_RUN_KIND_ID.completed })}
      // `@container/wf-card`：窄卡（<480px）上动词只剩图标——判据必须是**卡自己的宽度**，
      // 视口断点在分栏、侧板与手机三种窄法之间对不上（docs/dynamic-workflow/transcript-and-notifications.md）。
      className="wf-motion wf-arrive @container/wf-card flex w-full min-w-0 flex-col gap-2.5 rounded-xl border border-border/70 bg-card/70 px-3.5 pb-3 pt-1.5"
      data-testid={`workflow-completion-card-${testIdKey}`}
      data-workflow-completion-card="true"
    >
      <WorkflowCardHeader
        expanded={false}
        kind={format({ id: WORKFLOW_RUN_KIND_ID.completed })}
        name={name}
        status={<WorkflowRunStatus status="completed" testId="workflow-completion-status" />}
        {...(headerLeading === undefined ? {} : { leading: headerLeading })}
        {...(headerTrailing === undefined ? {} : { trailing: headerTrailing })}
        {...(onOpenRun === undefined ? {} : { onOpenDetails: onOpenRun })}
      />
      <WorkflowCompletionArtifacts
        artifactsTruncated={artifactsTruncated}
        labels={labels}
        layout={layout}
        {...(renderPreview === undefined ? {} : { renderPreview })}
        {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
        {...(onOpenRun === undefined ? {} : { onOpenRun })}
      />
      <div
        className="grid grid-cols-4 gap-x-3 border-t border-[var(--color-workflow-rule)] pt-2.5"
        data-testid="workflow-completion-figures"
      >
        <Figure
          delayMs={figureDelay}
          label={format({ id: "chat.toolCall.workflow.completion.time" })}
          parts={timeParts}
          testKey="time"
        />
        <Figure
          delayMs={figureDelay + PILL_STAGGER_MS}
          label={format({ id: "chat.toolCall.workflow.completion.tokens" })}
          parts={tokenParts}
          testKey="tokens"
          {...(figures.tokens === undefined
            ? {}
            : {
                title: format(
                  { id: "chat.toolCall.workflow.card.tokens" },
                  { count: figures.tokens.toLocaleString() },
                ),
              })}
        />
        <Figure
          delayMs={figureDelay + PILL_STAGGER_MS * 2}
          label={format({ id: "chat.toolCall.workflow.completion.subagents" })}
          parts={plain(subagents)}
          testKey="subagents"
        />
        <Figure
          delayMs={figureDelay + PILL_STAGGER_MS * 3}
          label={format({ id: "chat.toolCall.workflow.completion.phases" })}
          parts={plain(phases)}
          testKey="phases"
        />
      </div>
    </section>
  );
}
