import { useMemo, type ReactNode } from "react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { draftTimeline, scanWorkflowDraft } from "@/components/workflow-timeline/draft-scan.js";
import { narrowTimelineToFill } from "@/components/workflow-timeline/timeline-holes.js";
import {
  buildWorkflowTimeline,
  type WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";
import { readWorkflowDisplay } from "@/ToolCallBlocks/renderers/createWorkflowDisplay.js";
import {
  readWorkflowHoleTarget,
  type WorkflowHoleTarget,
} from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";
import type { WorkflowKindVocabulary } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import { isFillWorkflowHoleToolCall } from "@/lib/workflowToolNames.js";

/**
 * The hole-fill row's share of the create-workflow renderer (docs/dynamic-workflow/presentation.md "The fill row").
 * Split from create-workflow.tsx (max-lines gate): same renderer, hole vocabulary; the main text is the hole's name (from the display
 * `fill` block -- the row input has no name); the draft stage line is the fill's segment of the parent track (new sites full ink, neighbor sites ghosted).
 */
export function useWorkflowHoleRow(
  toolCall: {
    toolName?: string | null;
    kind?: string | null;
    title?: string | null;
    raw?: unknown;
    input?: unknown;
  },
  amend: boolean,
): {
  fill: boolean;
  holeTarget: WorkflowHoleTarget | undefined;
  vocabulary: WorkflowKindVocabulary;
} {
  const fill = isFillWorkflowHoleToolCall(toolCall);
  const holeTarget = useMemo(
    () =>
      fill
        ? readWorkflowHoleTarget(toolCall.input, readWorkflowDisplay(toolCall.raw)?.fill)
        : undefined,
    [fill, toolCall.input, toolCall.raw],
  );
  return { fill, holeTarget, vocabulary: fill ? "hole" : amend };
}

/** Timeline model on the card: graph when present (fill row narrowed to the fill's segment), draft scan while streaming, none otherwise. */
export function useWorkflowCardModel({
  graph,
  holeTarget,
  run,
  scriptText,
  writing,
}: {
  graph: WorkflowCausalityGraphData | undefined;
  run: WorkflowRunState | undefined;
  holeTarget: WorkflowHoleTarget | undefined;
  scriptText: string | undefined;
  writing: boolean;
}): WorkflowTimelineModel | undefined {
  return useMemo(() => {
    if (graph !== undefined) {
      // Fill row: the valid-script graph narrowed to the fill's segment (neighbor sites ghosted); the name comes from the tool-backfilled input.
      if (holeTarget?.holeId !== undefined) {
        const labels = new Map(
          holeTarget.name === undefined ? [] : [[holeTarget.holeId, { name: holeTarget.name }]],
        );
        const whole = buildWorkflowTimeline(graph, undefined, labels);
        return narrowTimelineToFill(whole, holeTarget.holeId) ?? whole;
      }
      return buildWorkflowTimeline(graph, run);
    }
    // Streaming draft: display not yet arrived, sites scanned from the partial script; display replaces the whole model on arrival.
    if (writing && scriptText !== undefined) return draftTimeline(scanWorkflowDraft(scriptText));
    return undefined;
  }, [graph, holeTarget, run, scriptText, writing]);
}

/**
 * Pre-launch / feedback row main text. ToolLayout is memoized: nodes handed to it must be referentially stable. The fill row is
 * `middot + hole name`; the rest the name only. The hole type is not UI-facing.
 */
export function useWorkflowRowPrimaryText(fill: boolean, name: string): ReactNode {
  return useMemo(
    () =>
      fill ? (
        <span className="inline-flex min-w-0 items-center gap-2 text-foreground-subtlest">
          <span aria-hidden>·</span>
          <span className="truncate" data-testid="workflow-fill-hole-name">
            {name}
          </span>
        </span>
      ) : (
        <span className="truncate text-foreground-subtlest">{name}</span>
      ),
    [fill, name],
  );
}
