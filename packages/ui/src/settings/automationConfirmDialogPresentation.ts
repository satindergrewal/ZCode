/** Automation pins only the shared ConfirmDialog's outer size; inner styling stays with the shared component. */
export const AUTOMATION_CONFIRM_DIALOG_CONTENT_CLASS =
  "min-h-[180px] w-[min(448px,calc(100vw-2rem))] max-w-none";

// Merge reason: remote added long-copy protection, without overriding the locally settled inner visuals.
export const AUTOMATION_CONFIRM_DIALOG_DESCRIPTION_CLASS =
  "line-clamp-3 break-words whitespace-pre-line";
