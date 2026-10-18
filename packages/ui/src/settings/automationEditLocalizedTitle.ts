/**
 * Syncs only the create page's auto-filled default title.
 *
 * The default title once read locale only at form init; after a language switch every other string updated but the input kept the old one.
 * User input, template drafts and saved titles are data; a UI language switch must never overwrite them.
 */
export function resolveLocalizedAutomationCreateTitle({
  currentTitle,
  hasInitialDraft,
  isEditing,
  nextDefaultTitle,
  previousDefaultTitle,
  titleTouched,
}: {
  currentTitle: string;
  hasInitialDraft: boolean;
  isEditing: boolean;
  nextDefaultTitle: string;
  previousDefaultTitle: string;
  titleTouched: boolean;
}): string {
  if (isEditing || hasInitialDraft || titleTouched || currentTitle !== previousDefaultTitle) {
    return currentTitle;
  }
  return nextDefaultTitle;
}
