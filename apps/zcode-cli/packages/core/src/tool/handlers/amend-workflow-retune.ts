// AmendWorkflow: take effect in place when only concurrency changes.
// When the call carries only `run_id` and `max_concurrency` and the predecessor is still running, keep the run ID, subagents, transcript and open asks.
// This module owns the routing decision, port call and result wording; if the run settles between decision and call, re-read the predecessor facts,
// then decide whether falling back to the amend flow is allowed.

import {
  AmendWorkflowInputSchema,
  isAmendWorkflowOwnedPredecessor,
  type AmendWorkflowInput,
  type AmendWorkflowPredecessor,
  type CreateWorkflowOutput,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunRetuneResult,
} from "@zcode/contracts";
import type { ToolExecutionContext, ToolHandlerFailure } from "../types.js";
import {
  AMEND_WORKFLOW_ERROR_CODE,
  describePredecessor,
  resolveAmendMaxConcurrency,
  resolveAmendScript,
} from "./amend-workflow-source.js";
import { clampWorkflowMaxConcurrency } from "./create-workflow-source.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";

/**
 * "Nothing changed but concurrency" tests the **shape of the input**, not new fields.
 * `script`, `path`, `subagent_model` and `name`, whatever they carry, send the call down the amend path —
 * each may change what will run, and this path rests on "same script, same subagents".
 *
 * The same holds after normalization: the amend path always settles on a script, so concurrency without a script can only be
 * an in-place retune.
 */
export function isConcurrencyOnlyAmend(model: AmendWorkflowInput): boolean {
  return (
    model.max_concurrency !== undefined &&
    model.script === undefined &&
    model.path === undefined &&
    model.subagent_model === undefined &&
    model.name === undefined
  );
}

/**
 * The routing decision inside resolveInput. On match it returns the normalized input **without a script** — prepareApproval waves it through and the handler calls
 * `retuneConcurrency`; on miss it returns `undefined` and the caller proceeds with the amend as usual.
 *
 * All three premises are required: input shape is concurrency-only, the predecessor still alive (both `pending` and `running` tried; liveness is the port call),
 * and the port supporting this control plane. Without `retuneConcurrency` on the port (older hosts) the path does not exist and the call
 * falls through to the amend as today, confirmation window for another session run included.
 */
export function resolveConcurrencyRetuneRoute(options: {
  model: AmendWorkflowInput;
  port: DynamicWorkflowRunPort;
  predecessor: AmendWorkflowPredecessor;
  /** The limit on the predecessor snapshot; absent means it runs at the ceiling. */
  inherited: number | undefined;
}): { result: true; input: AmendWorkflowInput } | ToolHandlerFailure | undefined {
  const { model, port, predecessor } = options;
  if (!isConcurrencyOnlyAmend(model)) return undefined;
  if (predecessor.status !== "pending" && predecessor.status !== "running") return undefined;
  if (typeof port.retuneConcurrency !== "function") return undefined;

  // The three states are **not** normalized here: `null` must reach the port untouched (see resolveAmendMaxConcurrency).
  const requested = model.max_concurrency ?? null;
  const ceiling = port.concurrencyCeiling?.();
  const unchanged = refuseUnchangedBound(model.run_id, requested, options.inherited, ceiling);
  if (unchanged !== undefined) return unchanged;
  return {
    result: true,
    input: { run_id: model.run_id, max_concurrency: requested, predecessor },
  };
}

/**
 * Equal-to-ceiling collapses here — before hooks, before the confirmation window; the port is never touched. When the ceiling is unreadable (older hosts without
 * `concurrencyCeiling`), `null` cannot be folded into a number, this net steps aside, and `unchanged` is left to the port.
 */
function refuseUnchangedBound(
  runId: string,
  requested: number | null,
  inherited: number | undefined,
  ceiling: number | undefined,
): ToolHandlerFailure | undefined {
  const current = inherited ?? ceiling;
  const next = requested === null ? ceiling : clampWorkflowMaxConcurrency(requested, ceiling);
  if (current === undefined || next === undefined || current !== next) return undefined;
  return retuneUnchangedFailure(runId, current, ceiling);
}

/**
 * The handler-side body: call the port and translate the three answers into model-facing results.
 *
 * `undefined` has one meaning — the port answered `not_live` (or the host lacks the control plane): the call
 * now describes an amend, and {@link resolveRetuneFallbackAmend} decides whether it happens.
 */
export async function runConcurrencyRetune(
  parsed: AmendWorkflowInput,
  context: ToolExecutionContext,
): Promise<CreateWorkflowOutput | ToolHandlerFailure | undefined> {
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.retuneConcurrency !== "function") return undefined;
  const answer = await port.retuneConcurrency({
    runId: parsed.run_id,
    // Routing guarantees a number or null here; `?? null` just reads a normalization-bypassing absence as back-to-ceiling.
    maxConcurrency: parsed.max_concurrency ?? null,
  });
  if (answer.ok) {
    return {
      diagnostics: [],
      ok: true,
      // Not entering the background tracker: the run is already in it and stays the same run throughout — no
      // backgrounded contract, and no compiled artifact to draw. `retuned` is an **explicit**
      // discriminator block: consumers must not guess from ok-without-status; that shape has other sources.
      response: retuneResponse(parsed.run_id, answer),
      retuned: {
        runId: parsed.run_id,
        maxConcurrency: answer.maxConcurrency,
        previous: answer.previous,
        ceiling: answer.ceiling,
      },
    } satisfies CreateWorkflowOutput;
  }
  if (answer.reason === "unchanged") {
    return retuneUnchangedFailure(parsed.run_id, answer.current, port.concurrencyCeiling?.());
  }
  return undefined;
}

