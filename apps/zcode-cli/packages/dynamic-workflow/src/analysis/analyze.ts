import { collectDiagnostics, createWorkflowProgram } from "../compiler/compile.js";
import type { CompileDiagnostic } from "../compiler/compile.js";
import { collectSites } from "./sites.js";
import { collectFacadeMisuse } from "./facade-misuse.js";
import { collectWorldRunCommands } from "./world-run.js";
import { collectArtifactDeclarations, type DeclaredArtifact } from "./artifacts.js";
import { collectPhaseMarkerDiagnostics } from "./phases.js";
import { collectHoleDiagnostics } from "./hole-sites.js";
import { collectDuplicateActorNames, FANOUT_ACTOR_NAME_CODE } from "./actor-names.js";
import { collectActorModels, type ModelReference } from "./actor-models.js";
import { interpret } from "./interpret.js";
import { projectSiteGraph } from "./graph.js";
import { projectCausalityGraph, type CausalityGraph } from "./causality-graph.js";
import { projectControlFlow, type ControlFlowGraph } from "./flow-graph.js";
import { projectHandoffGraph, type HandoffGraph } from "./handoff-graph.js";
import type { AnalysisCore } from "./core.js";
import type { SiteGraph } from "./types.js";

/**
 * Result of analyzing a workflow script: the same diagnostics `compileWorkflowScript`
 * produces, plus the analysis core and its two projected views.
 *
 * `ok` means "submittable": any diagnostic clears it. The core and the graphs are present
 * whenever the script was analyzable at all, which is *almost* the same thing — the one
 * diagnostic that leaves them in place is {@link FANOUT_ACTOR_NAME_CODE} (a static actor
 * name inside a fan-out). That clause describes a **run-time** failure, not something that
 * stops the analysis: the shape is perfectly analyzable, and withholding the graph would
 * hide the picture exactly when the author needs it to see which fan-out to fix. So:
 * graphs present ⟸ ok, but not the converse.
 */
export interface AnalyzeResult {
  diagnostics: CompileDiagnostic[];
  ok: boolean;
  /**
   * The all-in-one analysis artifact: taint
   * facts + temporal trace, position-free. `graph` and `causality` are pure projections
   * of it — deriving them again later needs the core only, never the script.
   */
  core?: AnalysisCore;
  graph?: SiteGraph;
  /** The presentation-level happens-before view. */
  causality?: CausalityGraph;
  /** Where execution can go next, per occurrence and per phase. */
  flow?: ControlFlowGraph;
  /** Who takes part in each phase and who hands off to whom. */
  handoff?: HandoffGraph;
  /**
   * The **user-facing artifacts** the script declares: `[{id, kind}]`, deduplicated and sorted
   * by id. A compile product of the same family as world.run's command set — what this workflow
   * will produce is knowable before the run. Unlike the graphs it is **still produced** when
   * diagnostics are non-empty (it is read straight off the site table, no interpretation
   * needed).
   */
  declaredArtifacts: DeclaredArtifact[];
  /**
   * Every model name the script can hand to a subagent, one entry per occurrence
   * (docs/dynamic-workflow/authoring.md "Choosing a model per subagent"). The launch tool
   * resolves them against the host's model catalog before the confirmation dialog
   * (docs/dynamic-workflow/launch.md "Models the script names"). Same rule as
   * `declaredArtifacts`: an empty array when compilation fails, still present when authoring
   * diagnostics exist.
   */
  modelReferences: ModelReference[];
}

/**
 * Typecheck a workflow script and, when clean, interpret it. The pipeline is
 * createWorkflowProgram -> collectSites (the site-table substrate) -> interpret (the
 * fused taint-fixpoint + temporal walk, minting the {@link AnalysisCore}) ->
 * projectSiteGraph / projectCausalityGraph (pure projections of the core).
 *
 * Between the site table and the interpretation runs the facade-siting check
 * ({@link collectFacadeMisuse}): a facade callable that escapes into value space has
 * no site, so the graph cannot represent it. Its diagnostics are surfaced exactly like
 * typechecker diagnostics — `ok: false`, graphs withheld.
 */
