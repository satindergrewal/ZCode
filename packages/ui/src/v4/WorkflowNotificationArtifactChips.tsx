import { TID_CHAT_WORKFLOW_ARTIFACT_CHIP } from "@zcode/shared";
import type { WorkflowNotificationMeta } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";

/**
 * Collapsed-header artifact chips on terminal notification rows: small artifact pills, up to 3 + `+N`.
 *
 * Terminology: an artifact on the chip is output published to the user via `artifact.*`, not the same as the
 * `result` (top-level script return) carried by the same notification.
 *
 * Payload absent (batch turns / old transcripts / old CLIs) => the whole block absent; the row stays pixel-identical to today.
 * Callback absent (cold-recovery no join, read-only session) => pills disabled, not removed: what the run delivered is fact,
 * opening it is capability. The event stops at the chip layer - the whole header is the collapse toggle; pills are not part of it.
 */
export function WorkflowNotificationArtifactChips({
  artifacts,
  truncated,
  onOpenArtifact,
}: {
  artifacts: NonNullable<Extract<WorkflowNotificationMeta, { kind: "terminal" }>["artifacts"]>;
  /** Sender-side truncation (> 8 or filtered) - `+N` may underreport, hence an ellipsis instead of a number. */
  truncated?: boolean;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  return (
    <WorkflowArtifactStrip
      artifacts={artifacts}
      moreTestId="workflow-notification-artifacts-more"
      pillTestId={TID_CHAT_WORKFLOW_ARTIFACT_CHIP}
      size="sm"
      variant="link"
      testId="workflow-notification-artifacts"
      {...(truncated === undefined ? {} : { truncated })}
      {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
    />
  );
}
