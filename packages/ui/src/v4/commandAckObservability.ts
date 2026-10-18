/**
 * v4 command-ack observability: production builds mute renderer logs (see ui/logger.ts);
 * e2e/field debugging needs a probeable sink. Every command ack summary lands in a window-level
 * bounded ring buffer (the __zcodeSessionStoreE2E debug surface), never heavy payloads like message bodies.
 */
export interface V4CommandAckSummary {
  type: string;
  status: string;
  reasonCode?: string;
  revisionAtDecision?: number;
  at: number;
}

const MAX_ACK_ENTRIES = 50;

type V4AckDebugWindow = Window & {
  __zcodeV4CommandAcksE2E?: V4CommandAckSummary[];
};

export function recordV4CommandAck(summary: V4CommandAckSummary): void {
  if (typeof window === "undefined") return;
  const host = window as V4AckDebugWindow;
  const buffer = (host.__zcodeV4CommandAcksE2E ??= []);
  buffer.push(summary);
  if (buffer.length > MAX_ACK_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ACK_ENTRIES);
  }
}
