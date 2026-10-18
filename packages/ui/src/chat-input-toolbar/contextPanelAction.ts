export function runContextPanelActionWithClose({
  action,
  close,
}: {
  action?: () => void;
  close: () => void;
}) {
  // Clicking a button inside the HoverCard does not close the panel like an outside hover-leave.
  // Entries navigate to settings/usage details, so collapse the context panel first or the old
  // overlay lingers.
  close();
  action?.();
}
