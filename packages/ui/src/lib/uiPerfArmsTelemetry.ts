import {
  sanitizeTelemetryModelValue,
  type ArmsCustomEventPayload,
  type IPlatformService,
  type LaunchMarks,
} from "@zcode/shared";
import { logger } from "@/logger.js";

export const UI_PERF_ARMS_GROUP = "ui_perf";

export const UI_PERF_EVENT_LAUNCH_TO_INPUT = "perf_ui_launch_to_input";
export const UI_PERF_EVENT_LAUNCH_ELECTRON_INIT = "perf_ui_launch_electron_init_ms";
export const UI_PERF_EVENT_LAUNCH_APP_READY = "perf_ui_launch_app_ready_ms";
export const UI_PERF_EVENT_LAUNCH_WINDOW = "perf_ui_launch_window_ms";
export const UI_PERF_EVENT_LAUNCH_RENDERER_LOAD = "perf_ui_launch_renderer_load_ms";
export const UI_PERF_EVENT_LAUNCH_REACT_COMMIT = "perf_ui_launch_react_commit_ms";
export const UI_PERF_EVENT_LAUNCH_STARTUP_GATE = "perf_ui_launch_startup_gate_ms";

// Drop the whole batch when total time exceeds this (clock anomaly/suspension) to keep the distribution clean.
export const LAUNCH_TO_INPUT_SANITY_MAX_MS = 300000;

export const UI_PERF_EVENT_FIRST_TOKEN = "perf_ui_first_token";
export const UI_PERF_EVENT_MESSAGE_COMPLETE = "perf_ui_message_complete";
export const UI_PERF_EVENT_TURN_BREAKDOWN = "perf_ui_turn_breakdown";
export const UI_PERF_EVENT_TOOL_CALL_DETAIL = "perf_ui_tool_call_detail";
export const UI_PERF_EVENT_STREAM_STALL = "perf_ui_stream_stall";

// No new chunk within this interval (ms) counts as a stall and is reported; value stays the real gap. Tune from production data.
// Not counted during tool calls (tool_call/tool_call_update): tool events clearStreamStallTracking,
// and the first body chunk after a tool starts a new window instead of comparing across the tool, avoiding false stalls.
export const STREAM_STALL_REPORT_THRESHOLD_MS = 3000;

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

let armsReporter: ArmsReporter | null = null;

export function setUiPerfArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}

export function clearUiPerfArmsReporterForTest(): void {
  armsReporter = null;
  lastChunkAtByTask.clear();
}

/**
 * In these events `model` comes from `detail.model_name`; with custom providers it is a user-named
 * coded value. Normalize once at the single egress so per-report handling never misses new events;
 * normalization only affects the reported value, not the model choice or local logs seen by callers.
 */
function sanitizeModelProperty(
  properties: ArmsCustomEventPayload["properties"],
): ArmsCustomEventPayload["properties"] {
  if (!properties || typeof properties.model !== "string") {
    return properties;
  }
  const model = sanitizeTelemetryModelValue(properties.model);
  return { ...properties, model: model || undefined };
}

// Rationale: ARMS is observability-only; the main UI flow (launch/send/render) must never break over telemetry.
function emit(payload: ArmsCustomEventPayload): void {
  if (!armsReporter) {
    return;
  }
  const sanitized: ArmsCustomEventPayload = {
    ...payload,
    properties: sanitizeModelProperty(payload.properties),
  };
  try {
    void Promise.resolve(armsReporter.reportArmsCustomEvent(sanitized)).catch((error) => {
      logger.warn("[ui-perf] ARMS report failed", { name: payload.name, error });
    });
  } catch (error) {
    logger.warn("[ui-perf] ARMS report threw", { name: payload.name, error });
  }
}

interface LaunchToInputTimings {
  marks: LaunchMarks;
  /** Date.now() at the top of renderer/src/main.tsx (T4) */
  rendererStart: number;
  /** Date.now() when zcode-react-startup-ready fires (T5) */
  reactCommit: number;
  /** Date.now() once the startup gate clears and input is ready (T6) */
  inputReady: number;
  /** Correlation key for a single launch */
  sessionId: string;
}

