// ============================================================
// CreateWorkflow display graph bounding -- the bounded projection at the tool-output boundary.
// ============================================================
// Split from create-workflow.ts: the phase vocabulary pushed the handler file over max-lines, and the trim
// itself is self-contained pure logic -- analyzer graph in, contract shape out, no I/O, no memo, no ports.
// Same precedent as zcode-protocol-v4/create-workflow-display.ts split from rows.ts.
//
//
// This holds a **display graph**, no longer a mirror of the causality graph. Layer two is subagent-oriented:
// the step layer keeps only the site table (run state and inspector keys; nothing drawn, no edges); the
// participant layer (per-phase subagent cards + handoff edges) is fed by the analyzer's handoff-graph
// projection, bounded and forwarded here; the phase layer remains the control-flow graph's phase quotient,
// still reduced here (folding and quotient reduction in create-workflow-graph-fold.ts). One edge shape,
// `{from, to, back?}`; region/certainty/edge-kind stay in the analyzer, GUI never reads them. Names are historical.
import {
  CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES,
  CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS,
  CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS,
  CREATE_WORKFLOW_GRAPH_MAX_LANES,
  CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS,
  CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS,
  CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES,
  CREATE_WORKFLOW_GRAPH_MAX_PHASES,
  CREATE_WORKFLOW_GRAPH_MAX_STEPS,
  type CreateWorkflowCausalityGraph,
  type CreateWorkflowEdge,
  type CreateWorkflowHandoff,
  type CreateWorkflowLane,
  type CreateWorkflowNamePattern,
  type CreateWorkflowParticipant,
  type CreateWorkflowPhase,
  type CreateWorkflowStep,
} from "@zcode/contracts";
import {
  FLOW_ABORT,
  FLOW_ENTRY,
  FLOW_SINK,
  type CausalityGraph,
  type ControlFlowGraph,
  type HandoffGraph,
  UNPHASED,
  // The browser replay view reuses this function directly: the /projections subpath, not the root bucket --
  // the root bucket drags the TS compiler into the browser bundle. Semantics match the root export exactly.
} from "@zcode/dynamic-workflow/projections";
// Phase-edge folding/reduction (incl. quotient rules for cyclic input) is its own module; see its header.
import { foldPhaseEdges, type RawEdge } from "./create-workflow-graph-fold.js";

