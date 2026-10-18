import type { ArmsCustomEventPayload, IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";

// ARMS egress for the composer send funnel.
// These events go only to ARMS, never /event/report; Root.tsx installs the reporter when isDesktop.
// Web / phone-remote never get a reporter, so the whole group stays silent there.

const SEND_FUNNEL_ARMS_GROUP = "send_funnel";

const SEND_FUNNEL_EVENT_INPUT_FOCUS = "send_input_focus";
const SEND_FUNNEL_EVENT_SEND_CLICK = "send_click";
const SEND_FUNNEL_EVENT_SEND_RESULT = "send_result";

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

/** Reason code for a settled send. */
export type SendFunnelReasonCode =
  | "attachment_not_ready"
  | "blocked"
  | "rejected"
  | "stale"
  | "failed"
  | "render_timeout"
  | "transport_error"
  | "provider_not_ready"
  | "composer_error";

let armsReporter: ArmsReporter | null = null;

export function setSendFunnelArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}

// ARMS is observability-only: the send path must never break over telemetry.
function emit(payload: ArmsCustomEventPayload): void {
  if (!armsReporter) {
    return;
  }
  try {
    void Promise.resolve(armsReporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[send-funnel] ARMS report failed", { name: payload.name, error });
    });
  } catch (error) {
    logger.warn("[send-funnel] ARMS report threw", { name: payload.name, error });
  }
}

/** Session vs draft scope: separates "send in an existing session" from "first send of a new task". */
function composerScopeOf(sessionId: string | null | undefined): "session" | "draft" {
  return sessionId ? "session" : "draft";
}

/** Omit the property when sessionId / commandId is empty; avoids empty-string ARMS dimensions. */
function optionalId(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

/** Input focused (real user focus only; programmatic focus is intercepted composer-side). */
export function reportSendFunnelInputFocus(params: {
  sessionId: string | null;
  focusTime: number;
}): void {
  emit({
    name: SEND_FUNNEL_EVENT_INPUT_FOCUS,
    group: SEND_FUNNEL_ARMS_GROUP,
    value: 1,
    properties: {
      focus_time: params.focusTime,
      composer_scope: composerScopeOf(params.sessionId),
      talk_id: optionalId(params.sessionId),
    },
  });
}

/** Send clicked / Enter submitted and passed the send gate. */
export function reportSendFunnelSendClick(params: {
  sessionId: string | null;
  sendClickId: string;
  sendTime: number;
  trigger: "button" | "shortcut";
  extraDetail: Record<string, string>;
}): void {
  emit({
    name: SEND_FUNNEL_EVENT_SEND_CLICK,
    group: SEND_FUNNEL_ARMS_GROUP,
    value: 1,
    properties: {
      ...params.extraDetail,
      send_click_id: params.sendClickId,
      input_send_time: params.sendTime,
      send_trigger: params.trigger,
      composer_scope: composerScopeOf(params.sessionId),
      talk_id: optionalId(params.sessionId),
    },
  });
}

/**
 * Send settled (success and failure share this). value is send_cost_ms, so ARMS can compute
 * avg/p50/p95/p99 on this event and slice by status / reason_code directly.
 *
 * costMs is the **end-to-end** duration: click send -> user message visible in history.
 * ackCostMs isolates click -> ACK; the difference is reflow + render time.
 */
export function reportSendFunnelSendResult(params: {
  sessionId: string | null;
  commandId?: string;
  sendClickId: string;
  status: "success" | "fail";
  ackStatus?: string;
  reasonCode?: SendFunnelReasonCode;
  costMs: number;
  ackCostMs?: number;
  queueConfirmed: boolean;
  extraDetail: Record<string, string>;
}): void {
  const costMs = Math.max(0, Math.round(params.costMs));
  const ackCostMs =
    params.ackCostMs === undefined ? undefined : Math.max(0, Math.round(params.ackCostMs));
  emit({
    name: SEND_FUNNEL_EVENT_SEND_RESULT,
    group: SEND_FUNNEL_ARMS_GROUP,
    value: costMs,
    properties: {
      ...params.extraDetail,
      send_click_id: params.sendClickId,
      status: params.status,
      reason_code: params.reasonCode,
      ack_status: params.ackStatus,
      send_cost_ms: costMs,
      ack_cost_ms: ackCostMs,
      send_queue_confirmed: params.queueConfirmed,
      talk_id: optionalId(params.sessionId),
      message_id: optionalId(params.commandId),
    },
  });
}
