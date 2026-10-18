// ============================================================
// Mid-run notifications and the provider-stop copy table for workflow runs.
// ============================================================
// Split out of notification.ts (eslint max-lines 400 gate): that file carries the terminal-notification skeleton for four task kinds;
// these are the dwf-specific passages — escalation Q&A, run-level stalls, and
// provider stops; the last is shared by the terminal notification and GetWorkflowRun.

import type { DynamicWorkflowRunError } from "@zcode/contracts";
import { escapeXml, truncateTaskNotification } from "./notification.js";

/**
 * The `<error>` block for `stopped(provider)`:
 * two sentences picked by `providerStop.kind` (what broke / what to do), then the fixed fact line and verbatim provider line.
 * Every placeholder has a fallback (provider display name, else providerId, else "the provider") —
 * a notification never degrades into an empty sentence over one missing field. GetWorkflowRun's `<error>` block shares this function.
 */
export function formatWorkflowProviderStopError(
  failure: DynamicWorkflowRunError,
  runId: string,
): string {
  const details = failure.providerStop;
  if (details === undefined) return failure.message;
  const provider = details.providerLabel ?? details.providerId ?? "the provider";
  const providerRef =
    details.providerLabel !== undefined && details.providerId !== undefined
      ? `${details.providerLabel} (${details.providerId})`
      : provider;
  const subagent = details.subagentName ?? details.subagent ?? "a subagent";
  const phase = details.phase === undefined ? "" : ` (phase "${details.phase}")`;
  const model = details.modelId ?? "the current model";
  const code = details.providerCode ?? details.reason;
  const resume = `then call ResumeWorkflowRun with run_id="${runId}"`;
  const sentences = ((): [string, string] => {
    switch (details.kind) {
      case "auth":
        return [
          `Sign-in to ${providerRef} expired while subagent ${subagent}${phase} was running.`,
          `Ask the user to sign in to ${provider} again, ${resume}. Finished steps are kept.`,
        ];
      case "not_configured":
        return [
          `Provider ${details.providerId ?? provider} is not configured on this machine, so subagent ${subagent}${phase} could not send its request.`,
          `Ask the user to configure the provider or switch this session to another model, ${resume}.`,
        ];
      case "model_unavailable":
        return [
          `Model ${model} is not available on ${provider} (not in the user's plan, or retired).`,
          `Ask the user to switch this session to a model the plan includes, ${resume}. Subagents follow the session's model.`,
        ];
      case "invalid_request":
        return [
          `${provider} rejected subagent ${subagent}${phase}'s request as invalid (code ${code}).`,
          `Switching the session to another model usually clears this; ${resume}. If it stops again with the same code, show the raw message to the user.`,
        ];
      case "quota":
        return details.resetAt === undefined
          ? [
              `${provider} reports the user's quota is exhausted (code ${code}).`,
              `Ask the user to top up or upgrade the plan, or switch to another provider, ${resume}.`,
            ]
          : [
              `${provider} reports the user's usage cap is reached (code ${code}); it resets at ${new Date(details.resetAt).toISOString()}.`,
              `Tell the user; after the reset, call ResumeWorkflowRun with run_id="${runId}". Do not rebuild the workflow.`,
            ];
      default:
        return [
          `${provider} refused subagent ${subagent}${phase}'s request with a permanent error (code ${code}).`,
          `Resolve it with the user (the raw message below says what the provider wants), ${resume}.`,
        ];
    }
  })();
  const facts = [
    `provider=${details.providerId ?? "unknown"}`,
    `model=${details.modelId ?? "unknown"}`,
    `subagent=${details.subagent ?? "unknown"}`,
    ...(details.phase === undefined ? [] : [`phase=${details.phase}`]),
    `code=${code}`,
  ].join(" ");
  return [
    sentences[0],
    sentences[1],
    facts,
    ...(details.rawMessage === undefined ? [] : [`raw: ${details.rawMessage}`]),
  ].join("\n");
}