export function analyzeWorkflowScript(scriptText: string): AnalyzeResult {
  const workflow = createWorkflowProgram(scriptText);
  const diagnostics = collectDiagnostics(workflow.program);
  // When compilation fails or a facade call escapes, even the site table is untrustworthy, so
  // the artifact list must be empty (a default, not an absence: the reader always gets an array
  // and never has to distinguish "no artifacts" from "could not analyze" at each call site).
  if (diagnostics.length > 0) {
    return { declaredArtifacts: [], diagnostics, modelReferences: [], ok: false };
  }

  const table = collectSites(workflow);
  const misuse = collectFacadeMisuse(workflow, table);
  if (misuse.length > 0) {
    return { declaredArtifacts: [], diagnostics: misuse, modelReferences: [], ok: false };
  }

  // The literal-cmd check for world.run is seated with misuse: a command that takes shape only
  // at run time has no displayable authorization object (the command set shown in the
  // confirmation dialog closes at compile time), so like "facade calls must have sites" it is
  // the rewrite-at-compile-time kind. Phase markers likewise: a
  // non-literal name or a non-statement-position marker refers to nothing.
  // Literal duplicate actor names, same seat: the rule's front door is at run time (the engine's
  // createActor DuplicateActorName); this pass only moves the literal-visible part to the cheap
  // side.
  // All three report together — one pass shows the author everything to fix.
  const worldRun = collectWorldRunCommands(workflow, table);
  // The artifact compile-time rules, same seat: the id is a compile-time literal, tags point at a
  // declared preset, one id does not span both member kinds — all of the
  // "teach the rewrite now rather than explode at run time" kind.
  const artifacts = collectArtifactDeclarations(workflow, table);
  // The closed-ness of the subagent model-name set (9010), same seat: a model name that takes
  // shape only at run time has nothing resolvable/displayable before the confirmation dialog
  // (docs/dynamic-workflow/authoring.md "Choosing a model per subagent").
  const models = collectActorModels(workflow, table);
  const authoring = [
    ...worldRun.diagnostics,
    ...artifacts.diagnostics,
    ...models.diagnostics,
    ...collectPhaseMarkerDiagnostics(workflow, table),
    // The hole compile-time rules (9012), same seat (docs/dynamic-workflow/authoring.md "Holes").
    ...collectHoleDiagnostics(workflow, table),
    ...collectDuplicateActorNames(workflow, table),
  ];
  // A static actor name inside a fan-out (9006) is the only entry in this batch that does **not**
  // withhold the graphs: it says this script would hit DuplicateActorName at run time, not "this
  // code cannot be analyzed" — the shape is perfectly analyzable, and withholding would take the
  // picture away exactly when the author needs it to locate the fan-out to fix. It still clears
  // `ok` (submit stays blocked). A side benefit: the analysis corpus can thereby also pin the
  // graph artifacts of the "static name in a fan-out" shape; otherwise one blocking compile-time
  // diagnostic would make that very shape inexpressible in the corpus.
  const withholding = authoring.filter((d) => d.code !== FANOUT_ACTOR_NAME_CODE);
  if (withholding.length > 0) {
    return {
      declaredArtifacts: artifacts.declaredArtifacts,
      diagnostics: authoring,
      modelReferences: models.references,
      ok: false,
    };
  }

  // One interpretation feeds everything: the core carries the taint facts AND the
  // temporal trace, and both graphs project off it without touching the AST again.
  const core = interpret(workflow, table);
  const graph = projectSiteGraph(core);
  const causality = projectCausalityGraph(core, graph);
  return {
    causality,
    core,
    declaredArtifacts: artifacts.declaredArtifacts,
    diagnostics: authoring,
    flow: projectControlFlow(core),
    graph,
    handoff: projectHandoffGraph(core, causality, graph),
    modelReferences: models.references,
    ok: authoring.length === 0,
  };
}
