// ============================================================
// The workflow dialog's adjust-settings, PermissionDialog side:
// ============================================================
// docs/dynamic-workflow/launch.md "Adjusting the settings in the window" / "The options"; visuals and keys in
// docs/dynamic-workflow/presentation.md "The confirmation window".
//
// Split from PermissionDialog.tsx: that file owns the shared option list; this adds the three
// workflow-only pieces: where edited settings live, which options carry them, and the Shift+Tab return.

import { useCallback, useState } from "react";
import type { ZCodePermissionOption } from "@zcode/shared";
import type { WorkflowAskSettingsContent } from "@/components/workflow-timeline/workflowAskSettings.js";
import { getPermissionOptionDisplayKind } from "@/lib/permissionRequest.js";

/** Settings block anchor: Shift+Tab from the first option lands here. */
export const WORKFLOW_PERMISSION_SETTINGS_SELECTOR = '[data-testid="workflow-permission-settings"]';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Edited settings and model-unavailable, both tagged with their requestId; a mismatch reads as none:
 * no reset-by-effect. Remounted children report the new request first and a later parent
 * reset effect would wipe the fresh unavailable flag.
 */
export function usePermissionWorkflowSettings(requestId: string) {
  const [content, setContent] = useState<{
    requestId: string;
    value: WorkflowAskSettingsContent | undefined;
  } | null>(null);
  const [blocked, setBlocked] = useState<{ requestId: string; value: boolean } | null>(null);
  const onContentChange = useCallback(
    (value: WorkflowAskSettingsContent | undefined) => setContent({ requestId, value }),
    [requestId],
  );
  const onBlockedChange = useCallback(
    (value: boolean) => setBlocked({ requestId, value }),
    [requestId],
  );
  return {
    content: content?.requestId === requestId ? content.value : undefined,
    blocked: blocked?.requestId === requestId && blocked.value,
    onBlockedChange,
    onContentChange,
  };
}

/** Settings ride allow replies only: deny starts nothing; Refine re-asks with the edited call. */
export function isWorkflowSettingsCarrier(option: ZCodePermissionOption): boolean {
  const kind = getPermissionOptionDisplayKind(option.kind);
  return kind === "allowOnce" || kind === "allowAlways";
}

/** With edits, the first two options say what the reply carries; other descriptions unchanged. */
export function workflowAdjustedOptionDescriptionId(messageId: string | null): string | null {
  switch (messageId) {
    case "chat.permission.allowOnce.description":
      return "chat.permission.workflow.allowOnce.adjusted";
    case "chat.permission.workflow.allowForSession.description":
      return "chat.permission.workflow.allowForSession.adjusted";
    default:
      return messageId;
  }
}

/**
 * Shift+Tab on the first option exits to the settings block's last control (the next stop
 * backwards), matching reading order. No block/focusable returns false to the list's own loop.
 */
export function focusLastWorkflowSettingsControl(root: HTMLElement | null): boolean {
  const block = root?.querySelector<HTMLElement>(WORKFLOW_PERMISSION_SETTINGS_SELECTOR);
  const controls = block?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  const last = controls === undefined ? undefined : controls[controls.length - 1];
  if (last === undefined) return false;
  last.focus();
  return true;
}
