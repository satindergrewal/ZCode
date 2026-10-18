import { HISTORY_NAVIGATION_UPDATE_TAG } from "./editorUpdateTags.js";

/**
 * Whether the SlashCommandPlugin update listener should process this editor update.
 *
 * Returns false during history-navigation restore so the panel does not register arrow-key handlers
 * at COMMAND_PRIORITY_CRITICAL and swallow later history keys. Every other update returns true.
 */
export function shouldSlashPanelProcessUpdate(tags: ReadonlySet<string>): boolean {
  return !tags.has(HISTORY_NAVIGATION_UPDATE_TAG);
}