function clampMs(ms: number): number {
  return Math.max(0, Math.round(ms));
}

function optionalRoundedNumber(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : undefined;
}

export function reportUiLaunchToInput(timings: LaunchToInputTimings): void {
  const { marks, rendererStart, reactCommit, inputReady, sessionId } = timings;
  const total = inputReady - marks.createdAt;
  // Raw durations of the 6 stages (unclamped), all computed up front for whole-batch validation.
  const stageMs = {
    electronInit: marks.mainStart - marks.createdAt,
    appReady: marks.appReady - marks.mainStart,
    window: marks.loadUrl - marks.appReady,
    rendererLoad: rendererStart - marks.loadUrl,
    reactCommit: reactCommit - rendererStart,
    startupGate: inputReady - reactCommit,
  };
  // Sanity guard: anomalous total (clock jump/process suspension) drops the whole batch.
  if (total < 0 || total > LAUNCH_TO_INPUT_SANITY_MAX_MS) {
    logger.warn("[ui-perf] launch_to_input total out of range, dropping", { total });
    return;
  }
  // A negative stage (cross-process clock skew between main T0–T3 and renderer T4–T6) drops the batch,
  // otherwise sum(stages) != total and the dashboard invariant breaks. All-or-nothing, like the total guard.
  const negativeStage = Object.entries(stageMs).find(([, ms]) => ms < 0);
  if (negativeStage) {
    logger.warn("[ui-perf] launch_to_input negative stage (cross-process clock skew), dropped", {
      stage: negativeStage[0],
      ms: negativeStage[1],
    });
    return;
  }
  const properties = { session_id: sessionId };
  // By now every stage is >= 0; clampMs's max(0,...) is a redundant safety net kept for consistent Math.round rounding.
  const stages: { name: string; ms: number }[] = [
    { name: UI_PERF_EVENT_LAUNCH_TO_INPUT, ms: total },
    { name: UI_PERF_EVENT_LAUNCH_ELECTRON_INIT, ms: stageMs.electronInit },
    { name: UI_PERF_EVENT_LAUNCH_APP_READY, ms: stageMs.appReady },
    { name: UI_PERF_EVENT_LAUNCH_WINDOW, ms: stageMs.window },
    { name: UI_PERF_EVENT_LAUNCH_RENDERER_LOAD, ms: stageMs.rendererLoad },
    { name: UI_PERF_EVENT_LAUNCH_REACT_COMMIT, ms: stageMs.reactCommit },
    { name: UI_PERF_EVENT_LAUNCH_STARTUP_GATE, ms: stageMs.startupGate },
  ];
  for (const stage of stages) {
    emit({
      name: stage.name,
      group: UI_PERF_ARMS_GROUP,
      value: clampMs(stage.ms),
      properties,
    });
  }
}

export function reportUiFirstToken(params: {
  ttftMs: number;
  model?: string;
  talkId?: string;
  messageId?: string;
}): void {
  emit({
    name: UI_PERF_EVENT_FIRST_TOKEN,
    group: UI_PERF_ARMS_GROUP,
    value: Math.max(0, Math.round(params.ttftMs)),
    properties: {
      model: params.model,
      talk_id: params.talkId,
      message_id: params.messageId,
    },
  });
}

export function reportUiMessageComplete(params: {
  durationMs: number;
  result: string;
  model?: string;
  talkId?: string;
  messageId?: string;
}): void {
  emit({
    name: UI_PERF_EVENT_MESSAGE_COMPLETE,
    group: UI_PERF_ARMS_GROUP,
    value: Math.max(0, Math.round(params.durationMs)),
    properties: {
      result: params.result,
      model: params.model,
      talk_id: params.talkId,
      message_id: params.messageId,
    },
  });
}

