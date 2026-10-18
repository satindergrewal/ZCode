// ============================================================
// `hole-reached` -> one model-visible in-run notification (the hole)
// ============================================================
// Per docs/dynamic-workflow/transcript-and-notifications.md `hole` payload and "What the model reads"; engine-side
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Holes」。
//
// split out of dynamic-workflow-run-progress.ts (400-line gate), same layer as its escalation / stall emitters, same three disciplines:
// **exactly one notification per `hole-reached`** (no re-sends, no nagging; the fallback after a loss is GetWorkflowRun's `holes`);
// **`hole-filled` sends nothing** (the filler is the main agent itself; the tool result is the receipt); **never throws**
// (this is the observation surface; the run's truth lives in the journal).
//
// Unlike the other two: the event payload carries only site, name, and prompt, while the notification also speaks type, draft path and line, and
// surrounding phases — compile artifacts living on the snapshot's `holes[]` and `scriptPath`. So this reads the port snapshot once (bounded:
// one hole, once); when the port is absent or unreadable, fall back to fields the payload itself carries — the notice still goes out, a few sentences shorter.

import type { DynamicWorkflowRunHole } from "@zcode/contracts";
import type { DynamicWorkflowRunProgressPayload, TraceContext } from "../deps.js";
import { formatWorkflowHoleNotification } from "../../runtime-task/workflow-notification-copy.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** Event kind of the hole-reached arrival (the engine's `RunEvent.type`). */
export const HOLE_REACHED_EVENT_TYPE = "hole-reached";

/** Bound for the manifest payload's and notification's prompt (spec: 4000 chars, truncated with `…`, same bound as the escalation notice). */
const WORKFLOW_HOLE_PROMPT_MAX_CHARS = 4_000;
const PROMPT_ELLIPSIS = "…";

export async function notifyHoleReached(
  this: AgentRuntimeInternal,
  payload: DynamicWorkflowRunProgressPayload,
  traceContext: TraceContext,
): Promise<void> {
  if (payload.eventType !== HOLE_REACHED_EVENT_TYPE) return;
  const instance = payload.payload.instance as Record<string, unknown> | undefined;
  const siteId = stringField(instance, "siteId");
  const ordinal = numberField(instance, "ordinal");
  const name = stringField(payload.payload, "name");
  if (siteId === undefined || ordinal === undefined || name === undefined) {
    this.logger?.warn?.("Dynamic workflow hole notification skipped: malformed payload", {
      event: "dynamic_workflow.hole.notification_skipped",
      module: "core.runtime",
      runId: payload.runId,
      sequence: payload.sequence,
    });
    return;
  }

  const snapshot = await readHoleSnapshot(this, payload.runId, siteId, ordinal);
  // The display-name fallback chain matches the other two notices: registry entry description -> runId.
  const runLabel = this.runtimeTaskRegistry.get(payload.runId)?.description ?? payload.runId;
  const prompt = boundPrompt(stringField(payload.payload, "prompt"));
  // Type, line, and surrounding phases come from the snapshot's hole entry; if the payload also carries them (future engine), the payload wins.
  const type = stringField(payload.payload, "type") ?? snapshot.hole?.type ?? "unknown";
  const line = numberField(payload.payload, "line") ?? snapshot.hole?.line;
  const before = stringField(payload.payload, "before") ?? snapshot.hole?.before;
  const after = stringField(payload.payload, "after") ?? snapshot.hole?.after;
  const draftPath = stringField(payload.payload, "draftPath") ?? snapshot.scriptPath;
  const reachedAt = numberField(payload.payload, "reachedAt") ?? snapshot.hole?.since;

  const facts = {
    ...(prompt === undefined ? {} : { prompt }),
    ...(draftPath === undefined ? {} : { draftPath }),
    ...(line === undefined ? {} : { line }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
  this.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "workflow",
      title: runLabel,
      // workId = runId: same display anchor as the run's other notifications.
      workId: payload.runId,
      // Manifest payload (hole discriminant): the GUI's hole row reads the three live states from the run projection's `holes`.
      workflowNotification: {
        kind: "hole",
        siteId,
        ordinal,
        name,
        type,
        ...facts,
        ...(reachedAt === undefined ? {} : { reachedAt }),
      },
    },
    // taskId lets the notification inherit the run's branchGeneration (fencing for late notices); after dropping, the fallback is a snapshot query.
    taskId: payload.runId,
    text: formatWorkflowHoleNotification({
      runLabel,
      runId: payload.runId,
      holeId: siteId,
      name,
      type,
      ...facts,
    }),
    traceContext,
  });
}

/** One snapshot read for this hole's entry and draft path; absent port / read failure / no entry all just mean "nothing". */
async function readHoleSnapshot(
  runtime: AgentRuntimeInternal,
  runId: string,
  siteId: string,
  ordinal: number,
): Promise<{ hole?: DynamicWorkflowRunHole; scriptPath?: string }> {
  const port = runtime.dynamicWorkflowRunPort;
  if (port === undefined) return {};
  try {
    const snapshot = await port.getTask(runId);
    if (snapshot === undefined) return {};
    const holes = snapshot.holes ?? [];
    const hole =
      holes.find((entry) => entry.siteId === siteId && entry.ordinal === ordinal) ??
      holes.find((entry) => entry.siteId === siteId);
    return {
      ...(hole === undefined ? {} : { hole }),
      ...(snapshot.scriptPath === undefined ? {} : { scriptPath: snapshot.scriptPath }),
    };
  } catch (error) {
    runtime.logger?.warn?.("Dynamic workflow hole notification: snapshot read failed", {
      event: "dynamic_workflow.hole.snapshot_failed",
      module: "core.runtime",
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/** Bound of the prompt: past it, truncate to the limit and end with `…` (backing up one code unit if the last char splits a surrogate pair). */
function boundPrompt(prompt: string | undefined): string | undefined {
  if (prompt === undefined) return undefined;
  if (prompt.length <= WORKFLOW_HOLE_PROMPT_MAX_CHARS) return prompt;
  let head = prompt.slice(0, WORKFLOW_HOLE_PROMPT_MAX_CHARS - PROMPT_ELLIPSIS.length);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}${PROMPT_ELLIPSIS}`;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
