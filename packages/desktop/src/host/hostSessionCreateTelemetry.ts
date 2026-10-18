import {
  HostResponseTypes,
  resolveWorkspaceTelemetryDetail,
  type AutomationSessionCreateTelemetry,
} from "@zcode/shared";

/** Called only by dispatch branches that actually create and complete first admission; never inferred from resume subscriptions. */
export function reportHostSessionCreate(
  port: { postMessage(message: unknown): void } | null | undefined,
  input: {
    sessionId: string;
    messageId: string;
    source: AutomationSessionCreateTelemetry["eventExtraDetail"]["create_source"];
    workspaceIdentity?: string;
  },
): void {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions();
    const event: AutomationSessionCreateTelemetry = {
      elementName: "session_create",
      eventRegion: "app",
      eventType: "result",
      talkId: input.sessionId,
      messageId: input.messageId,
      context: {
        clientTimezone: locale.timeZone,
        clientLanguage: locale.locale,
        screenResolution: "",
      },
      eventExtraDetail: {
        create_source: input.source,
        client_kind: "desktop",
        ...resolveWorkspaceTelemetryDetail(input),
      },
    };
    port?.postMessage({ type: HostResponseTypes.SessionCreateTelemetry, event });
  } catch {
    // If main exited or IPC is unusable, drop this side-channel report; never misjudge an accepted dispatch as failed.
  }
}
