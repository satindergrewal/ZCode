import { memo, useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  TID_WORKFLOW_ARTIFACTS_SECTION,
  TID_WORKFLOW_ARTIFACTS_TOGGLE,
  TID_WORKFLOW_ARTIFACT_CARD,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { WorkflowArtifactIndex } from "@/components/workflow-timeline/WorkflowArtifactIndex.js";
import { WorkflowArtifactRow } from "@/components/workflow-timeline/WorkflowArtifactRow.js";
import { WorkflowArtifactTile } from "@/components/workflow-timeline/WorkflowArtifactTile.js";
import { PILL_STAGGER_MS } from "@/components/workflow-timeline/WorkflowTimeline.js";
import {
  ArtifactDetail,
  artifactDisplayTitle,
  artifactKindMessageId,
  buildPresetLabels,
  resolvePrimaryArtifact,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { WorkflowArtifactTilePreview } from "@/app-shell/workflow-artifacts/WorkflowArtifactTilePreview.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";

/**
 * Artifacts section of the workflow run detail page.
 *
 * Terminology: an artifact in this section is an output the script delivered to the **user** via
 * `artifact.*`. It and the "result" panel above (the script's top-level return value, for the
 * model) are TWO different things; the convention requires both on screen simultaneously, with
 * distinguishable wording.
 *
 * The section header follows the phase list's rhythm (same height, same inset, same chevron). The
 * body has two renderings:
 * - **With a deliverable** (the primary-flagged item, or a single-item list): the deliverable row
 *   (same `WorkflowArtifactRow` as the completion card; frame shrinks to 136 x 85 when the pane is
 *   narrower than 380px, per the body's container query), with the remaining artifacts as an
 *   **index** below the hairline: one per row, single column, all listed (same
 *   `WorkflowArtifactIndex` as the card; the card caps at six rows, here uncapped). Twelve
 *   artifacts are twelve rows, within one screen.
 * - **No deliverable**: a **gallery**: one tile per artifact (preview frame + caption row,
 *   `WorkflowArtifactTile`), column count adapting to pane width -- from 130px per column, single
 *   columns at most 180px; thumbnails stay legible at that size, hence kept.
 * Inside the preview frame is the artifact itself: boards centered at natural size, growing with
 * report entries; documents scaled to show the beginning; the first CSV rows; paper-page glyphs for
 * PDF and binary. The list is already deliverable-first, rest in first-published order (the hook
 * sorted it).
 *
 * **Expanded by default** (opposite of phase sections): artifacts are what this run delivered to
 * the user; collapsing hides the deliverables, which is the most common reason to open this pane.
 * Manual collapse stays, with the count on the header when collapsed.
 * **Failed and cancelled runs render the same**: a run that died at step 12 may still have
 * published a pdf.
 */
export const WorkflowRunArtifactsSection = memo(function WorkflowRunArtifactsSection({
  artifacts,
  sessionId,
  runId,
  onOpenArtifact,
}: {
  /** Confirmed non-empty; callers render no section at all when empty (the "absent if none" convention, no empty shells). */
  artifacts: readonly WorkflowRunArtifactView[];
  sessionId: string;
  runId: string;
  /** Absent means tiles disabled (the host did not inject the open-tab capability). */
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [expanded, setExpanded] = useState(true);
  // Markdown thumbnails pick code-block colors by theme; provider-less hosts (unit tests) get system.
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const title = intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.title" });
  // Stable reference: all four renderers are memoized; a new labels object per frame would never
  // hit that comparison.
  const labels = useMemo(
    () => buildPresetLabels((descriptor, values) => intl.formatMessage(descriptor, values)),
    [intl],
  );
  const primary = resolvePrimaryArtifact(artifacts);
  const rest = primary === undefined ? artifacts : artifacts.filter((a) => a !== primary);
  const preview = (artifact: WorkflowRunArtifactView) => (
    <WorkflowArtifactTilePreview
      artifact={artifact}
      key={`${artifact.id}:${artifact.version}`}
      runId={runId}
      sessionId={sessionId}
      theme={theme}
    />
  );
  // Workspace provenance goes into the tooltip: it is a path, too long for the caption row and not
  // entitled to the title's place.
  const tooltipOf = (
    artifact: Pick<WorkflowRunArtifactView, "id" | "kind" | "title" | "sourcePath">,
  ) => {
    const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
    return (
      `${kindLabel} · ${artifactDisplayTitle(artifact)}` +
      (artifact.sourcePath === undefined ? "" : `\n${artifact.sourcePath}`)
    );
  };

  return (
    <section
      className="wf-motion shrink-0 border-t border-border/60"
      data-artifacts-open={expanded ? "true" : "false"}
      data-testid={TID_WORKFLOW_ARTIFACTS_SECTION}
    >
      <button
        aria-expanded={expanded}
        aria-label={intl.formatMessage({
          id: expanded
            ? "chat.toolCall.workflow.run.artifacts.collapse"
            : "chat.toolCall.workflow.run.artifacts.expand",
        })}
        className="flex h-9 w-full items-center gap-2 px-3 text-left outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40"
        data-testid={TID_WORKFLOW_ARTIFACTS_TOGGLE}
        onClick={() => setExpanded((previous) => !previous)}
        type="button"
      >
        <span className="min-w-0 shrink-0 truncate text-ui-base font-medium text-foreground">
          {title}
        </span>
        {/* The count is present even collapsed -- folding must not hide "what did this run deliver". */}
        <span
          className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid="workflow-run-artifacts-count"
        >
          {artifacts.length.toLocaleString()}
        </span>
        {/* While collapsed the deliverable's name stays on the header: it is what users open this pane to find. */}
        {!expanded && primary !== undefined ? (
          <span
            className="min-w-0 truncate text-ui-sm text-foreground-subtle"
            data-testid="workflow-run-artifacts-primary-title"
          >
            · {artifactDisplayTitle(primary)}
          </span>
        ) : null}
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "ml-auto size-3.5 shrink-0 text-foreground-subtlest transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && primary !== undefined ? (
        // `@container/wf-artifacts`: the deliverable row's frame picks 160 x 100 or 136 x 85 by this container's width.
        <div
          className="wf-unfold @container/wf-artifacts flex max-h-[50vh] flex-col gap-2.5 overflow-auto px-3 pb-3 pt-0.5"
          data-testid="workflow-run-artifact-primary-body"
        >
          <WorkflowArtifactRow
            artifact={primary}
            enterDelayMs={PILL_STAGGER_MS}
            labels={labels}
            preview={preview(primary)}
            // Same testid as the tile (`data-variant="row"` distinguishes the shape): still "one artifact's card".
            testId={TID_WORKFLOW_ARTIFACT_CARD}
            title={tooltipOf(primary)}
            {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
          />
          {rest.length > 0 ? (
            // Single column, uncapped: the side pane is the place that promises every artifact. The row is also "one artifact's card" (`data-variant="line"`).
            <WorkflowArtifactIndex
              artifacts={rest}
              columns="one"
              firstDelayMs={PILL_STAGGER_MS * 2}
              labels={labels}
              lineTestId={TID_WORKFLOW_ARTIFACT_CARD}
              rule
              testId="workflow-run-artifact-index"
              tooltipOf={tooltipOf}
              {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
            />
          ) : null}
        </div>
      ) : expanded ? (
        <div
          className="wf-unfold grid max-h-[50vh] grid-cols-[repeat(auto-fill,minmax(130px,180px))] gap-3 overflow-auto px-3 pb-3 pt-0.5"
          data-testid="workflow-run-artifact-gallery"
        >
          {artifacts.map((artifact, index) => (
            <WorkflowArtifactTile
              artifact={artifact}
              detail={<ArtifactDetail artifact={artifact} labels={labels} />}
              enterDelayMs={PILL_STAGGER_MS * (index + 1)}
              key={artifact.id}
              preview={preview(artifact)}
              testId={TID_WORKFLOW_ARTIFACT_CARD}
              title={tooltipOf(artifact)}
              {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
});
