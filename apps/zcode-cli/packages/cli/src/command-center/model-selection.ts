import type { CommandCenterApp, CommandCenterDeps } from "./types.js";

/** The session switch already succeeded; a preference-write failure only appends a notice, never reports the switch as failed. */
export async function rememberCurrentModelSelection(
  app: CommandCenterApp,
  deps: CommandCenterDeps,
): Promise<string> {
  if (!deps.saveDefaultModelSelection) return "";
  try {
    const ref = app.getCurrentModelOption?.()?.ref;
    const reasoningLevel = app.getThoughtLevel?.();
    if (!ref || !reasoningLevel) throw new Error("Current model selection is incomplete.");
    await deps.saveDefaultModelSelection({
      providerId: ref.providerId,
      modelId: ref.modelId,
      options: { reasoningLevel },
    });
    return "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `\nWarning: The current selection is active, but could not be saved as the default for new sessions: ${message}`;
  }
}
