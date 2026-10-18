export { FACADE_DTS, FACADE_FILE_NAME, SNIPPET_FACADE_DTS } from "./facade/dts.js";
export {
  HOLE_SITE_ID_PATTERN,
  holePrefixOf,
  holeSiteId,
  isHoleSiteId,
} from "./analysis/hole-id.js";
export { WORLD_READ_CAPS } from "./facade/world-read-caps.js";
export { REPORT_CAPS } from "./facade/report-caps.js";
// User-facing artifacts: cap constants, registry vocabulary, compile-time inventories and diagnostics.
export { ARTIFACT_CAPS, ARTIFACT_ID_PATTERN } from "./facade/artifact-caps.js";
export {
  ARTIFACT_REGISTRY,
  artifactFamilyOf,
  isArtifactPresetOp,
  type ArtifactContentOp,
  type ArtifactOp,
  type ArtifactPresetOp,
  type ArtifactRow,
} from "./facade/registry.js";
export {
  ARTIFACT_DECLARATION_CODE,
  ARTIFACT_HOISTING_CODE,
  ARTIFACT_PRIMARY_CONFLICT_CODE,
  collectArtifactDeclarations,
  type ArtifactDeclarations,
  type DeclaredArtifact,
} from "./analysis/artifacts.js";
export {
  collectDiagnostics,
  compileWorkflowScript,
  createWorkflowProgram,
  SCRIPT_FILE_NAME,
  type CompileDiagnostic,
  type CompileResult,
  type CreateWorkflowProgramOptions,
  type ScriptLoc,
  type WorkflowProgram,
} from "./compiler/compile.js";
export { analyzeWorkflowScript, type AnalyzeResult } from "./analysis/analyze.js";
export {
  MODEL_REFERENCE_CODE,
  MODEL_UNRESOLVED_CODE,
  type ModelReference,
} from "./analysis/actor-models.js";
export { collectSites, type SiteTable } from "./analysis/sites.js";
export {
  collectWorldRunCommands,
  WORLD_RUN_LITERAL_CODE,
  type WorldRunCommands,
} from "./analysis/world-run.js";
export { collectPhaseMarkerDiagnostics, PHASE_MARKER_CODE } from "./analysis/phases.js";
export { collectPhaseNames, collectSitePhases } from "./analysis/site-phases.js";
// Holes (docs/dynamic-workflow/authoring.md, Holes): rule 9012, site types, the fill service's splice,
export { collectHoleDiagnostics, HOLE_CODE, HOLE_NAME_MAX_CHARS } from "./analysis/hole-sites.js";
export type { HoleSite } from "./analysis/sites.js";
export {
  checkSiteStability,
  spliceHoleBody,
  type SiteStability,
  type SplicedHoleBody,
} from "./analysis/hole-splice.js";
export { MAIN_LANE } from "./analysis/causality-graph.js";
export type { FlowHole } from "./analysis/flow-graph.js";
export { interpret } from "./analysis/interpret.js";
export {
  toActorGraph,
  type ActorEdge,
  type ActorGraph,
  type ActorNode,
} from "./analysis/actor-graph.js";
export {
  SINK_ID,
  UNKNOWN_LANE,
  WORKSPACE_LANE,
  type CausalityGraph,
  type Certainty,
  type Lane,
  type NamePattern,
  type OrderEdge,
  type OrderKind,
  type Phase,
  type Region,
  type RegionKind,
  type Step,
  type StepKind,
} from "./analysis/causality-graph.js";
// Greedy irreducible transitive reduction. The display
// pruning layer reuses it to reduce a single edge kind untyped:
// all forward edges of one kind, back edges as carry -- it degenerates to the plain irreducible reduction and stays sound on cyclic input.
export { reduceOrdering, type ReducibleEdge } from "./analysis/causality-reduce.js";
export {
  UNPHASED_ID,
  type JumpKind,
  type StructuralRegionKind,
  type TraceRegionKind,
} from "./analysis/causality-order.js";
// Control-flow projection: the occurrence-level CFG and the phase quotient.
export {
  FLOW_ABORT,
  FLOW_ENTRY,
  FLOW_SINK,
  projectControlFlow,
  type ControlFlowGraph,
  type FlowEdge,
  type FlowEdgeKind,
  type FlowNode,
  type FlowNodeKind,
  type FlowPhase,
  type FlowVia,
} from "./analysis/flow-graph.js";
export {
  actorGraphToMermaid,
  causalityGraphToMermaid,
  controlFlowToMermaid,
  handoffGraphToMermaid,
  phaseFlowToMermaid,
  phaseGraphToMermaid,
  siteGraphToMermaid,
} from "./analysis/mermaid.js";
// The causal graph's canonical text form (the snapshot face).
export {
  serializeCausalityGraph,
  serializeControlFlow,
  serializeHandoffGraph,
} from "./analysis/serialize.js";
// Handoff-graph projection: participant cards and handoff edges, the board's second layer.
export {
  FANOUT_EXPAND_CAP,
  projectHandoffGraph,
  UNPHASED,
  type Handoff,
  type HandoffGraph,
  type HandoffParticipant,
} from "./analysis/handoff-graph.js";
// The unified-analysis core product and its canonical text form:
// site graph / causal graph / actor graph are pure projections over it.
export {
  serializeCore,
  type AnalysisCore,
  type CoreActorSite,
  type CoreAskSite,
  type CoreFacts,
  type CoreFanoutSite,
  type CoreHoleSite,
  type CoreSimpleSite,
  type CoreSites,
  type CoreTypes,
} from "./analysis/core.js";
// core's JSON codecs: sample bundles freeze AnalysisCore into
// core.json; browser consumers recompute projections over the frozen artifact; Maps persist as ordered key-value pair lists.
export {
  decodeAnalysisCore,
  encodeAnalysisCore,
  type AnalysisCoreJson,
} from "./analysis/core-json.js";
export type {
  ActorSite,
  SiteEdge,
  SiteGraph,
  SiteKind,
  SiteLoc,
  SiteNode,
} from "./analysis/types.js";
export {
  buildAskSpecs,
  synthesizeAskSchemas,
  synthesizeWorkflowSchemas,
  type SchemaSynthesisResult,
} from "./schema/synthesize.js";
export { validate, formatViolation, formatViolations } from "./schema/validate.js";
// Per actor-site submit profile: compile-time decision of typed / generic / no submit_result tool for the subagent.
export {
  GENERIC_SUBMIT_PROFILE,
  deriveActorSubmitProfiles,
  deriveActorSubmitProfilesFor,
  type ActorSubmitProfile,
} from "./schema/actor-submit-profiles.js";
export { serializeSchema } from "./schema/serialize.js";
export {
  MAX_UNION_MEMBERS,
  SCHEMA_DIAGNOSTIC_CODE,
  type JsonSchema,
  type JsonSchemaType,
  type JsonValue,
  type Violation,
} from "./schema/types.js";
export {
  HOST_BINDING,
  lowerWorkflow,
  lowerWorkflowScript,
  type LoweredWorkflow,
  type LowerResult,
} from "./lowering/index.js";
export {
  WorkflowEngine,
  InMemoryJournalStore,
  ALL_EVENTS,
  NODE_KINDS,
  NON_REPORT_NODE_KINDS,
  type GetNodeOptions,
  type ListActorsOptions,
  type ListNodesOptions,
  type RunEventType,
  WorkflowError,
  INSTRUCTIONS_HEAD_MAX_CHARS,
  LAST_TOOL_NAME_MAX_CHARS,
  LAST_TOOL_TARGET_MAX_CHARS,
  NUDGE_ATTEMPTS,
  REPAIR_ATTEMPTS,
  canonicalJson,
  fnv1a,
  inputHash,
  refToString,
  type ActorId,
  type ActorRecord,
  type ActorRef,
  type ActorSessionSeed,
  type ArtifactPublishRequest,
  type ArtifactRef,
  type ArtifactVersionRecord,
  type AskMessage,
  type AskLastTool,
  type AskProgress,
  type AskSpec,
  type AskStats,
  type Caps,
  type EngineConfig,
  type ImportedActorCandidate,
  type ImportedAskEntry,
  type ImportedInFlightAsk,
  type ImportedRunCache,
  type ImportedWorldEntry,
  type InstanceRef,
  type JournalStorePort,
  type ListEventsOptions,
  type NodeKind,
  type NodeOutcome,
  type NodeRecord,
  type NodeRecordStatus,
  type WorldReadInput,
  WORLD_READ_INPUT_MAX_BYTES,
  type PersonaSpec,
  type RunEvent,
  type RunRecord,
  type RunSettlement,
  type RunSettlementRecord,
  type RunStallInfo,
  type RunStatus,
  type RunStopReason,
  type SessionRef,
  type StoredEvent,
  type SubmitVerdict,
  type ValidateFn,
  type WorkflowDriver,
  type WorkflowErrorCode,
  type WorkflowErrorJson,
  type ProviderStopDetails,
  type WorkflowErrorMismatch,
  type WorkflowHostApi,
  type WorkflowReportSink,
  type WorldReadOp,
  type AskWaitInfo,
  type ConcurrencyChange,
  type ConcurrencyChangeReason,
} from "./engine/index.js";
export {
  ConcurrencyController,
  CONCURRENCY_DECREASE_FACTOR,
  CONCURRENCY_FLOOR,
  CONCURRENCY_IDLE_RESET_MS,
  CONCURRENCY_INCREASE_AFTER_SUCCESSES,
  CONCURRENCY_INCREASE_STEP,
  type ConcurrencyControllerSnapshot,
  type ConcurrencyThrottleReason,
} from "./engine/index.js";
export {
  HOLE_PROMPT_MAX_CHARS,
  type FilledHole,
  type FillHoleResult,
  type HoleFill,
  type OpenHole,
} from "./engine/index.js";