/**
 * Mid-run notification for a run-level stall. Same family as the escalation Q&A:
 * it reports not a terminal state but a fact in progress — the run is alive, just 20 minutes without one successful model request.
 * The copy must nail two things: the model need do **nothing** (especially not cancel/rebuild), and a waiting user
 * deserves to know. Exactly one per stall, no nagging.
 */
export interface WorkflowStallNotificationInput {
  runLabel: string;
  runId: string;
  sinceMs: number;
  reason?: string;
  cap?: number;
}

export function formatWorkflowStallNotification(input: WorkflowStallNotificationInput): string {
  const minutes = Math.max(1, Math.round(input.sinceMs / 60_000));
  const lines = [
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "This is an automated workflow event, NOT a message from the user.",
    "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    "",
    "<workflow-stall>",
    `  <run-id>${escapeXml(input.runId)}</run-id>`,
    `  <run>${escapeXml(input.runLabel)}</run>`,
    `  <since-ms>${Math.max(0, Math.floor(input.sinceMs))}</since-ms>`,
  ];
  if (input.reason !== undefined) {
    lines.push(`  <dominant-reason>${escapeXml(input.reason)}</dominant-reason>`);
  }
  if (input.cap !== undefined) lines.push(`  <cap>${input.cap}</cap>`);
  const reasonClause =
    input.reason === undefined
      ? "the provider keeps failing requests"
      : `the provider keeps answering ${input.reason}`;
  const capClause = input.cap === undefined ? "" : ` (current fan-out ${input.cap})`;
  lines.push(
    "</workflow-stall>",
    "",
    `Workflow run ${input.runLabel} (${input.runId}) has not completed a model request in ${minutes} minutes; ${reasonClause} and the run is retrying with backoff${capClause}.`,
    "It is still running and needs nothing from you. Tell the user if they are waiting on it; they can stop it from the run card. Do not cancel or rebuild it on your own.",
  );
  return truncateTaskNotification(lines.join("\n"));
}

/**
 * A blocking question escalated by an actor from a **running** run.
 *
 * Key difference from the formatters above: those report **terminal states** (work done, read the result); this reports
 * an **unsatisfied obligation** — an actor is parked waiting for an answer, with no timeout backstop.
 * So the copy must nail three things: the question, the verbatim next step (the tool call with its qid), and that the run has
 * not stopped for it (or the model would think the whole workflow awaits and drop everything).
 *
 * The structured half uses XML-ish sections (same family as `<task-notification>`, fields locatable by human and model);
 * the prose half carries the next step and boundaries. **No re-sends, no nagging**: the dropped-question fallback is a snapshot query, not a retry.
 */
export interface WorkflowEscalationNotificationInput {
  /** The run's display name (registry description; the caller has fallen back to runId when absent). */
  runLabel: string;
  runId: string;
  qid: string;
  /** The actor's human-readable name; absent for anonymous actors, where the caller provides a structured ref. */
  actor: string;
  question: string;
  context?: string;
}

export function formatWorkflowEscalationNotification(
  input: WorkflowEscalationNotificationInput,
): string {
  const lines = [
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "This is an automated workflow event, NOT a message from the user.",
    "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    "",
    "<workflow-escalation>",
    `  <run-id>${escapeXml(input.runId)}</run-id>`,
    `  <run>${escapeXml(input.runLabel)}</run>`,
    `  <question-id>${escapeXml(input.qid)}</question-id>`,
    `  <subagent>${escapeXml(input.actor)}</subagent>`,
    `  <question>${escapeXml(input.question)}</question>`,
  ];
  if (input.context !== undefined && input.context.length > 0) {
    lines.push(`  <context>${escapeXml(input.context)}</context>`);
  }
  lines.push(
    "</workflow-escalation>",
    "",
    `Subagent ${input.actor} in workflow run ${input.runLabel} (${input.runId}) escalated a blocking question and is parked on that call waiting for your answer.`,
    `Next step: call ResolveWorkflowQuestion with question_id="${input.qid}" and your answer.`,
    "The run is still running: only the subagent that asked is parked — every other subagent and the script's control flow keep going. So do not drop what you are doing, but do not leave it unanswered either: nothing times out on its behalf.",
    "If this notification is ever lost, GetWorkflowRun lists the questions this run still owes an answer to.",
  );
  return truncateTaskNotification(lines.join("\n"));
}