export function reportUiTurnBreakdown(params: {
  durationMs: number;
  result: string;
  model?: string;
  talkId?: string;
  messageId?: string;
  ttftMs?: number;
  waitingMs?: number;
  toolCallTotal?: number;
  toolCallFailed?: number;
  agentStepCount?: number;
  retryCount?: number;
  fileChangeCount?: number;
  generatedCodeLines?: number;
}): void {
  const durationMs = Math.max(0, Math.round(params.durationMs));
  emit({
    name: UI_PERF_EVENT_TURN_BREAKDOWN,
    group: UI_PERF_ARMS_GROUP,
    value: durationMs,
    properties: {
      result: params.result,
      model: params.model,
      talk_id: params.talkId,
      message_id: params.messageId,
      duration_ms: durationMs,
      ttft_ms: optionalRoundedNumber(params.ttftMs),
      waiting_ms: optionalRoundedNumber(params.waitingMs),
      tool_call_total: optionalRoundedNumber(params.toolCallTotal),
      tool_call_failed: optionalRoundedNumber(params.toolCallFailed),
      agent_step_cnt: optionalRoundedNumber(params.agentStepCount),
      retry_cnt: optionalRoundedNumber(params.retryCount),
      file_change_cnt: optionalRoundedNumber(params.fileChangeCount),
      generated_code_lines: optionalRoundedNumber(params.generatedCodeLines),
    },
  });
}

export function reportUiToolCallDetail(params: {
  toolName?: string;
  status: string;
  talkId?: string;
  messageId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  childToolCallId?: string;
  childSessionId?: string;
  agentId?: string;
  agentType?: string;
  totalMs?: number;
  permissionWaitMs?: number;
  commandRunMs?: number;
  firstOutputMs?: number;
  noOutputMs?: number;
  exitCode?: number;
  timedOut?: boolean;
  outputBytes?: number;
  commandCategory?: string;
  commandName?: string;
  commandCount?: number;
  commandStatus?: string;
  fsReadMs?: number;
  fsWriteMs?: number;
  patchMatchMs?: number;
  fileCount?: number;
  totalBytes?: number;
  maxFileBytes?: number;
  hunkCount?: number;
  matchAttempts?: number;
  workspaceKind?: string;
}): void {
  const totalMs = optionalRoundedNumber(params.totalMs);
  const value =
    totalMs ??
    optionalRoundedNumber(params.commandRunMs) ??
    optionalRoundedNumber(params.fsWriteMs) ??
    optionalRoundedNumber(params.fsReadMs) ??
    0;
  emit({
    name: UI_PERF_EVENT_TOOL_CALL_DETAIL,
    group: UI_PERF_ARMS_GROUP,
    value,
    properties: {
      tool_name: params.toolName,
      status: params.status,
      talk_id: params.talkId,
      message_id: params.messageId,
      tool_call_id: params.toolCallId,
      parent_tool_call_id: params.parentToolCallId,
      child_tool_call_id: params.childToolCallId,
      child_session_id: params.childSessionId,
      agent_id: params.agentId,
      agent_type: params.agentType,
      total_ms: totalMs,
      permission_wait_ms: optionalRoundedNumber(params.permissionWaitMs),
      command_run_ms: optionalRoundedNumber(params.commandRunMs),
      first_output_ms: optionalRoundedNumber(params.firstOutputMs),
      no_output_ms: optionalRoundedNumber(params.noOutputMs),
      exit_code:
        typeof params.exitCode === "number" && Number.isFinite(params.exitCode)
          ? Math.round(params.exitCode)
          : undefined,
      timed_out: params.timedOut,
      output_bytes: optionalRoundedNumber(params.outputBytes),
      command_category: params.commandCategory,
      command_name: params.commandName,
      command_count: optionalRoundedNumber(params.commandCount),
      command_status: params.commandStatus,
      fs_read_ms: optionalRoundedNumber(params.fsReadMs),
      fs_write_ms: optionalRoundedNumber(params.fsWriteMs),
      patch_match_ms: optionalRoundedNumber(params.patchMatchMs),
      file_count: optionalRoundedNumber(params.fileCount),
      total_bytes: optionalRoundedNumber(params.totalBytes),
      max_file_bytes: optionalRoundedNumber(params.maxFileBytes),
      hunk_count: optionalRoundedNumber(params.hunkCount),
      match_attempts: optionalRoundedNumber(params.matchAttempts),
      workspace_kind: params.workspaceKind,
    },
  });
}

