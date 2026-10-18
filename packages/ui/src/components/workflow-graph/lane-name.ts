import { laneClassOf, MAIN_LANE_ID, type LaneClass, type WorkflowLaneData } from "./types.js";
import { formatNamePattern, type NamePattern } from "./name-pattern.js";

/**
 * The single policy point for lane display names.
 *
 * The site id (`actor#3`) is **identity**: the journal key, the hover-title anchor, the
 * debugging handle. The display name is **presentation**. Conflating them puts a lane
 * literally labeled "actor#3" on screen — a key used as a name. Names come from only two
 * places: the name written in the script (shown verbatim; localizing it rewrites the
 * author's words), and the localized fallback when analysis can't recover a name.
 *
 * Why the fallback happens at render time: the projection (flow-elements.ts) is a
 * memoized pure function, language-agnostic; baking localized copy into it turns stale
 * the moment the user switches language mid-session (the workspace/unresolved lanes
 * already localize at render time for exactly this reason). So projections carry data
 * only; copy takes shape here.
 */

/**
 * Everything needed to decide a lane's display name — without the id: the id is identity
 * and never participates in naming. Both `LaneHead` and candidate-lane references
 * (`LaneRef`) satisfy this shape, so both call sites share one policy.
 */
export interface LaneNaming {
  laneClass: LaneClass;
  /** The name given by `agent("planner")` in the script; absent when analysis can't recover the literal. */
  name?: string;
  /**
   * When the name is interpolated (`` agent(`researcher${i + 1}`) ``), the literals at
   * both ends of the template. Ranks after `name`, before the anonymous fallback: it says
   * one true thing more than "unnamed agent" without being the author's verbatim word.
   */
  namePattern?: NamePattern;
  /** 1-based index when several anonymous agent lanes coexist in one graph; absent for a single one. */
  anonymousIndex?: number;
}

/**
 * The minimal shape of `IntlInstance["formatMessage"]`. The helpers need only this
 * function, no React — so the policy itself is unit-testable with a fake formatter.
 */
export type LaneNameFormatter = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/** Synthetic lanes are not identified by name: they say "what runs here"; copy is fixed. */
const NAME_ID_BY_CLASS: Partial<Record<LaneClass, string>> = {
  unresolved: "chat.toolCall.workflow.graph.lane.unresolved",
  workspace: "chat.toolCall.workflow.graph.lane.script",
};

export function laneDisplayName(lane: LaneNaming, formatMessage: LaneNameFormatter): string {
  const classNameId = NAME_ID_BY_CLASS[lane.laneClass];
  if (classNameId !== undefined) return formatMessage({ id: classNameId });
  // The author's wording shows verbatim: localizing it would rewrite the author.
  if (lane.name !== undefined) return lane.name;
  // Interpolated name: the shape is still the author's wording, so likewise not
  // localized — just complete it with an ellipsis.
  const patterned = formatNamePattern(lane.namePattern);
  if (patterned !== undefined) return patterned;
  // The index appears only when needed to disambiguate: with a single anonymous lane,
  // the 1 in "unnamed agent 1" says nothing.
  return lane.anonymousIndex === undefined
    ? formatMessage({ id: "chat.toolCall.workflow.graph.lane.anonymous" })
    : formatMessage(
        { id: "chat.toolCall.workflow.graph.lane.anonymousIndexed" },
        { index: lane.anonymousIndex },
      );
}

/**
 * A reference to one lane: identity (`id`) plus everything needed for the display name.
 * **Never a prebuilt display string** — the anonymous fallback copy takes shape at render
 * time in `laneDisplayName`; see the file header.
 */
export interface LaneRef extends LaneNaming {
  id: string;
}

/**
 * 1-based indexes, assigned in lane order to agent lanes without a name, and only when
 * two or more coexist: with a single anonymous lane, the 1 in "unnamed agent 1" has
 * nothing to distinguish and is pure noise.
 *
 * **Patterned lanes count as named** and stay out of this numbering: the card already
 * reads "researcher…"; adding an anonymous index would desynchronize the count from the
 * anonymous lanes actually visible. Two identical patterns do collide — the same as two
 * lanes literally named `"worker"` — and owe no new disambiguation here.
 *
 * The counting is language-independent, hence it lives in this layer (and is unit
 * testable); the copy itself takes shape at render time.
 */
function anonymousLaneIndexes(lanes: readonly WorkflowLaneData[]): Map<string, number> {
  const anonymous = lanes.filter(
    (lane) =>
      lane.name === undefined &&
      formatNamePattern(lane.namePattern) === undefined &&
      laneClassOf(lane.id) === "agent" &&
      // 主代理的车道从不画出来：算进来，唯一一条真匿名车道就会平白带上「1」。
      lane.id !== MAIN_LANE_ID,
  );
  if (anonymous.length < 2) return new Map();
  return new Map(anonymous.map((lane, index) => [lane.id, index + 1]));
}

/**
 * Lane id -> naming material (not display strings).
 *
 * Three consumers share this one map: the graph roster, the candidate lanes of step
 * cards, and the transcript drill-down's instance picker. **It must be single-sourced** —
 * the anonymous index is "the n-th anonymous lane in the graph"; computing it per
 * consumer eventually disagrees, visible as the picker's "unnamed agent 2" facing the
 * graph's "unnamed agent 1".
 *
 * It lives here rather than in the projection layer (flow-elements.ts) so consumers that
 * never render the graph (drill-down resolution is pure) need not pull React Flow in for
 * one naming record. Lane ids missing from the graph fall back at the call site to
 * `{id, laneClass}`: future changes like site specialization must not crash the drill-down.
 */
export function laneRefsById(lanes: readonly WorkflowLaneData[]): Map<string, LaneRef> {
  const anonymousIndexes = anonymousLaneIndexes(lanes);
  return new Map(
    lanes.map((lane) => {
      const anonymousIndex = anonymousIndexes.get(lane.id);
      return [
        lane.id,
        {
          id: lane.id,
          laneClass: laneClassOf(lane.id),
          ...(lane.name === undefined ? {} : { name: lane.name }),
          ...(lane.namePattern === undefined ? {} : { namePattern: lane.namePattern }),
          ...(anonymousIndex === undefined ? {} : { anonymousIndex }),
        },
      ];
    }),
  );
}
