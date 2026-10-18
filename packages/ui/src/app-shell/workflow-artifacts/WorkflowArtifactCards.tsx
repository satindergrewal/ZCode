/**
 * The three body types that cannot render inline (html card, off-table type metadata card, the one-line loading / error state).
 *
 * Terminology: artifact = the output the script publishes to the user via `artifact.*`, not a synonym for the engine-internal "script top-level return value".
 *
 * Split from `WorkflowArtifactBody.tsx` because of the line cap (400): that file's body is
 * **dispatch by contentType**, and these three are where dispatch **gives up** - separate concerns
 * that deserve separate readers anyway.
 */

import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatArtifactBytes } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { toFileUrl } from "@/lib/path.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";

/**
 * Card shell shared by the two non-inline bodies (html and off-table types): title / type / size
 * / provenance plus at most one action. Drawn twice, sooner or later one states the size and the
 * other does not.
 */
export function ArtifactMetadataCard({
  artifact,
  bytes,
  note,
  action,
  testId,
}: {
  artifact: WorkflowRunArtifactView;
  bytes: number;
  /** The explanation line under the card (why not inline / what exactly opens). */
  note?: string;
  action?: { label: string; onActivate: () => void; testId?: string };
  testId: string;
}) {
  return (
    <div className="flex h-full min-h-0 items-start justify-center overflow-auto p-6">
      <div
        className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-card-border bg-card p-4"
        data-testid={testId}
      >
        <div className="min-w-0">
          <div className="truncate text-ui-base font-medium text-foreground">
            {artifact.title ?? artifact.id}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-ui-sm text-foreground-subtle">
            {artifact.contentType === undefined ? null : <span>{artifact.contentType}</span>}
            <span>{formatArtifactBytes(bytes)}</span>
          </div>
          {artifact.sourcePath === undefined ? null : (
            <div
              className="mt-0.5 truncate font-mono text-ui-xs text-foreground-subtlest"
              title={artifact.sourcePath}
            >
              {artifact.sourcePath}
            </div>
          )}
        </div>
        {note === undefined ? null : (
          <p className="text-ui-sm text-foreground-subtle" data-testid="workflow-artifact-note">
            {note}
          </p>
        )}
        {action === undefined ? null : (
          <Button
            className="self-start"
            {...(action.testId === undefined ? {} : { "data-testid": action.testId })}
            onClick={action.onActivate}
            size="sm"
            type="button"
            variant="outline"
          >
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The html artifact card (**no inline iframe**, see this file's header).
 *
 * ## Why "open in browser" uses the **workspace original path**, not the store's pinned bytes
 *
 * The store handle is `zcode-artifact://...`, not a filesystem path, so a browser tab cannot open
 * it; the protocol side also deliberately keeps the store's disk path away from the renderer. The
 * only thing that can become a `file://` URL is `sourcePath` (the workspace-relative original). The
 * cost, stated plainly: that is the **workspace's current file**, not this version's pinned bytes -
 * so the card says so in one line (the spec's "state on the card that the workspace copy opens"),
 * and the button appears on the **latest version only**: older originals were long since
 * overwritten by the same name, and passing one off as a historical version would be a quiet lie.
 */
export function WorkflowArtifactHtmlCard({
  artifact,
  bytes,
  localSourcePath,
  isLatestVersion,
  onOpenBrowserUrl,
  onReveal,
}: {
  artifact: WorkflowRunArtifactView;
  bytes: number;
  localSourcePath?: string;
  isLatestVersion: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onReveal?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const openable =
    isLatestVersion && localSourcePath !== undefined && onOpenBrowserUrl !== undefined;
  return (
    <ArtifactMetadataCard
      artifact={artifact}
      bytes={bytes}
      note={intl.formatMessage({
        id: openable
          ? "chat.toolCall.workflow.run.artifacts.openInBrowserNote"
          : "chat.toolCall.workflow.run.artifacts.localOnly",
      })}
      testId="workflow-artifact-html-card"
      {...(openable
        ? {
            action: {
              label: intl.formatMessage({
                id: "chat.toolCall.workflow.run.artifacts.openInBrowser",
              }),
              onActivate: () => onOpenBrowserUrl(toFileUrl(localSourcePath)),
              testId: "workflow-artifact-open-in-browser",
            },
          }
        : onReveal === undefined
          ? {}
          : {
              action: {
                label: intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" }),
                onActivate: onReveal,
                testId: "workflow-artifact-html-reveal",
              },
            })}
    />
  );
}

/** One line in the body slot (loading / error / not previewable). Same shape in all three states; only the color tier differs. */
export function ArtifactNotice({
  text,
  detail,
  tone,
  testId,
}: {
  text: string;
  detail?: string;
  tone?: "error";
  testId?: string;
}) {
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-1 p-6 text-center"
      {...(testId === undefined ? {} : { "data-testid": testId })}
    >
      <p
        className={cn(
          "text-ui-base",
          tone === "error" ? "text-destructive" : "text-foreground-subtle",
        )}
      >
        {text}
      </p>
      {detail === undefined ? null : (
        <p
          className="max-w-full truncate font-mono text-ui-xs text-foreground-subtlest"
          title={detail}
        >
          {detail}
        </p>
      )}
    </div>
  );
}
