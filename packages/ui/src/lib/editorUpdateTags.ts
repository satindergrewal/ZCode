/** Generic tag for programmatic updates (setText, setEditorStateJson, etc.). */
export const PROGRAMMATIC_UPDATE_TAG = "zcode-programmatic";

/**
 * Tag reserved for history-navigation backfill.
 * PromptHistoryPlugin used to backfill entries with the generic PROGRAMMATIC_UPDATE_TAG,
 * so SlashCommandPlugin's update listener could not tell "user is typing a slash query"
 * from "history navigation wrote a legacy entry containing / back into the editor". The
 * panel then reopened and registered arrow-key handlers at COMMAND_PRIORITY_CRITICAL,
 * swallowing later ArrowUp/ArrowDown presses and freezing the history index. With a
 * dedicated tag, SlashCommandPlugin skips exactly the history-backfill updates while
 * leaving the panel's behavior for hand-typed / untouched.
 */
export const HISTORY_NAVIGATION_UPDATE_TAG = "zcode-history-navigation";
