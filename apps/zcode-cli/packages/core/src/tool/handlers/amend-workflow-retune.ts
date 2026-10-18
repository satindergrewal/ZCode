// ============================================================
// AmendWorkflow: concurrency-only changes apply in place
// ============================================================
// docs/dynamic-workflow/concurrency.md "Retuning a live run". The engine and driver side
// How a new bound is absorbed: docs/dynamic-workflow/concurrency.md "Retuning a live run".
//
// A call carrying only `run_id` and `max_concurrency` against a live predecessor is **not a revision**: it moves one number in place,
// the run keeps its id, subagents, transcript, and in-flight asks; nothing stops, nothing is replaced, no dialog opens.
// Split from amend-workflow.ts for the same reason as amend-workflow-source.ts (400-line discipline + one concern each):
// that side is the revision handler; this file is the entire route — decision, port call, model-facing copy, and the settlement-race
// facts that must be re-read when the race falls back to a real revision.

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
import { normalizeWorkflowMaxConcurrency } from "./create-workflow-source.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";

/**
 * "Nothing changed but the concurrency" (docs/dynamic-workflow/launch.md): judges the **shape of the input**, not new fields.
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
 * The route decision in resolveInput (docs/dynamic-workflow/launch.md: routing lives in the one step that sees both halves of the condition).
 * On a hit, return normalized input **without a script** — prepareApproval then passes it and the handler calls
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
  /** The bound on the predecessor snapshot; absent means it runs at default concurrency. */
  inherited: number | undefined;
}): { result: true; input: AmendWorkflowInput } | ToolHandlerFailure | undefined {
  const { model, port, predecessor } = options;
  if (!isConcurrencyOnlyAmend(model)) return undefined;
  if (predecessor.status !== "pending" && predecessor.status !== "running") return undefined;
  if (typeof port.retuneConcurrency !== "function") return undefined;

  // The three states are **not** normalized here: `null` must reach the port untouched (see resolveAmendMaxConcurrency).
  const requested = model.max_concurrency ?? null;
  const defaultConcurrency = port.defaultConcurrency?.();
  const unchanged = refuseUnchangedBound(
    model.run_id,
    requested,
    options.inherited,
    defaultConcurrency,
  );
  if (unchanged !== undefined) return unchanged;
  return {
    result: true,
    input: { run_id: model.run_id, max_concurrency: requested, predecessor },
  };
}

/**
 * Same value settles here — before hooks, before the dialog, never touching the port. When the default concurrency is unreadable (older hosts omit
 * `defaultConcurrency`), `null` cannot fold into a number and the net opens: let the port answer `unchanged` itself.
 */
function refuseUnchangedBound(
  runId: string,
  requested: number | null,
  inherited: number | undefined,
  defaultConcurrency: number | undefined,
): ToolHandlerFailure | undefined {
  const current = inherited ?? defaultConcurrency;
  const next = requested === null ? defaultConcurrency : normalizeWorkflowMaxConcurrency(requested);
  if (current === undefined || next === undefined || current !== next) return undefined;
  return retuneUnchangedFailure(runId, current, defaultConcurrency);
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
    // Route decision guarantees "a number or null" here; `?? null` merely reads an absence that bypassed normalization as "back to default".
    maxConcurrency: parsed.max_concurrency ?? null,
  });
  if (answer.ok) {
    return {
      diagnostics: [],
      ok: true,
      // Not entering the background tracker: the run is already in it and stays the same run throughout — no
      // contract left, nothing to compile (docs/dynamic-workflow/launch.md). `retuned` is an **explicit**
      // discriminator block: consumers must not guess from ok-without-status; that shape has other sources.
      response: retuneResponse(parsed.run_id, answer),
      retuned: {
        runId: parsed.run_id,
        maxConcurrency: answer.maxConcurrency,
        previous: answer.previous,
        defaultConcurrency: answer.defaultConcurrency,
      },
    } satisfies CreateWorkflowOutput;
  }
  if (answer.reason === "unchanged") {
    return retuneUnchangedFailure(parsed.run_id, answer.current, port.defaultConcurrency?.());
  }
  return undefined;
}

/**
 * Settlement race (docs/dynamic-workflow/launch.md "When the port says `not_live`"): the same input may right now
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
      ...resolveAmendMaxConcurrency(parsed.max_concurrency, undefined),
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

/** The active bound, worded as a sentence; equal to default concurrency means "no bound of its own". */
function describeBoundInForce(
  bound: number | undefined,
  defaultConcurrency: number | undefined,
): string {
  if (bound === undefined || bound === defaultConcurrency) {
    return defaultConcurrency === undefined
      ? "already runs at the default parallelism"
      : `already runs at the default parallelism (at most ${defaultConcurrency} subagents at once)`;
  }
  return bound === 1
    ? "already runs at most 1 subagent at once"
    : `already runs at most ${bound} subagents at once`;
}

/** Equal value: nothing written, nothing stopped; the rejection names the limit now in effect. */
export function retuneUnchangedFailure(
  runId: string,
  current: number | undefined,
  defaultConcurrency: number | undefined,
): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.RETUNE_UNCHANGED,
    message: `workflow_retune_unchanged: run ${runId} ${describeBoundInForce(current, defaultConcurrency)}, so there is nothing to change. Nothing was stopped, created or changed — pass a different \`max_concurrency\`, or a revised script if you meant to amend the run.`,
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
 * The model-facing reply (docs/dynamic-workflow/launch.md): **names one run, has no successor** — exactly how the model
 * tells which path its call took, without being taught the routing. When the bound equals default concurrency, mark "(default)", the same
 * line `CreateWorkflow` draws.
 *
 * ⚠ This text is the **only** fact surviving into v4: this path has no display payload (the `retuned` block stays in-process; the protocol
 * `toolOutputSchema` carries only text / display / truncated) and the tool card renders the whole line from it. So it
 * must be self-sufficient — name the run, name the current limit, state there is no new run — and stable: rewording is a UI change.
 * Both bound wordings have verbatim tests pinned in core/tests/amend-workflow-permission.test.ts.
 */
function retuneResponse(
  runId: string,
  answer: Extract<DynamicWorkflowRunRetuneResult, { ok: true }>,
): string {
  const count =
    answer.maxConcurrency === 1
      ? "at most 1 subagent runs at once"
      : `at most ${answer.maxConcurrency} subagents run at once`;
  const bound =
    answer.maxConcurrency === answer.defaultConcurrency ? `${count} (the default)` : count;
  return `Applied to the running run ${runId}; ${bound}. Run ${runId} keeps running under it: nothing was stopped and no new run was started.`;
}
