// ============================================================
// GetWorkflowRun Tool Handler
// ============================================================
// Adaptive detail for one workflow run: running → progress summary + log tail; terminal → artifact / failure.
//
// The handler does four things the port cannot:
//   1. Artifact serialization. The port hands over the raw return value; the model-facing text projection has one
//      core implementation (`serializeWorkflowArtifact`, shared by completion notice and TaskOutput). A second,
//      port-side copy would make the same artifact look different in notice and tool.
//   2. Unknown-runId normalization. The port returns `undefined`; the model needs a structured failure.
//   3. One clock read. `generatedAt` taken here once; every model-face how-long-ago computes against it —
//      the formatter stays pure and two ages in one output stay comparable.
//   4. Compose the summary. `summary` assembles deterministically from structured fields (get-workflow-run-summary.ts),
//      no model in the loop.
//
// Deliberately no wait/block semantics: waiting is TaskOutput work; this is an instant snapshot.

import {
  GET_WORKFLOW_RUN_MAX_HOLES,
  GET_WORKFLOW_RUN_TOOL_NAME,
  GetWorkflowRunInputJsonSchema,
  GetWorkflowRunInputSchema,
  GetWorkflowRunOutputJsonSchema,
  GetWorkflowRunOutputSchema,
  type GetWorkflowRunInput,
  type GetWorkflowRunOutput,
} from "@zcode/contracts";
import { serializeWorkflowArtifact } from "../executor/workflow-artifact.js";
// ⚠ Two artifacts: the first serializes the script top-level return value (into `<result>`); the second describes
// outputs the script published for the user via `artifact.*` (into `<artifacts>`). One word, two senses; both appear here.
import { WORKFLOW_ARTIFACTS_INTROSPECTION_MAX_LINES } from "../executor/workflow-published-artifacts.js";
import type { ToolEntry, ToolHandler } from "../types.js";
import { formatGetWorkflowRunModelContent } from "./get-workflow-run-format.js";
import {
  toGetWorkflowRunHealth,
  toGetWorkflowRunPhases,
  toGetWorkflowRunSubagents,
} from "./get-workflow-run-roster-output.js";
import { buildWorkflowRunSummary } from "./get-workflow-run-summary.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";
import {
  WORKFLOW_RUN_INTROSPECTION_STEERING,
  workflowIntrospectionUnavailableFailure,
  workflowRunNotFoundFailure,
} from "./workflow-run-introspection.js";

const GET_WORKFLOW_RUN_TIMEOUT_MS = 10_000;
/** Per TaskOutput: artifacts are exactly payloads large enough to need one. */
const GET_WORKFLOW_RUN_RESULT_BUDGET_BYTES = 400_000;
const GET_WORKFLOW_RUN_PERSIST_THRESHOLD_CHARS = 100_000;

const GET_WORKFLOW_RUN_DESCRIPTION = [
  "Returns the current state of one dynamic-workflow run: progress, token usage and the tail of its log() narration while it runs; the final result once it completed; the structured failure if it errored or was stopped.",
  "",
  WORKFLOW_RUN_INTROSPECTION_STEERING,
  "",
  "- Takes run_id — from CreateWorkflow's or AmendWorkflow's result, from a completion notification, or from ListWorkflowRuns.",
  "- This is an instant snapshot and never waits. To block until a run THIS session started finishes, use TaskOutput instead: that is the waiting tool. GetWorkflowRun is the right tool when you must not wait, or when the run belongs to another session (TaskOutput cannot see those).",
  "- The `artifacts` section lists what the run published for the user — files, documents and live dashboards that are ALREADY shown to them as cards. Refer to one by its title; do not paste its contents back. The one marked `primary` is the deliverable: point the user to it first.",
  "- Three terminal states: `completed`; `errored` (the script itself failed — not resumable, amend it); `stopped` with a stop reason — `user` (cancelled on purpose: resume only when the user asks), `model` (your own TaskStop), `provider` (a provider-side error such as an expired sign-in, a model missing from the plan or a quota cap — the `<error>` block names the cause and the fix; resolve it with the user, then resume), `interrupted` (the process that owned the run exited — continuing it is usually what the user wants), `superseded` (an AmendWorkflow replaced it; `<superseded_by>` names the successor — read that run instead, never resume this one).",
  "- A stopped run (other than a superseded one) can be continued with ResumeWorkflowRun — no rebuild needed, same run ID, same script.",
  "- ANY run — completed, stopped, errored, or still running — can instead be revised with AmendWorkflow: pass its run ID and the corrected script, and the finished work is imported as cache. When the script itself errored, that is the move — fix the script and keep the work that already succeeded, rather than rewriting from scratch.",
].join("\n");