/**
 * Settlement race: the same input now
 * describes an amend. Whether it may proceed hinges on one thing — **whether that amend would have prompted at all**.
 *
 * Own-session runs not stopped by the user: the owner rule never prompts anyway, so amend as usual, with the script copy and compile deferred
 * happens now (missing script and compile failures report as the amend own rejections). Another session run, or one the user stopped: reject.
 * This path never prompted, so nothing-approved must not inflate into spawn-another-run.
 */
export async function resolveRetuneFallbackAmend(
  parsed: AmendWorkflowInput,
  context: ToolExecutionContext,
): Promise<{ result: true; input: AmendWorkflowInput } | ToolHandlerFailure> {
  const port = context.dynamicWorkflowRunPort;
  // Re-read the facts: the run just settled between the liveness check and the port call — the input copy still says running.
  const snapshot = port === undefined ? undefined : await port.getTask(parsed.run_id);
  if (snapshot === undefined) return predecessorNotFoundFailure(parsed.run_id);
  const predecessor = describePredecessor(snapshot, context.sessionId);
  if (!isAmendWorkflowOwnedPredecessor(predecessor)) {
    // Not-yet-settled (pending, engine never built) and settled are different statements with the same next step: call once more.
    return predecessor.status === "pending" || predecessor.status === "running"
      ? notRetunableFailure(parsed.run_id)
      : runSettledFailure(parsed.run_id);
  }
  const script = await resolveAmendScript({
    model: parsed,
    cwd: context.workingDirectory,
    port,
    predecessorScriptPath: snapshot.scriptPath,
  });
  if (!script.result) return script;
  return {
    result: true,
    input: AmendWorkflowInputSchema.parse({
      run_id: parsed.run_id,
      ...script.fields,
      // Back on the amend path it is a-number-or-nothing: this call set a value explicitly, nothing to inherit.
      ...resolveAmendMaxConcurrency(
        parsed.max_concurrency,
        undefined,
        port?.concurrencyCeiling?.(),
      ),
      predecessor: {
        ...predecessor,
        ...(script.inherited ? { script_inherited: true as const } : {}),
      },
    }) as AmendWorkflowInput,
  };
}

/** Predecessor missing: same source and wording as the resolveInput one (a mistyped run id deserves one phrasing). */
function predecessorNotFoundFailure(runId: string): ToolHandlerFailure {
  const base = workflowRunNotFoundFailure(runId);
  return {
    ...base,
    message: `${base.message} Nothing was stopped or created: \`run_id\` pointed at a run that does not exist — pass an existing run's ID (see ListWorkflowRuns), or start a fresh run with CreateWorkflow.`,
  };
}

/** The limit now in effect, as one phrase; equal to the ceiling means no limit of its own. */
function describeBoundInForce(bound: number | undefined, ceiling: number | undefined): string {
  if (bound === undefined || bound === ceiling) {
    return "has no limit on how many subagents run at once (it runs at this machine's maximum)";
  }
  return bound === 1
    ? "already runs at most 1 subagent at once"
    : `already runs at most ${bound} subagents at once`;
}

/** Equal value: nothing written, nothing stopped; the rejection names the limit now in effect. */
export function retuneUnchangedFailure(
  runId: string,
  current: number | undefined,
  ceiling: number | undefined,
): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.RETUNE_UNCHANGED,
    message: `workflow_retune_unchanged: run ${runId} ${describeBoundInForce(current, ceiling)}, so there is nothing to change. Nothing was stopped, created or changed — pass a different \`max_concurrency\`, or a revised script if you meant to amend the run.`,
  };
}

/** Another session run, already settled: call once more; that pass runs the amend from the top, confirmation window included. */
export function runSettledFailure(runId: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.RUN_SETTLED,
    message: `workflow_run_settled: run ${runId} settled before the new parallelism limit could take hold, so there is nothing running to retune. Nothing was stopped, created or changed — call AmendWorkflow again if you want a new run of it under that limit.`,
  };
}

/** Another session run this agent never held (`pending`, engine not built): the same next step. */
export function notRetunableFailure(runId: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.NOT_RETUNABLE,
    message: `workflow_run_not_retunable: run ${runId} is not being executed by this agent, so its parallelism cannot be changed in place. Nothing was stopped, created or changed — call AmendWorkflow again if you want a new run of it under that limit.`,
  };
}

/**
 * The model-facing reply: **names one run, no successor** — that is how the model
 * tells which path its call took, without being told the routing. At-ceiling limits are reported as lifted instead of
 * as a number — the same line drawn as in `CreateWorkflow`.
 *
 * ⚠ This text is the **only** fact surviving into v4: this path has no display payload (the `retuned` block stays in-process; the protocol
 * `toolOutputSchema` carries only text / display / truncated) and the tool card renders the whole line from it. So it
 * must be self-sufficient — name the run, name the current limit, state there is no new run — and stable: rewording is a UI change.
 */
function retuneResponse(
  runId: string,
  answer: Extract<DynamicWorkflowRunRetuneResult, { ok: true }>,
): string {
  const bound =
    answer.maxConcurrency === answer.ceiling
      ? "the limit on how many subagents run at once is removed (this machine's maximum applies)"
      : answer.maxConcurrency === 1
        ? "at most 1 subagent runs at once"
        : `at most ${answer.maxConcurrency} subagents run at once`;
  return `Applied to the running run ${runId}; ${bound}. Run ${runId} keeps running under it: nothing was stopped and no new run was started.`;
}
