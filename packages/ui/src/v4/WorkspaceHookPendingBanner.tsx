import { memo, useCallback, useState } from "react";
import {
  TID_V4_WORKSPACE_HOOK_PENDING_BANNER,
  TID_V4_WORKSPACE_HOOK_PENDING_DISMISS,
  TID_V4_WORKSPACE_HOOK_PENDING_REVIEW,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { logger } from "@/logger.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import {
  findWorkspaceHookCommandBinding,
  useWorkspaceHookReviewStore,
  type WorkspaceHookCommandBinding,
} from "@/store/workspaceHookReviewStore.js";
import { sendWorkspaceHookCommand } from "@/settings/workspaceHookReviewCommands.js";

/**
 * Soft-gate dismiss store: a lightweight module-level Map.
 * Idempotency key = sessionId + bundleDigest; the banner returns when the bundle changes.
 * Never persisted - refresh/reload reminds again, matching the users-should-know product semantics.
 */
class WorkspaceHookPendingDismissStore {
  private dismissed = new Set<string>();

  /** Marks a session+bundle combination dismissed */
  dismiss(sessionId: string, bundleDigest: string): void {
    this.dismissed.add(this.key(sessionId, bundleDigest));
  }

  /** Queries the dismissed state */
  isDismissed(sessionId: string, bundleDigest: string): boolean {
    return this.dismissed.has(this.key(sessionId, bundleDigest));
  }

  /** Clears every dismiss record (for tests) */
  clear(): void {
    this.dismissed.clear();
  }

  private key(sessionId: string, bundleDigest: string): string {
    return `${sessionId}:${bundleDigest}`;
  }
}

const workspaceHookPendingDismissStore = new WorkspaceHookPendingDismissStore();

interface WorkspaceHookAdmissionInfo {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

interface WorkspaceHookPendingBannerProps {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  admission: WorkspaceHookAdmissionInfo | null;
}

/**
 * The persistent soft-gate banner.
 *
 * Shows when snapshot.workspaceHookAdmission.pendingCount > 0, with Review and Ignore actions.
 * - Review: opens the settings Hooks section + sends requestWorkspaceHookReview.
 *   A failed send never blocks navigation (fault tolerant; logged via logger.warn).
 * - Ignore: renderer-local dismiss, idempotency key = sessionId + bundleDigest.
 */
export const WorkspaceHookPendingBanner = memo(function WorkspaceHookPendingBanner({
  sessionId,
  workspacePath,
  workspaceIdentity,
  admission,
}: WorkspaceHookPendingBannerProps) {
  const { intl } = useZCodeIntl();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const commandBindings = useWorkspaceHookReviewStore((state) => state.commandBindings);
  const [, setDismissRevision] = useState(0);

  const handleReview = useCallback(() => {
    // Two-step settings open: set intent, then open the tab (mirrors the V4ComposerToolbar handleOpenModelProviderSettings).
    setPendingSettingsSectionIntent("hooks");
    openSettingsTab?.();

    // Sends requestWorkspaceHookReview via the command binding.
    // The channel exists precisely to keep the command available without a pending review interaction.
    const binding = findWorkspaceHookCommandBinding(
      commandBindings,
      workspacePath,
      workspaceIdentity,
    );
    if (binding && admission) {
      const payload = {
        sessionId,
        workspaceIdentity: admission.workspaceIdentity ?? workspaceIdentity ?? workspacePath,
        bundleDigest: admission.bundleDigest,
      };
      void sendWorkspaceHookCommand(
        binding as Pick<WorkspaceHookCommandBinding, "sendCommand" | "onCommandSettled">,
        sessionId,
        "requestWorkspaceHookReview",
        payload,
      ).catch((error) => {
        // A failed send never blocks navigation (fault tolerant) - the user is already in settings and can act manually.
        logger.warn("[workspace-hook-pending] requestWorkspaceHookReview failed", {
          sessionId,
          bundleDigest: admission.bundleDigest,
          error,
        });
      });
    }
  }, [admission, commandBindings, openSettingsTab, sessionId, workspaceIdentity, workspacePath]);

  const handleDismiss = useCallback(() => {
    if (admission) {
      runUserAction({
        input: { featureId: "conversation.blocking.hook", action: "dismiss", trigger: "button" },
        operation: () => {
          workspaceHookPendingDismissStore.dismiss(sessionId, admission.bundleDigest);
          // Bug cause: module-level Set writes are not React state, so the memoized component never re-rendered.
          setDismissRevision((revision) => revision + 1);
        },
        completed: { resultSource: "local_commit" },
        failureStage: "hook_dismiss",
      });
    }
  }, [admission, sessionId]);

  if (!admission || admission.pendingCount <= 0) {
    return null;
  }

  // Idempotent dismiss check: hidden once this bundle is dismissed.
  if (workspaceHookPendingDismissStore.isDismissed(sessionId, admission.bundleDigest)) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid={TID_V4_WORKSPACE_HOOK_PENDING_BANNER}
      className="mb-3 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-ui-base text-foreground backdrop-blur-md"
    >
      <p className="min-w-0 flex-1">
        {intl.formatMessage(
          { id: "chat.workspaceHookPending.message" },
          { count: admission.pendingCount },
        )}
      </p>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_HOOK_PENDING_REVIEW}
        className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/80"
        onClick={handleReview}
      >
        {intl.formatMessage({ id: "chat.workspaceHookPending.review" })}
      </button>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_HOOK_PENDING_DISMISS}
        className="shrink-0 rounded-md px-2 py-1 text-foreground-subtle hover:bg-hover"
        onClick={handleDismiss}
      >
        {intl.formatMessage({ id: "chat.workspaceHookPending.dismiss" })}
      </button>
    </div>
  );
});
