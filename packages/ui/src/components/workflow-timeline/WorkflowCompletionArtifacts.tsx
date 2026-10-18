import type { ReactNode } from "react";
import { resolvePrimaryArtifact } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/index.js";
import { WorkflowArtifactIndex } from "./WorkflowArtifactIndex.js";
import { WorkflowArtifactRow } from "./WorkflowArtifactRow.js";
import { ArtifactSheetGlyph, type WorkflowCompletionArtifact } from "./WorkflowArtifactTile.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";

/**
 * The completion card's artifact section.
 * Split out of `WorkflowCompletionCard`: the card itself must respect the 400-line gate.
 *
 * - **With a deliverable** (the primary-flagged one, or a single-item list): the deliverable row, then the rest as an **index** —
 *   one per row, two columns on wide cards; at most six rows, from the seventh five rows + one "n more" row (open the run side panel for all).
 * - **No deliverable**: when none deserves a preview, none is drawn — the index owns the section, same cap.
 *
 * Only the deliverable's frame reads bytes (a preview is either readable or not drawn); index rows and "n more" never do.
 *
 * ⚠ Terminology: artifact = output published to the user by the script via `artifact.*`.
 */

/** Row cap on the card, also the cap when unfolded. */
export const COMPLETION_INDEX_MAX = 6;
/** Rows shown alongside once "n more” is needed. */
const COMPLETION_INDEX_WITH_MORE = COMPLETION_INDEX_MAX - 1;

export interface CompletionArtifactLayout {
  /** The deliverable; absent means index-only. */
  primary?: WorkflowCompletionArtifact;
  /** The items rendered as rows (beside the deliverable). */
  lines: readonly WorkflowCompletionArtifact[];
  /** Items not drawn (the N in "n more"). */
  folded: number;
  //** Draw "n more": folded items, or the list was truncated emitter-side (then N is unknowable; write `…`). */
  more: boolean;
}

/** The **single** layout decision; card rhythm, the byte-reading gate (which items read) and rendering all read from here. */
export function completionArtifactLayout(
  artifacts: readonly WorkflowCompletionArtifact[],
  truncated: boolean,
): CompletionArtifactLayout {
  if (artifacts.length === 0) return { lines: [], folded: 0, more: false };
  const primary = resolvePrimaryArtifact(artifacts);
  const rest = primary === undefined ? artifacts : artifacts.filter((a) => a !== primary);
  // A truncated list (over 8) hides the true count: still give the door, write `…` for N — the same honesty as the artifact strip's ellipsis.
  const more = rest.length > COMPLETION_INDEX_MAX || truncated;
  const lines = rest.slice(0, more ? COMPLETION_INDEX_WITH_MORE : COMPLETION_INDEX_MAX);
  return {
    ...(primary === undefined ? {} : { primary }),
    lines,
    folded: rest.length - lines.length,
    more,
  };
}

/** Cells drawn on the card (a row counts, each index row counts, "n more" counts): the four-number beat lands after them. */
export function completionArtifactCellCount(layout: CompletionArtifactLayout): number {
  return (layout.primary === undefined ? 0 : 1) + layout.lines.length + (layout.more ? 1 : 0);
}

/** The items that read bytes: only the deliverable's frame; index rows and the door never do. */
export function completionPreviewIds(layout: CompletionArtifactLayout): ReadonlySet<string> {
  return new Set(layout.primary === undefined ? [] : [layout.primary.id]);
}

export function WorkflowCompletionArtifacts({
  artifactsTruncated,
  labels,
  layout,
  onOpenArtifact,
  onOpenRun,
  renderPreview,
}: {
  layout: CompletionArtifactLayout;
  artifactsTruncated: boolean;
  labels: PresetLabels;
  renderPreview?: (artifact: WorkflowCompletionArtifact) => ReactNode;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenRun?: () => void;
}) {
  const { primary, lines, folded, more } = layout;
  if (primary === undefined && lines.length === 0 && !more) return null;
  const hasPrimary = primary !== undefined;
  return (
    <>
      {hasPrimary ? (
        <WorkflowArtifactRow
          artifact={primary}
          enterDelayMs={PILL_STAGGER_MS}
          labels={labels}
          preview={renderPreview?.(primary) ?? <ArtifactSheetGlyph />}
          testId="workflow-completion-row"
          {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
        />
      ) : null}
      {lines.length > 0 || more ? (
        // The index follows the deliverable row across a hairline; alone in the section, none (nothing above to separate).
        <WorkflowArtifactIndex
          artifacts={lines}
          columns="auto"
          firstDelayMs={PILL_STAGGER_MS * (hasPrimary ? 2 : 1)}
          folded={folded}
          labels={labels}
          lineTestId="workflow-completion-line"
          more={more}
          moreTestId="workflow-completion-more"
          rule={hasPrimary}
          testId="workflow-completion-index"
          truncated={artifactsTruncated}
          {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
          {...(onOpenRun === undefined ? {} : { onOpenRun })}
        />
      ) : null}
    </>
  );
}
