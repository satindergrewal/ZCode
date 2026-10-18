// ============================================================
// The GetWorkflowRun model face: TaskOutput-style XML-ish blocks
// ============================================================
// Split from the handler (that file hit its 400-line
// cap); the situation blocks split again from here into get-workflow-run-format-roster.ts.
//
// A **pure function** `(output) => text`: every clock reading was placed into `generatedAt` by the handler;
// the formatter never touches `Date.now()`. One output, one ruler — two how-long-ago values in one output
// stay comparable, and tests pin the whole text verbatim.
//
// Block order is contract (fixed): the one-line situation, then identity and lifecycle, then
// **what awaits the model now** (parked questions), and only then run health, narrative, outcome and routing.

import {
  GetWorkflowRunOutputSchema,
  type GetWorkflowRunOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import { formatWorkflowProviderStopError } from "../../runtime-task/notification.js";
import { formatPublishedArtifactLine } from "../executor/workflow-published-artifacts.js";
import {
  formatWorkflowRunHealthBlock,
  formatWorkflowRunLogTailBlock,
  formatWorkflowRunPhasesBlock,
  formatWorkflowRunSubagentsBlock,
} from "./get-workflow-run-format-roster.js";
import {
  escapeWorkflowRunText,
  formatRelativeAge,
  formatWorkflowRunInstant,
  formatWorkflowRunTimestamp,
  workflowRunAttribute,
} from "./workflow-run-introspection.js";

/** Terminal-state words: the run has no next action (same set as the summary side). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "errored", "stopped"]);

/**
 * The line for pending questions that cannot be read. One of the two speak-the-unknown spots in this tool:
 * silence reads as nobody-is-waiting, the most dangerous misread — an actor parked there, no timeout backstop.
 */
const PENDING_QUESTIONS_UNKNOWN =
  "Unknown: pending questions are tracked only by the process that owns the run, and this session does not. Resuming the run will re-ask any question its subagent still needs answered.";

const PENDING_QUESTIONS_INSTRUCTION =
  "Each of these subagents is parked waiting for an answer and nothing times out on its behalf. Answer one with ResolveWorkflowQuestion using the ID in brackets. The rest of the run keeps running meanwhile.";

export function formatGetWorkflowRunModelContent(output: unknown): ModelMessageContent {
  const parsed = GetWorkflowRunOutputSchema.safeParse(output);
  if (!parsed.success) return "GetWorkflowRun returned an invalid result.";
  const run = parsed.data;
  const terminal = TERMINAL_STATUSES.has(run.status);

  const blocks = [
    // The situation sentence leads: every later block expands it; the reader must know what this is.
    `<summary>${escapeWorkflowRunText(run.summary)}</summary>`,
    ...identityBlocks(run),
    ...pendingQuestionBlocks(run),
    formatWorkflowRunHealthBlock(run, terminal),
    ...optionalBlock(formatWorkflowRunPhasesBlock(run, terminal)),
    formatWorkflowRunSubagentsBlock(run),
    formatWorkflowRunLogTailBlock(run),
    usageBlock(run),
    ...outcomeBlocks(run),
    ...routingBlocks(run),
  ];
  return blocks.join("\n\n");
}

function optionalBlock(block: string | undefined): string[] {
  return block === undefined ? [] : [block];
}

/** Identity and lifecycle: one fact, one label; absent facts leave no empty labels. */
function identityBlocks(run: GetWorkflowRunOutput): string[] {
  const blocks = [
    `<run_id>${escapeWorkflowRunText(run.runId)}</run_id>`,
    `<label ${workflowRunAttribute("source", run.labelSource)}>${escapeWorkflowRunText(run.label)}</label>`,
    `<status>${escapeWorkflowRunText(run.status)}</status>`,
    ...(run.stopReason === undefined
      ? []
      : [`<stop_reason>${escapeWorkflowRunText(run.stopReason)}</stop_reason>`]),
    ...(run.resumedFrom === undefined
      ? []
      : [`<resumed_from>${escapeWorkflowRunText(run.resumedFrom)}</resumed_from>`]),
    // Present only when this run lowered concurrency itself (the port absent-means-absent rule). An AmendWorkflow omitting
    // `max_concurrency` inherits exactly this number — how the model knows what an amend keeps.
    ...(run.maxConcurrency === undefined
      ? []
      : [`<max_concurrency>${run.maxConcurrency}</max_concurrency>`]),
    // Same family of run-level setting as the line above: present only when this run chose a subagent model itself.
    ...(run.subagentModel === undefined
      ? []
      : [`<subagent_model>${escapeWorkflowRunText(run.subagentModel)}</subagent_model>`]),
    ...(run.supersededBy === undefined
      ? []
      : [`<superseded_by>${escapeWorkflowRunText(run.supersededBy)}</superseded_by>`]),
    `<owned_by_this_session>${run.ownedByThisSession}</owned_by_this_session>`,
  ];
  if (run.possiblyInterrupted) {
    blocks.push(
      "<possibly_interrupted>true — this session cannot confirm the run is still alive</possibly_interrupted>",
    );
  }
  // ISO + age: the former is checkable fact, the latter the quantity the reader wants.
  blocks.push(
    `<created_at>${formatWorkflowRunInstant(run.generatedAt, run.createdAt)}</created_at>`,
  );
  blocks.push(
    `<updated_at>${formatWorkflowRunInstant(run.generatedAt, run.updatedAt)}</updated_at>`,
  );
  return blocks;
}

/**
 * A parked escalation question, ahead of health / roster / narrative: those blocks say how the run is doing;
 * this one is **a thing awaiting the model now** — buried, the only unblock path hides.
 */
function pendingQuestionBlocks(run: GetWorkflowRunOutput): string[] {
  if (!run.health.pendingQuestionsKnown) {
    return [`<pending_questions>${PENDING_QUESTIONS_UNKNOWN}</pending_questions>`];
  }
  const questions = run.pendingQuestions ?? [];
  if (questions.length === 0) return [];
  const rendered = questions.map((question) => {
    const who = question.actorName ?? question.actor;
    const age = formatRelativeAge(run.generatedAt, question.askedAt);
    const asked =
      age === undefined
        ? `asked at ${formatWorkflowRunTimestamp(question.askedAt)}`
        : `asked ${age}`;
    const lines = [
      `[${escapeWorkflowRunText(question.qid)}] ${escapeWorkflowRunText(who)} ${asked}`,
      escapeWorkflowRunText(question.question),
    ];
    if (question.context !== undefined)
      lines.push(`context: ${escapeWorkflowRunText(question.context)}`);
    return lines.join("\n");
  });
  return [
    `<pending_questions>\n${rendered.join("\n\n")}\n\n${PENDING_QUESTIONS_INSTRUCTION}\n</pending_questions>`,
  ];
}

/** nodes_observed counts persisted node rows, never posed as a total: dynamic workflows have no static total. */
function usageBlock(run: GetWorkflowRunOutput): string {
  const usage = [
    `spent_tokens=${run.usage.spentTokens}`,
    `nodes_observed=${run.usage.nodesObserved}`,
    `nodes_running=${run.usage.nodesRunning}`,
    `nodes_completed=${run.usage.nodesCompleted}`,
    `nodes_failed=${run.usage.nodesFailed}`,
  ].join(" ");
  return `<usage>${usage}</usage>`;
}

/** The run outcome: artifact → failure → user-facing artifact list (completion-notice order). */
function outcomeBlocks(run: GetWorkflowRunOutput): string[] {
  const blocks: string[] = [];
  if (run.result !== undefined) {
    // The artifact goes in raw (no escaping): it may be a JSON or code block, and escaping would alter it.
    blocks.push(`<result>\n${run.result}\n</result>`);
  }
  if (run.error !== undefined) {
    // Provider stop: `<error>` is the whole block from the same function as the terminal notice (cause → action → facts → raw),
    // so both read faces show the same words; like `<result>`, raw — it contains `run_id="…"` fragments
    // the model must copy; &quot; escaping would make it copy wrong. Other failures keep the one-line message.
    const body =
      run.error.providerStop === undefined
        ? escapeWorkflowRunText(run.error.message)
        : `\n${formatWorkflowProviderStopError(run.error, run.runId)}\n`;
    blocks.push(`<error ${workflowRunAttribute("code", run.error.code)}>${body}</error>`);
  }
  // User-facing artifacts come **after** result / error (completion-notice order): the outcome is read first;
  // the deliverable list is the index. Line format is shared verbatim with the completion-notice formatter.
  if (run.artifacts !== undefined && run.artifacts.length > 0) {
    const lines = run.artifacts.map((artifact) =>
      escapeWorkflowRunText(formatPublishedArtifactLine(artifact)),
    );
    blocks.push(`<artifacts count="${run.artifacts.length}">\n${lines.join("\n")}\n</artifacts>`);
  }
  return blocks;
}

/** Routing: superseded → the successor only; otherwise resumable and amendable get separate blocks, each its own. */
function routingBlocks(run: GetWorkflowRunOutput): string[] {
  const blocks: string[] = [];
  if (run.stopReason === "superseded") {
    // A superseded run cannot resume (the successor lives) and must not be amended — the successor is the one to amend.
    const successor =
      run.supersededBy === undefined
        ? "its successor"
        : `run ${escapeWorkflowRunText(run.supersededBy)}`;
    blocks.push(
      `<superseded>This run was stopped by an AmendWorkflow and superseded by ${successor}, which owns its unfinished work. Do not resume it (ResumeWorkflowRun will refuse) and do not amend it again; read or amend ${successor} instead.</superseded>`,
    );
    return blocks;
  }
  if (isWorkflowRunResumableOutput(run)) blocks.push(formatResumableHint(run));
  blocks.push(formatAmendableHint(run));
  return blocks;
}

/**
 * All four stop reasons are resumable, next steps differ: user was deliberate (resume on request); provider needs its cause fixed;
 * model / interrupted resume directly. The hint carries this, or the model resumes a fresh cancellation as a crash.
 */
function formatResumableHint(run: GetWorkflowRunOutput): string {
  const reasonSentence =
    run.stopReason === "user"
      ? " This run was stopped on purpose by the user: resume it only when the user asks."
      : run.stopReason === "model"
        ? " You stopped this run yourself with TaskStop: resume it unchanged only if that is what the user wants. If you stopped it to fix the script, do not wait — amend it now, see <amendable>."
        : run.stopReason === "provider"
          ? " A provider-side error stopped it: resolve the cause named in <error> with the user before resuming, or it will stop again the same way."
          : "";
  return `<resumable>This run can be continued with ResumeWorkflowRun — it will resume under the same run ID, replaying finished steps and re-dispatching the unfinished ones.${reasonSentence} The script must be byte-for-byte the one this run was started with; to change it, see <amendable>.</resumable>`;
}

/**
 * The amend-resume routing hint. **Beside `<resumable>`, not instead**: different predicates,
 * different actions, hence separate blocks stating the difference (same run and script vs new run and script).
 *
 * The closing line forks on state: a real script failure is the top-value amend (the fix keeps the cache), and the model reflex —
 * rewrite from scratch — would discard work already paid for in tokens.
 *
 * **A healthy running run gets one line**: no decision awaits; the full routing argument would only crowd
 * out roster reading; stalled, never-started or terminal runs get the full argument.
 */
function formatAmendableHint(run: GetWorkflowRunOutput): string {
  // Both branches carry the script-file line; the healthy-running one
  // keeps it to one line, and that line is how-to-amend — no file, and the model re-pastes the whole script inline.
  const scriptSentence =
    run.scriptPath === undefined
      ? ""
      : ` Its script is at ${escapeWorkflowRunText(run.scriptPath)}: edit that file in place and pass \`path: "${escapeWorkflowRunText(run.scriptPath)}"\` to AmendWorkflow instead of a script.`;
  if (run.status === "running" && run.health.stalledSince === undefined) {
    return `<amendable>AmendWorkflow with run_id "${escapeWorkflowRunText(run.runId)}" supersedes this run with a revised script and imports its finished work as cache.${scriptSentence}</amendable>`;
  }
  const tail =
    run.status === "errored"
      ? "This is the highest-value case for it: the script itself failed, so fix the script and re-run — every step that already succeeded is imported instead of being paid for a second time. Do NOT rewrite from scratch."
      : run.status === "completed"
        ? "Use it to extend or refine a finished workflow — added steps run live, unchanged ones cost nothing."
        : run.status === "stopped"
          ? "Use it when the script or a setting needs to change; use ResumeWorkflowRun to continue it unchanged. A run stopped because its script was wrong is amended now, not after the user asks: the cache holds everything that settled before the stop, and waiting buys nothing."
          : "It is still running: if the script is visibly wrong, amend it now — AmendWorkflow stops this run, imports everything that settled so far, and starts the revision in one call. Do not TaskStop it first and do not wait for it to finish.";
  const body = [
    `This run can be superseded by a revised script: call AmendWorkflow with \`run_id: "${escapeWorkflowRunText(run.runId)}"\` and your new script.`,
    "That mints a NEW run and imports this one's finished work as a warm cache — matched per named subagent along its conversation prefix — so steps you did not change settle from cache at zero tokens and only the revised part runs live.",
    // Omitted means inherited: say nothing and
    // the model re-pastes the whole script to change one number.
    "To change only its settings (max_concurrency, subagent_model, name), omit both `script` and `path`: the new run keeps this run's script.",
    tail,
  ].join(" ");
  return `<amendable>${body}${scriptSentence}</amendable>`;
}

/**
 * The resolvable-terminal predicate, **same semantics** as the `port.resume` gate:
 * `stopped`, any reason. **Never** widen to `errored`: replaying a really-failed run reproduces the failure verbatim.
 * A routing preview, not a promise; the gate lives server-side in port.resume.
 */
function isWorkflowRunResumableOutput(run: GetWorkflowRunOutput): boolean {
  return run.status === "stopped";
}
