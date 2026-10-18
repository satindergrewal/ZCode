/** Post-vertical-slice, ChatView is deleted; minimal types still referenced by shell / command-center. */
export interface ChatSearchResultHighlightRequest {
  requestId: number;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  query: string;
  snippet?: string;
  snippetIndex?: number;
}

export interface ConversationFindMatchState {
  matchCount: number;
  activeIndex?: number;
}

export type ChatViewSummaryPanelVariant = "panel" | "mini";
