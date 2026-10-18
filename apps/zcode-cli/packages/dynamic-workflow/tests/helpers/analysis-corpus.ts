/**
 * Diagnostic filter for the analysis corpus (tests/graphs/** and inline scripts in the analysis tests).
 *
 * Corpus scripts never run: their whole job is pinning static-analysis products (site/actor/causality graphs).
 * 9006 (static actor names in fan-out bodies; see src/analysis/actor-names.ts) is a purely runtime matter --
 *
 * Why not fix the corpus (agent("w") to agent(`w-${item}`)): it would migrate 26 fixtures onto the ActorSite.namePattern path -- a different code path entirely -- regenerating ~78 goldens;
 * static-names-in-fan-out is exactly the shape the analyzer must keep handling (ActorNode.family and actor
 * labels render from it). Deleting analyzer coverage for one authoring rule is backwards.
 *
 * The exemption covers 9006 only: 9005 (two literal same-name sites) must still be zero in the corpus -- statically decidable, run or not. Two clauses, two codes, precisely so
 * this exemption can be exact without matching message text.
 */

import type { CompileDiagnostic } from "../../src/index.js";
import { FANOUT_ACTOR_NAME_CODE } from "../../src/analysis/actor-names.js";

/** Corpus-relevant diagnostics: everything but 9006 (corpus never runs, so 9006 cannot apply). */
export function corpusDiagnostics(diagnostics: CompileDiagnostic[]): CompileDiagnostic[] {
  return diagnostics.filter((d) => d.code !== FANOUT_ACTOR_NAME_CODE);
}