const getWorkflowRunHandler: ToolHandler = async (input, context) => {
  const parsed = GetWorkflowRunInputSchema.parse(input) as GetWorkflowRunInput;

  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.getRunDetail !== "function") {
    return workflowIntrospectionUnavailableFailure();
  }

  const detail = await port.getRunDetail(parsed.run_id);
  // An empty object would read existing-but-empty; unknown runId is a first-class failure.
  if (detail === undefined) return workflowRunNotFoundFailure(parsed.run_id);

  // A `undefined` result → field absent (completion-notice rule). `null` is a legal result, serialized "null".
  const result = serializeWorkflowArtifact(detail.result);
  // One call, one ruler: every how-long-ago uses this reading; two ages stay comparable.
  const generatedAt = Date.now();
  const roster = toGetWorkflowRunSubagents(detail.subagents);
  const phases = toGetWorkflowRunPhases(detail.phases);

  const base = {
    runId: detail.runId,
    label: detail.label,
    labelSource: detail.labelSource,
    status: detail.status,
    ...(detail.stopReason === undefined ? {} : { stopReason: detail.stopReason }),
    ...(detail.resumedFrom === undefined ? {} : { resumedFrom: detail.resumedFrom }),
    // The port emits this field only when the bound differs from default (a run at default has nothing to say), so forward it verbatim.
    // already absent-means-absent.
    ...(detail.maxConcurrency === undefined ? {} : { maxConcurrency: detail.maxConcurrency }),
    // Same absent-means-absent rule: a run on the session model states nothing. An AmendWorkflow omitting
    // `subagent_model` inherits exactly this string; it must stay readable in the model face.
    ...(detail.subagentModel === undefined ? {} : { subagentModel: detail.subagentModel }),
    // Same "absent when unset" rule: a run whose script named no models has nothing to say. In a revision, same-name models inherit exactly these bindings.
    ...(detail.modelBindings === undefined ? {} : { modelBindings: detail.modelBindings }),
    // Same rule: no script file, nothing to state. The port gives the absolute path (run identity);
    // the model face, workspace-relative — the model will Edit it, and that is the form it uses elsewhere.
    ...(detail.scriptPath === undefined
      ? {}
      : { scriptPath: describeWorkflowScriptPath(detail.scriptPath, context.workingDirectory) }),
    ...(detail.supersededBy === undefined ? {} : { supersededBy: detail.supersededBy }),
    ownedByThisSession: detail.ownedByThisSession,
    ...(detail.possiblyInterrupted ? { possiblyInterrupted: true } : {}),
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    generatedAt,
    usage: {
      spentTokens: detail.usage.spentTokens,
      nodesObserved: detail.usage.nodesObserved,
      nodesRunning: detail.usage.nodesRunning,
      nodesCompleted: detail.usage.nodesCompleted,
      nodesFailed: detail.usage.nodesFailed,
    },
    actors: detail.actors.map((actor) => ({
      siteId: actor.siteId,
      ordinal: actor.ordinal,
      ...(actor.name === undefined ? {} : { name: actor.name }),
    })),
    logTail: detail.logTail.map((entry) => ({
      sequence: entry.sequence,
      message: entry.message,
      // Event persisted-time; absent in old journals without the column — those rows carry no age prefix.
      ...(entry.at === undefined ? {} : { at: entry.at }),
    })),
    // The situation cross-section (phases / roster / health): the counts become a where-is-it, who-does-what,
    // is-it-moving report. Field-by-field mapping in get-workflow-run-roster-output.ts.
    ...(phases === undefined ? {} : { phases }),
    subagents: roster.subagents,
    ...(roster.truncated ? { subagentsTruncated: true as const } : {}),
    health: toGetWorkflowRunHealth(detail.health),
    ...(result === undefined ? {} : { result }),
    ...(detail.error === undefined
      ? {}
      : {
          error: {
            code: detail.error.code,
            message: detail.error.message,
            ...(detail.error.providerStop === undefined
              ? {}
              : { providerStop: detail.error.providerStop }),
          },
        }),
    // Zero rows → field absent (the port never emits empty arrays; re-checked, not `?? []`): an empty
    // pending section reads asked-and-answered; absence reads nobody-waiting.
    ...(detail.pendingQuestions === undefined || detail.pendingQuestions.length === 0
      ? {}
      : {
          pendingQuestions: detail.pendingQuestions.map((pending) => ({
            qid: pending.qid,
            actor: pending.actor,
            ...(pending.actorName === undefined ? {} : { actorName: pending.actorName }),
            question: pending.question,
            ...(pending.context === undefined ? {} : { context: pending.context }),
            askedAt: pending.askedAt,
          })),
        }),
    // Holes (docs/dynamic-workflow/launch.md "The `FillWorkflowHole` tool"): same rule as pendingQuestions,
    // the whole field absent at zero; the cap 32 matches the display contract's hole bound.
    ...(detail.holes === undefined || detail.holes.length === 0
      ? {}
      : {
          holes: detail.holes.slice(0, GET_WORKFLOW_RUN_MAX_HOLES).map((hole) => ({
            siteId: hole.siteId,
            ordinal: hole.ordinal,
            name: hole.name,
            type: hole.type,
            state: hole.state,
            ...(hole.since === undefined ? {} : { since: hole.since }),
            ...(hole.filledAt === undefined ? {} : { filledAt: hole.filledAt }),
            ...(hole.filledBy === undefined ? {} : { filledBy: hole.filledBy }),
          })),
        }),
    // User-facing artifacts; none present → field absent. The cap 32 equals
    // `ARTIFACT_CAPS.maxArtifactsPerRun` — the port gives no more; this pins the bound in
    // the model face. `bytes` hangs on version entries only; take the latest (the list describes the latest).
    ...(detail.artifacts === undefined || detail.artifacts.length === 0
      ? {}
      : {
          artifacts: detail.artifacts
            .slice(0, WORKFLOW_ARTIFACTS_INTROSPECTION_MAX_LINES)
            .map((artifact) => {
              const latest = artifact.versions[artifact.versions.length - 1];
              return {
                id: artifact.id,
                kind: artifact.kind,
                ...(artifact.title === undefined ? {} : { title: artifact.title }),
                version: artifact.version,
                ...(artifact.contentType === undefined
                  ? {}
                  : { contentType: artifact.contentType }),
                ...(latest?.bytes === undefined ? {} : { bytes: latest.bytes }),
                ...(artifact.sourcePath === undefined ? {} : { sourcePath: artifact.sourcePath }),
                itemCount: artifact.itemCount,
                ...(artifact.primary === true ? { primary: true as const } : {}),
              };
            }),
        }),
  } satisfies Omit<GetWorkflowRunOutput, "summary">;

  // The summary composes last: it reads exactly the fields above — facts, then the sentence.
  return { ...base, summary: buildWorkflowRunSummary(base) } satisfies GetWorkflowRunOutput;
};

