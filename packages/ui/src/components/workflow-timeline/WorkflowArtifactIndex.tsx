import type { CSSProperties } from "react";
import { ArrowUpRightIcon, EllipsisIcon } from "lucide-react";
import {
  ArtifactDetail,
  ArtifactKindIcon,
  artifactDetailText,
  artifactDisplayTitle,
  artifactKindMessageId,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/index.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowCompletionArtifact } from "./WorkflowArtifactTile.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";

/**
 * Artifact index (side panel): every **non-deliverable** artifact, one per row, after the deliverable row.
 *
 * One rule: **a preview renders only if legible**. The deliverable keeps its frame; the
 * rest drop it, keeping just the tile-caption grammar — kind icon, full title, mono meta
 * (mini tiles once hid it in a tooltip), tail slot (v{n}, hover cedes to the arrow) —
 * each on its own row. Hierarchy comes from **form** (the pictured one vs the text-only
 * rest), not big-frame-vs-small.
 *
 * 26px rows. On the card, `repeat(auto-fit, minmax(220px, 1fr))` flows two columns (one
 * when narrow); the side panel is always one. A hairline
 * (`--color-workflow-rule`, the one above the four stats) separates it from the
 * deliverable row, so the card reads as a receipt's three acts: delivered, also did, cost.
 *
 * "N more" is a door, not an artifact: ellipsis icon, secondary text, arrow present
 * before any hover (the roster more-row's same rule); click opens the run side panel for
 * everything.
 *
 * Every row is a `<button>`: without a callback, **disabled** (delivery is fact;
 * openability is capability) — pill/tile's same gate. Hover/focus fills the row with
 * `surface-hover` like a sidebar row, the fill extending 6px past the text each side
 * (negative margins) while text stays aligned with the deliverable frame.
 *
 * Terminology: artifact = an output the script published to the user via `artifact.*`.
 */
function enterStyle(enterDelayMs: number | undefined): CSSProperties | undefined {
  return enterDelayMs === undefined || enterDelayMs <= 0
    ? undefined
    : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };
}

const LINE_CLASS =
  "wf-line wf-arrive -mx-1.5 flex h-[26px] min-w-0 items-center gap-2 rounded-md bg-transparent px-1.5 text-left text-ui-sm outline-none";

