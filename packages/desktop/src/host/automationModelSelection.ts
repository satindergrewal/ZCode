import type { ModelSelection } from "@zcode/shared";
import type { IModelSelectionService } from "@zcode/services";

/** Pins the model identity at the Automation Select-to-Submission boundary. */
export async function resolveAutomationSubmissionModelSelection(params: {
  selection?: ModelSelection;
  fixedSelection?: ModelSelection;
  readSelection?: () => Promise<ModelSelection | undefined>;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
}): Promise<ModelSelection> {
  // A pinned run is an execution fact; retries must not re-map the account or be changed by a current read failure.
  if (params.fixedSelection) return params.fixedSelection;
  // The scheduler snapshot may predate the Host's one-way import; the first execution uses the persisted, validated intent.
  const selection = params.readSelection ? await params.readSelection() : params.selection;
  if (selection) {
    const view = await params.modelSelectionService.getView({ selection });
    if (view.selectionIssue || !view.effectiveSelection?.options?.reasoningLevel) {
      throw new Error(
        "Automation model selection unavailable; re-select the model and thinking level",
      );
    }
    return view.effectiveSelection;
  }

  const preferredSelection = (await params.modelSelectionService.getView()).preferredSelection;
  if (!preferredSelection?.options?.reasoningLevel) {
    throw new Error("Automation cannot resolve the preferred model from the target Host");
  }
  return preferredSelection;
}
