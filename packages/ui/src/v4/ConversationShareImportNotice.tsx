import { memo } from "react";
import { SquareArrowRightEnter } from "lucide-react";

import type { Locale } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { Theme } from "@/useTheme.js";
import { ConversationShareReadonlyTimeline } from "@/v4/ConversationShareReadonlyTimeline.js";
// Injection boundary: the read-only timeline is shared with the anonymous public share page and must not depend statically on the open-with subtree;
// OpenSplitButton (platform hooks, tab store, file-tree model, other Desktop capabilities) may only be imported by this Desktop
// consumer and injected via artifactOpenAction, so the public-page entry carries none of that subtree.
import { OpenSplitButton } from "@/OpenSplitButton.js";

const EMPTY_ARTIFACT_NAMES: ReadonlyMap<string, string> = new Map();
const EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS: ReadonlyMap<string, string> = new Map();

/**
 * Read-only block + divider at the top of the conversation after importing a share.
 * Uses the import icon, avoiding confusion with the Fork marker.
 *
 * The read-only block reuses the share-page renderer, so public rows are never mapped back into Message
 * (lossy and undefined; Fork is simple because it clones real Messages).
 *
 * Local result artifacts bypass the share-page artifactUrls/window.open; only when the importer explicitly passes
 * workspaceRelativePath and a Desktop open callback do they reuse the normal preview-card open controls.
 */
export const ConversationShareImportNotice = memo(function ConversationShareImportNotice({
  rows,
  locale,
  theme,
  codePreviewSettings,
  artifactNames = EMPTY_ARTIFACT_NAMES,
  artifactWorkspaceRelativePaths = EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  unsupportedRowCount = 0,
  onOpenShareUrl,
  onOpenFileLink,
  onOpenCodeViewer,
}: {
  rows: readonly ConversationRow[];
  locale: Locale;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  artifactNames?: ReadonlyMap<string, string>;
  artifactWorkspaceRelativePaths?: ReadonlyMap<string, string>;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  unsupportedRowCount?: number;
  onOpenShareUrl?: () => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "conversationShare.import.dividerLabel" });
  return (
    <div data-conversation-share-import-notice="true" className="flex w-full flex-col">
      <ConversationShareReadonlyTimeline
        rows={rows}
        locale={locale}
        {...(theme ? { theme } : {})}
        {...(codePreviewSettings ? { codePreviewSettings } : {})}
        artifactNames={artifactNames}
        artifactWorkspaceRelativePaths={artifactWorkspaceRelativePaths}
        {...(workspacePath ? { workspacePath } : {})}
        {...(workspaceIdentity ? { workspaceIdentity } : {})}
        {...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {})}
        unsupportedRowCount={unsupportedRowCount}
        artifactOpenAction={OpenSplitButton}
        onOpenFileLink={onOpenFileLink}
        onOpenCodeViewer={onOpenCodeViewer}
      />
      {onOpenShareUrl ? (
        <button
          type="button"
          data-conversation-share-import-divider="true"
          className="group/share-import flex w-full items-center gap-3 px-4 py-2 text-ui-base text-foreground-subtle hover:text-foreground"
          onClick={onOpenShareUrl}
        >
          <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
          <SquareArrowRightEnter aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words text-center leading-5 underline-offset-4 group-hover/share-import:underline">
            {label}
          </span>
          <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
        </button>
      ) : (
        <div
          data-conversation-share-import-divider="true"
          className="flex w-full items-center gap-3 px-4 py-2 text-ui-base text-foreground-subtle"
        >
          <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
          <SquareArrowRightEnter aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words text-center leading-5">{label}</span>
          <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
        </div>
      )}
    </div>
  );
});