/**
 * 脚本到达一处留白、等主代理还它代码（docs/dynamic-workflow/transcript-and-notifications.md「What the
 * model reads」的 `<workflow-hole>`）。与升级问答同族：播报的是一件**还没被满足的义务**，没有超时替它
 * 兜底。文案把这几件事说死：去读草稿（函数体在留白处编译、看得见它之前的绑定）、只写语句、返回留白
 * 的类型、带 hole_id 调 FillWorkflowHole；只有这一支停着、run 其余照跑；通知丢了去 GetWorkflowRun。
 */
export interface WorkflowHoleNotificationInput {
  runLabel: string;
  runId: string;
  holeId: string;
  name: string;
  type: string;
  prompt?: string;
  draftPath?: string;
  line?: number;
  before?: string;
  after?: string;
}

export function formatWorkflowHoleNotification(input: WorkflowHoleNotificationInput): string {
  const lines = [
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "This is an automated workflow event, NOT a message from the user.",
    "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    "",
    "<workflow-hole>",
    `  <run-id>${escapeXml(input.runId)}</run-id>`,
    `  <run>${escapeXml(input.runLabel)}</run>`,
    `  <hole-id>${escapeXml(input.holeId)}</hole-id>`,
    `  <name>${escapeXml(input.name)}</name>`,
    `  <type>${escapeXml(input.type)}</type>`,
  ];
  if (input.prompt !== undefined && input.prompt.length > 0) {
    lines.push(`  <prompt>${escapeXml(input.prompt)}</prompt>`);
  }
  if (input.draftPath !== undefined) lines.push(`  <draft>${escapeXml(input.draftPath)}</draft>`);
  if (input.line !== undefined) lines.push(`  <line>${input.line}</line>`);
  if (input.before !== undefined) lines.push(`  <before>${escapeXml(input.before)}</before>`);
  if (input.after !== undefined) lines.push(`  <after>${escapeXml(input.after)}</after>`);
  const where =
    input.before !== undefined && input.after !== undefined
      ? ` between phases "${input.before}" and "${input.after}"`
      : input.before !== undefined
        ? ` after phase "${input.before}"`
        : input.after !== undefined
          ? ` before phase "${input.after}"`
          : "";
  const draft =
    input.draftPath === undefined
      ? "Read the run's script with GetWorkflowRun for the context"
      : `Read the draft at ${input.draftPath}${input.line === undefined ? "" : ` (the hole is on line ${input.line})`} for the context`;
  lines.push(
    "</workflow-hole>",
    "",
    `Workflow run ${input.runLabel} (${input.runId}) reached the hole "${input.name}" (${input.holeId})${where} and is waiting for you to write its body.`,
    `Next step: ${draft}, write the statements of the hole's function, and call FillWorkflowHole with run_id="${input.runId}" and hole_id="${input.holeId}" and the body as \`script\`.`,
    `The body is compiled where the hole stands and sees every binding declared before it; it must return a value of type \`${input.type}\` — or, when the next step is not known yet, do one step and end with a new tail hole of the same type named for the next step (\`return await hole<${input.type}>("…", …)\`); the last fill returns. Write only the statements — not the hole call, not an arrow, not the script around it.`,
    "Only this branch of the script is parked — every other subagent and the rest of the control flow keep going. So do not drop what you are doing, but do not leave it unfilled either: nothing times out on its behalf.",
    "If this notification is ever lost, GetWorkflowRun lists the holes this run is still waiting at.",
  );
  return truncateTaskNotification(lines.join("\n"));
}