function WorkflowArtifactLine({
  artifact,
  enterDelayMs,
  labels,
  onOpen,
  testId = "workflow-artifact-line",
  title: tooltip,
}: {
  artifact: WorkflowCompletionArtifact;
  labels: PresetLabels;
  onOpen?: (artifactId: string) => void;
  enterDelayMs?: number;
  testId?: string;
  /** Tooltip override (side panel adds workspace provenance); default "kind - title". */
  title?: string;
}) {
  const { intl } = useZCodeIntl();
  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const hasDetail = artifactDetailText(artifact, labels) !== undefined;
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;

  return (
    <button
      aria-label={
        openable
          ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${title}`
          : undefined
      }
      className={cn(LINE_CLASS, openable ? "wf-line-open cursor-pointer" : "cursor-default")}
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
      data-artifact-open={openable ? "true" : undefined}
      data-artifact-version={String(version)}
      data-testid={testId}
      data-variant="line"
      disabled={!openable}
      onClick={openable ? () => onOpen(artifact.id) : undefined}
      style={enterStyle(enterDelayMs)}
      title={tooltip ?? `${kindLabel} · ${title}`}
      type="button"
    >
      <ArtifactKindIcon
        className="wf-line-icon size-3.5 shrink-0 text-foreground-subtle"
        kind={artifact.kind}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
      {hasDetail ? (
        <span
          className="flex shrink-0 items-center gap-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid="workflow-artifact-line-detail"
        >
          <ArtifactDetail artifact={artifact} labels={labels} />
        </span>
      ) : null}
      {showVersion || openable ? (
        <span className="grid size-3 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
          {showVersion ? (
            // Remount by version: same-id re-publish pops the tail slot once (wf-mark enter); hover cedes to the arrow.
            <span
              className="wf-mark font-mono text-ui-xs leading-none tabular-nums text-foreground-subtlest"
              data-testid="workflow-artifact-tile-version"
              key={version}
              title={intl.formatMessage(
                { id: "chat.toolCall.workflow.run.artifacts.version" },
                { version: String(version) },
              )}
            >
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.run.artifacts.versionTail" },
                { version: String(version) },
              )}
            </span>
          ) : null}
          {openable ? (
            <span
              aria-hidden
              className="wf-pill-go flex items-center justify-center text-foreground-subtlest"
              data-testid="workflow-artifact-tile-open"
            >
              <ArrowUpRightIcon className="size-3" />
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/** "N more" — a door, not an artifact. A truncated list unknowns N and writes `...`. */
function WorkflowArtifactMoreLine({
  count,
  enterDelayMs,
  onOpen,
  testId = "workflow-artifact-more-line",
  truncated = false,
}: {
  count: number;
  /** Emitter-side truncation (over 8): N unknowable, write `...`. */
  truncated?: boolean;
  onOpen?: () => void;
  enterDelayMs?: number;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  const openable = onOpen !== undefined;
  return (
    <button
      className={cn(LINE_CLASS, openable ? "wf-line-open cursor-pointer" : "cursor-default")}
      data-testid={testId}
      data-variant="more"
      disabled={!openable}
      onClick={onOpen}
      style={enterStyle(enterDelayMs)}
      title={intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
      type="button"
    >
      <EllipsisIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
      <span className="min-w-0 flex-1 truncate text-foreground-subtle">
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.completion.moreArtifacts" },
          { count: truncated ? "…" : count.toLocaleString() },
        )}
      </span>
      {openable ? (
        // A door has no status mark to cede to: the arrow is just there, no hover needed (wf-pill-go-rest).
        <span className="grid size-3 shrink-0 place-items-center">
          <span
            aria-hidden
            className="wf-pill-go wf-pill-go-rest flex items-center justify-center text-foreground-subtlest"
            data-testid="workflow-artifact-tile-open"
          >
            <ArrowUpRightIcon className="size-3" />
          </span>
        </span>
      ) : null}
    </button>
  );
}

type WorkflowArtifactIndexColumns = "auto" | "one";

/**
 * The index: rows plus an optional door. `columns="auto"` is the card's two-column flow
 * (two columns only at 2x220px or wider); `"one"` is the side panel's single column.
 * `rule` draws the hairline above (needed after the deliverable row; not when the index
 * owns the card). Rows land in sequence from `firstDelayMs`, 30ms apart, door last.
 */
export function WorkflowArtifactIndex({
  artifacts,
  columns = "auto",
  firstDelayMs = 0,
  folded = 0,
  labels,
  lineTestId,
  more = false,
  moreTestId,
  onOpenArtifact,
  onOpenRun,
  rule = false,
  testId = "workflow-artifact-index",
  tooltipOf,
  truncated = false,
}: {
  artifacts: readonly WorkflowCompletionArtifact[];
  labels: PresetLabels;
  columns?: WorkflowArtifactIndexColumns;
  rule?: boolean;
  /** Renders "N more"; `folded` is N. */
  more?: boolean;
  folded?: number;
  truncated?: boolean;
  firstDelayMs?: number;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenRun?: () => void;
  testId?: string;
  lineTestId?: string;
  moreTestId?: string;
  tooltipOf?: (artifact: WorkflowCompletionArtifact) => string;
}) {
  return (
    <div
      className={cn(
        "grid gap-x-5",
        columns === "auto" ? "grid-cols-[repeat(auto-fit,minmax(220px,1fr))]" : "grid-cols-1",
        rule && "border-t border-[var(--color-workflow-rule)] pt-1.5",
      )}
      data-columns={columns}
      data-testid={testId}
    >
      {artifacts.map((artifact, index) => (
        <WorkflowArtifactLine
          artifact={artifact}
          enterDelayMs={firstDelayMs + PILL_STAGGER_MS * index}
          key={artifact.id}
          labels={labels}
          {...(lineTestId === undefined ? {} : { testId: lineTestId })}
          {...(tooltipOf === undefined ? {} : { title: tooltipOf(artifact) })}
          {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
        />
      ))}
      {more ? (
        <WorkflowArtifactMoreLine
          count={folded}
          enterDelayMs={firstDelayMs + PILL_STAGGER_MS * artifacts.length}
          truncated={truncated}
          {...(moreTestId === undefined ? {} : { testId: moreTestId })}
          {...(onOpenRun === undefined ? {} : { onOpen: onOpenRun })}
        />
      ) : null}
    </div>
  );
}
