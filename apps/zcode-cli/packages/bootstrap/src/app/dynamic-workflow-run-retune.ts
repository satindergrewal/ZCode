// ============================================================
// Dynamic Workflow Run Service: retunes the concurrency bound of one in-flight run in place
// ============================================================
// docs/dynamic-workflow/concurrency.md "Retuning a live run". This is `DynamicWorkflowRunPort.
// retuneConcurrency`'s body, deliberately separate from the three launch entries (dynamic-workflow-run-submit.ts): those
// each **mint a run**; this one mints none -- it only sends a command to the run already in flight.
//
// The two rejections are decided in **different places**, which is exactly what keeps them apart:
//   - `unchanged` is this module's own answer, read from the bound the service holds, decided before the handle is invoked;
//   - the engine's setter then has one way to say false -- the run settled between the two steps -- and the port reports it as `not_live`.
//
// Ordering is load-bearing: handle first (engine swaps caps + writes the row + records the event + the gate raises the bound, one synchronous slice), and only
// then the service's in-memory copy. The reverse would leave an in-memory bound inconsistent with the dwf_run row at the instant the run settles,
// and snapshot/detail reads consume exactly that copy.

import type {
  DynamicWorkflowRunRetuneRequest,
  DynamicWorkflowRunRetuneResult,
} from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import type { RunRegistryEntry } from "./dynamic-workflow-run-observation.js";
import { normalizeRunConcurrency } from "./workflow-default-concurrency.js";

/** Service-internal state borrowed by this module; all references -- this file holds no state of its own. */
export interface DynamicWorkflowRunRetuneContext {
  runs: Map<string, RunRegistryEntry>;
  journal: JournalStorePort;
  /** Same function as the caps default and both read-face tests (see the run service's `defaultConcurrency`). */
  defaultConcurrency: () => number;
}

export function retuneRunConcurrency(
  ctx: DynamicWorkflowRunRetuneContext,
  request: DynamicWorkflowRunRetuneRequest,
): DynamicWorkflowRunRetuneResult {
  const defaultConcurrency = ctx.defaultConcurrency();
  // `null` = default concurrency = clear this run's own bound. The same rule as at submit (floor, >= 1, no ceiling;
  // the tool layer floors once so the reply states the effective value; the port re-checking is the port's own contract — both must agree).
  const next = normalizeRunConcurrency(request.maxConcurrency ?? undefined, defaultConcurrency);

  const entry = ctx.runs.get(request.runId);
  if (entry === undefined || entry.terminal !== undefined || entry.control === undefined) {
    // No live entry in this service: never a run of this process, already settled, or a pre-upgrade
    // entry without a control handle. All three mean the same next step for the caller -- run a real revision.
    return { ok: false, reason: "not_live" };
  }

  // The currently effective bound: **entry first** (all three entry-creating paths write it); cold rows fall back to the journal.
  // Both missing is only a wiring anomaly in the few microtasks between submit and createRun; read as "running at default concurrency".
  const current =
    entry.maxConcurrency ??
    ctx.journal.getRun(request.runId)?.caps.maxConcurrency ??
    defaultConcurrency;
  if (current === next) return { ok: false, reason: "unchanged", current };

  if (!entry.control.setMaxConcurrency(next)) {
    // The entry exists but the engine says unchanged: the run settled between the liveness check and this line (a race), or the engine is not
    // attached yet (the microtasks before launch). Both mean "not retunable in place right now".
    return { ok: false, reason: "not_live", current };
  }
  // Move the in-memory copy too: snapshots read `entry.maxConcurrency ?? row`, entry first -- without this, post-retune
  // reads keep reporting the submission-time number, and AmendWorkflow's resolveInput reads exactly that snapshot to decide what to keep.
  entry.maxConcurrency = next;
  return { ok: true, maxConcurrency: next, previous: current, defaultConcurrency };
}