// Display bypasses the tool-result budget: the graph is bounded before entering tool output (and thus live
// events and persisted metadata). The collections reference each other, so trim order is fixed -- steps
// first (source order, tail-cut keeps the script head), then converge to referenced lanes, then filter
// edges/sinks by surviving steps. Referential integrity over count: draw less, never emit ids to missing nodes.
export function boundCausalityGraph(
  graph: CausalityGraph,
  flow?: ControlFlowGraph,
  handoff?: HandoffGraph,
): CreateWorkflowCausalityGraph {
  let truncated = graph.steps.length > CREATE_WORKFLOW_GRAPH_MAX_STEPS;
  const headSteps = graph.steps.slice(0, CREATE_WORKFLOW_GRAPH_MAX_STEPS);

  // 1. Lanes: only the ones the surviving steps stand in, in the graph's lane order
  //    (workspace first, actors in creation order).
  const wantedLanes = new Set<string>();
  for (const step of headSteps) {
    wantedLanes.add(step.lane);
    for (const lane of step.lanes ?? []) wantedLanes.add(lane);
  }
  const laneList = graph.lanes.filter((lane) => wantedLanes.has(lane.id));
  truncated = truncated || laneList.length > CREATE_WORKFLOW_GRAPH_MAX_LANES;
  const keptLanes = laneList.slice(0, CREATE_WORKFLOW_GRAPH_MAX_LANES);
  const laneIds = new Set(keptLanes.map((lane) => lane.id));

  // 2. A step whose own lane got dropped has nowhere to sit; a may-set narrows instead.
  const steps = headSteps.filter((step) => laneIds.has(step.lane));
  truncated = truncated || steps.length < headSteps.length;
  const stepIds = new Set(steps.map((step) => step.id));

  // 3. Participants and hand-offs (the analyzer's projection, already reduced and in
  //    stack order). A card's steps narrow to the surviving ones and a card left with none
  //    goes; the list then truncates in order (the opener survives, the tail does not),
  //    and hand-offs touching a dropped card go with it. A dropped card's steps stay in
  //    `steps` — run status still joins on them, they just have no card.
  const laneOk = (lane: string): boolean => laneIds.has(lane);
  const participantList: CreateWorkflowParticipant[] = [];
  for (const participant of handoff?.participants ?? []) {
    if (!laneOk(participant.lane)) continue;
    const memberSteps = participant.steps.filter((id) => stepIds.has(id));
    if (memberSteps.length === 0) continue;
    participantList.push({
      id: boundGraphText(participant.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      phase: boundGraphText(participant.phase, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      lane: boundGraphText(participant.lane, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      steps: memberSteps
        .slice(0, CREATE_WORKFLOW_GRAPH_MAX_STEPS)
        .map((id) => boundGraphText(id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS)),
      ...(participant.member === undefined ? {} : { member: { ...participant.member } }),
      ...(participant.many === true ? { many: true as const } : {}),
    });
  }
  truncated = truncated || participantList.length < (handoff?.participants.length ?? 0);
  truncated = truncated || participantList.length > CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS;
  const participants = participantList.slice(0, CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS);
  const participantIds = new Set(participants.map((participant) => participant.id));
  const handoffList: CreateWorkflowHandoff[] = (handoff?.handoffs ?? [])
    .filter((edge) => participantIds.has(edge.from) && participantIds.has(edge.to))
    .map((edge) => {
      const types = (edge.types ?? [])
        .slice(0, CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES)
        .map((type) => boundGraphText(type, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS))
        .filter((type) => type.length > 0);
      return {
        from: boundGraphText(edge.from, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
        to: boundGraphText(edge.to, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
        ...(edge.back === true ? { back: true as const } : {}),
        ...(types.length > 0 ? { types } : {}),
      };
    });
  truncated = truncated || handoffList.length < (handoff?.handoffs.length ?? 0);
  truncated = truncated || handoffList.length > CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS;
  const handoffs = handoffList.slice(0, CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS);

  const sink = (graph.sink?.fedBy ?? [])
    .filter((id) => stepIds.has(id))
    .slice(0, CREATE_WORKFLOW_GRAPH_MAX_STEPS)
    .map((id) => boundGraphText(id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS));

  // 4. Phases: the vocabulary is all-or-nothing and comes from the
  //    CONTROL-FLOW projection — every phase some occurrence carries, member steps or not
  //    (a marker-only phase is a position control passes through, so it must show). Edges
  //    touching `entry` / `abort` have no node to land on; edges into `sink` become
  //    `exits`; self-loops say nothing at quotient granularity. Over either bound and the
  //    whole vocabulary goes, `phase` stripped from every step with it: a step naming an
  //    unlisted phase is a dangling reference, and referential integrity beats retention.
  const declaredPhases = flow?.phases;
  const phaseIds = new Set((declaredPhases ?? []).map((phase) => phase.id));
  const rawPhaseEdges: RawEdge[] = [];
  const exitSet = new Set<string>();
  for (const edge of flow?.phaseEdges ?? []) {
    if (edge.from === FLOW_ENTRY || edge.from === FLOW_ABORT || edge.to === FLOW_ABORT) continue;
    if (!phaseIds.has(edge.from)) continue;
    if (edge.to === FLOW_SINK) {
      exitSet.add(edge.from);
      continue;
    }
    if (!phaseIds.has(edge.to)) continue;
    rawPhaseEdges.push({ back: edge.kind === "loop", from: edge.from, to: edge.to });
  }
  const phaseEdges: CreateWorkflowEdge[] = foldPhaseEdges(rawPhaseEdges).map((edge) => ({
    from: boundGraphText(edge.from, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    to: boundGraphText(edge.to, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    ...(edge.back ? { back: true as const } : {}),
  }));
  // The edge cap governs what is emitted, so judge it after reduction.
  const phaseVocabularyDropped =
    declaredPhases !== undefined &&
    (declaredPhases.length > CREATE_WORKFLOW_GRAPH_MAX_PHASES ||
      phaseEdges.length > CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES);
  truncated = truncated || phaseVocabularyDropped;
  const emitPhases = declaredPhases !== undefined && !phaseVocabularyDropped;

  const boundPhases: CreateWorkflowPhase[] = (declaredPhases ?? []).map((phase) => {
    // Synthetic `unphased` has no name (UI-localized); empty names count as unnamed, never failing the
    // whole output parse -- same stance as lane names.
    const name = phase.name ? boundGraphText(phase.name, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : undefined;
    // `alongside`: other phases still running when this one starts (strand not joined). Same referential
    // integrity rule as edges -- drop refs to unlisted phases, drop self-refs (nothing runs parallel with
    // itself), dedupe keeping order, cap as the phase table. NOT passed through foldEdges/reduceOrdering:
    // it is a node fact, not an edge -- no control transferred, and reduction would cut a real edge as a
    // runs-after. Rides the vocabulary automatically -- the whole boundPhases table enters only when emitPhases.
    const alongside: string[] = [];
    const alongsideSeen = new Set<string>();
    for (const id of phase.alongside ?? []) {
      if (id === phase.id || !phaseIds.has(id) || alongsideSeen.has(id)) continue;
      if (alongside.length >= CREATE_WORKFLOW_GRAPH_MAX_PHASES) break;
      alongsideSeen.add(id);
      alongside.push(boundGraphText(id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS));
    }
    return {
      id: boundGraphText(phase.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      ...(name === undefined ? {} : { name }),
      ...(phase.loc === undefined ? {} : { line: phase.loc.line, column: phase.loc.column }),
      ...(alongside.length === 0 ? {} : { alongside }),
    };
  });
  const exits = (declaredPhases ?? [])
    .filter((phase) => exitSet.has(phase.id))
    .map((phase) => boundGraphText(phase.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS));

  const boundLanes: CreateWorkflowLane[] = keptLanes.map((lane) => {
    // An empty name (agent("")) violates the contract min(1); treat as unnamed, never fail the whole parse.
    const name = lane.name ? boundGraphText(lane.name, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : undefined;
    const namePattern = boundNamePattern(lane.namePattern);
    return {
      id: boundGraphText(lane.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      ...(name === undefined ? {} : { name }),
      ...(namePattern === undefined ? {} : { namePattern }),
      ...(lane.loc === undefined ? {} : { line: lane.loc.line, column: lane.loc.column }),
    };
  });

  const boundSteps: CreateWorkflowStep[] = steps.map((step) => {
    const lanes = (step.lanes ?? []).filter((lane) => laneIds.has(lane));
    // An ask label comes from script literals and may be empty; contract min(1) -> fall back to the step id.
    const label = step.label ? boundGraphText(step.label, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : step.id;
    const labelPattern = boundNamePattern(step.labelPattern);
    return {
      id: boundGraphText(step.id, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      kind: step.kind,
      label,
      ...(labelPattern === undefined ? {} : { labelPattern }),
      line: step.loc.line,
      column: step.loc.column,
      lane: boundGraphText(step.lane, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
      ...(lanes.length > 1 ? { lanes } : {}),
      // may-set copy association key: the site pointed at here was already replaced by the copy, so it does
      // NOT join the referential-integrity convergence above (that rule covers nodes under edges/sinks).
      // Field optional: a missing key passes schema and just silently unlink the live overlay from the instance.
      ...(step.source === undefined
        ? {}
        : { source: boundGraphText(step.source, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS) }),
      // When the vocabulary degrades wholesale, `phase` must vanish with it; a phase pointing at an unlisted
      // id goes too: a card with a phase id outside `phases` is a dangling ref -- UI would look up a nonexistent
      // phase. The analyzer guarantees "every issue's phase is some node's phase"; on well-formed input this
      // tightening is behavior-neutral; the trim layer stays defensive, never trusting the producer.
      ...(emitPhases && step.phase !== undefined && phaseIds.has(step.phase)
        ? { phase: boundGraphText(step.phase, CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS) }
        : {}),
      ...(step.repeat === undefined ? {} : { repeat: step.repeat }),
    };
  });

  // Card phase follows the same rule as step `phase`: vocabulary degraded, or pointing at an unlisted phase
  // -> `unphased` (contract: participant.phase is in phases[].id, or all unphased when phases absent). The
  // card id is untouched -- an opaque key that handoff edges and run state join on; UI implicit modules read `phase` only.
  const boundParticipants: CreateWorkflowParticipant[] = participants.map((participant) =>
    emitPhases && phaseIds.has(participant.phase) ? participant : { ...participant, phase: UNPHASED },
  );

  return {
    steps: boundSteps,
    lanes: boundLanes,
    participants: boundParticipants,
    handoffs,
    ...(emitPhases ? { phases: boundPhases, phaseEdges, exits } : {}),
    ...(sink.length > 0 ? { sink } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

// Bug guard: actor names / ask labels come from script string literals (external input); a naive slice can
// cut a UTF-16 surrogate pair. Same treatment as result-display MCP text bounds -- if the boundary lands
// after a high surrogate, drop the half char so the payload stays serializable. ids are analyzer-generated ASCII; slice is identity.
function boundGraphText(value: string, maxChars: number): string {
  const bounded = value.slice(0, maxChars);
  const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? bounded.slice(0, -1) : bounded;
}

/**
 * Name-pattern bounds: both affixes also come from script literals -> the same surrogate-safe truncation.
 *
 * Truncation can leave no affix at all (analyzer should ensure non-empty, but contract min(1) must not
 * contract min(1) must not rely on upstream) -- then the whole field goes absent, not an empty object that
 * passes .strict() and renders a lone ellipsis.
 */
function boundNamePattern(
  pattern: { head?: string; tail?: string } | undefined,
): CreateWorkflowNamePattern | undefined {
  if (pattern === undefined) return undefined;
  const head = pattern.head ? boundGraphText(pattern.head, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : "";
  const tail = pattern.tail ? boundGraphText(pattern.tail, CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS) : "";
  if (head === "" && tail === "") return undefined;
  return {
    ...(head === "" ? {} : { head }),
    ...(tail === "" ? {} : { tail }),
  };
}
