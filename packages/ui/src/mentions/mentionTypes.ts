export type MentionCategory =
  | "files"
  | "skills"
  | "commands"
  | "subagents"
  | "whiteboards"
  | "sessions"
  | "plugins";

export interface MentionItemData {
  kind?: "file" | "directory" | "whiteboard";
  path?: string;
  relativePath?: string;
  boardId?: string;
  scope?: "built-in" | "workspace" | "user" | "plugin";
  source?: "built-in" | "user" | "plugin";
  model?: string;
  /** Stable identity of a plugin reference (`name@marketplace`) and canonical link target; the label is not part of identity. */
  pluginId?: string;
  /** Raw icon from the plugin store listing; UI-only, must be loaded over validated HTTPS. */
  icon?: string;
}

export interface MentionItem {
  id: string;
  category: MentionCategory;
  label: string;
  description: string;
  value: string;
  markdown: string;
  keywords?: string[];
  data?: MentionItemData;
  /**
   * Localized display name for panel rendering only (e.g. the plugin listing displayName).
   * `label` is both panel copy and the chip/markdown carrier; localizing it directly would
   * desync the composer chip from message bubbles (rebuilt from the markdown label), so panel display uses this field.
   */
  displayLabel?: string;
  /** Disabled state (V1 same-name plugin conflict fails closed): visible in the panel but not selectable. */
  disabled?: boolean;
  /** Disabled reason, shown in the muted slot on the right of the candidate row. */
  disabledReason?: string;
}

export interface MentionCategoryResult {
  items: MentionItem[];
  loading: boolean;
  error: Error | null;
  emptyText: string;
  title: string;
  refresh?: () => Promise<void>;
}