export const getWorkflowRunToolEntry: ToolEntry = {
  capability: "Read one dynamic-workflow run's progress, final result, or failure",
  maxModelChars: GET_WORKFLOW_RUN_PERSIST_THRESHOLD_CHARS,
  metadata: {
    name: GET_WORKFLOW_RUN_TOOL_NAME,
    description: GET_WORKFLOW_RUN_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: GET_WORKFLOW_RUN_TIMEOUT_MS,
    maxOutputBytes: GET_WORKFLOW_RUN_RESULT_BUDGET_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: getWorkflowRunHandler,
  inputSchema: GetWorkflowRunInputJsonSchema,
  outputSchema: GetWorkflowRunOutputJsonSchema,
  runtimeInputSchema: GetWorkflowRunInputSchema,
  runtimeOutputSchema: GetWorkflowRunOutputSchema,
  formatModelContent: formatGetWorkflowRunModelContent,
  permission: {
    permission: "getWorkflowRun",
    reason: "GetWorkflowRun reads one run's record from the project's run journal",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // run_id into the pattern-match face (as TaskOutput task_id) so project rules can address a run.
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: GET_WORKFLOW_RUN_RESULT_BUDGET_BYTES,
    maxModelBytes: GET_WORKFLOW_RUN_RESULT_BUDGET_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: GET_WORKFLOW_RUN_RESULT_BUDGET_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  resultArtifactContentType: "text/plain",
  timeout: {
    kind: "timed",
    defaultMs: GET_WORKFLOW_RUN_TIMEOUT_MS,
    maxMs: GET_WORKFLOW_RUN_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage:
      "GetWorkflowRun reads the run journal synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