// Stream stall: per task, remember when the last body chunk arrived; report the real gap past the threshold.
const lastChunkAtByTask = new Map<string, number>();

export function recordStreamChunkArrival(
  taskId: string,
  options?: {
    waitingTool?: boolean;
    /** Workspace-scoped internal key known to the tracker; reporting keeps the real talk_id. */
    talkId?: string;
    messageId?: string;
    model?: string;
    chunkType?: "message" | "thought" | "unknown";
    now?: number;
  },
): void {
  const now = options?.now ?? Date.now();
  const last = lastChunkAtByTask.get(taskId);
  lastChunkAtByTask.set(taskId, now);
  if (last === undefined) {
    return;
  }
  const gapMs = now - last;
  if (gapMs <= STREAM_STALL_REPORT_THRESHOLD_MS) {
    return;
  }
  emit({
    name: UI_PERF_EVENT_STREAM_STALL,
    group: UI_PERF_ARMS_GROUP,
    value: Math.round(gapMs),
    properties: {
      stall_ms: Math.round(gapMs),
      waiting_tool: options?.waitingTool ?? false,
      model: options?.model,
      chunk_type: options?.chunkType,
      talk_id: options?.talkId ?? taskId,
      // messageId of the chunk at stall end; body/thought chunks often lack one, empty when absent (same rule as other fields).
      message_id: options?.messageId,
    },
  });
}

export function clearStreamStallTracking(taskId: string): void {
  lastChunkAtByTask.delete(taskId);
}

// Input lag: inside the Lexical update listener, measure the per-input processing time (getEditorMarkdown + onChange, synchronous).
// Distinct from stream_stall (output side); this is the input side. Report only breaches to keep event volume minimal.
export const UI_PERF_EVENT_INPUT_LAG = "perf_ui_input_lag";

// Conservative starting point: catch only the worst lags. Tighten from production data.
export const INPUT_LAG_REPORT_THRESHOLD_MS = 500;
// Above this it is usually debugger pauses/hidden tabs/wake-from-sleep; drop to keep the distribution clean.
export const INPUT_LAG_SANITY_MAX_MS = 5000;

// The check is a pure function for unit testing: programmatic edits (paste/setText/mention/history restore)
// and IME composition are not typing lag and are skipped even when over threshold.
export function shouldReportInputLag(args: {
  lagMs: number;
  isProgrammatic: boolean;
  isComposing: boolean;
}): boolean {
  if (args.isProgrammatic || args.isComposing) {
    return false;
  }
  return args.lagMs > INPUT_LAG_REPORT_THRESHOLD_MS && args.lagMs <= INPUT_LAG_SANITY_MAX_MS;
}

export function recordInputLag(params: {
  lagMs: number;
  textLength: number;
  isProgrammatic: boolean;
  isComposing: boolean;
  taskId?: string;
}): void {
  if (
    !shouldReportInputLag({
      lagMs: params.lagMs,
      isProgrammatic: params.isProgrammatic,
      isComposing: params.isComposing,
    })
  ) {
    return;
  }
  const lagMs = Math.round(params.lagMs);
  emit({
    name: UI_PERF_EVENT_INPUT_LAG,
    group: UI_PERF_ARMS_GROUP,
    value: lagMs,
    properties: {
      lag_ms: lagMs,
      text_length: params.textLength,
      // No taskId while drafting; leave empty, consistent with other ui_perf events.
      task_id: params.taskId,
    },
  });
}
