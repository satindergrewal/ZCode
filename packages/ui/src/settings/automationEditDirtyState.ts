export type AutomationEditDirtyField =
  | "title"
  | "prompt"
  | "schedule"
  | "mode"
  | "thoughtLevel"
  | "model";

export type AutomationEditFieldSignatures = Record<AutomationEditDirtyField, string>;

/** Compare only user-touched fields; post-init system normalization must not read as a modification. */
export function resolveChangedAutomationEditFields(params: {
  touchedFields: ReadonlySet<AutomationEditDirtyField>;
  current: AutomationEditFieldSignatures;
  baseline: Partial<AutomationEditFieldSignatures>;
}): AutomationEditDirtyField[] {
  return [...params.touchedFields].filter(
    (field) =>
      params.baseline[field] !== undefined && params.current[field] !== params.baseline[field],
  );
}
