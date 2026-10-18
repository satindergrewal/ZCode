import { TID_WORKFLOW_ARTIFACT_CHIP, type ZCodeSavedWorkflowRun } from "@zcode/shared";
import type { ArtifactPillSize } from "@/components/workflow-timeline/WorkflowArtifactPill.js";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";

/**
 * Artifact strip for the hub: small pills after the status word on run-history rows, regular size
 * in the detail header's recent-artifacts line.
 *
 * Terminology: artifact = the output the script published to the user via artifact.*.
 *
 * The **same** component as the notification-row and under-timeline artifact strips - one artifact
 * must look identical in all four places. The payload shape (legacy workflows/runs rows) differs
 * from v4 notification meta, but both carry the four fields (id / kind / title / version) and the
 * strip reads only those.
 */
export function SavedWorkflowArtifactChips({
  artifacts,
  onOpenArtifact,
  className,
  size = "sm",
}: {
  artifacts: NonNullable<ZCodeSavedWorkflowRun["artifacts"]>;
  /** Absent = pills disabled (legacy rows lack parentSessionId, or the host injected no open capability). */
  onOpenArtifact?: (artifactId: string) => void;
  size?: ArtifactPillSize;
  className?: string;
}) {
  return (
    <WorkflowArtifactStrip
      artifacts={artifacts}
      moreTestId="workflow-run-artifact-chips-more"
      pillTestId={TID_WORKFLOW_ARTIFACT_CHIP}
      size={size}
      testId="workflow-run-artifact-chips"
      {...(className === undefined ? {} : { className })}
      {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
    />
  );
}
