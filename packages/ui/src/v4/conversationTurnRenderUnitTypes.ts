import type { PluginUiRowPinResolver } from "@/plugin-ui/index.js";
import type { BotTopicPreparation } from "@zcode/shared";
import type {
  AssistantTextRow,
  ConversationRow,
  HookInvocationRow,
  SessionPhase,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
  WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";
import type { HighspeedOutputFooterMark } from "@/highspeed/highspeedOutputFooter.js";

export interface ConversationTurnRenderUnit extends HighspeedOutputFooterMark {
  /** Display projection of not-yet-accepted bot messages; never enters CLI rows or nav/share indexes. */
  topicPreparations?: readonly BotTopicPreparation[];
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  visibleUserInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  /**
   * Every visual work segment's history rows, for copy/preview/legacy-callers only.
   * Real collapse bounds read workSegments; each segment keeps CLI row total order.
   */
  assistantHistoryRows: AssistantWorkRow[];
  /** Rows after the action-body anchor, before the true turn-end marker; rendered in CLI order. */
  assistantFollowingRows: AssistantWorkRow[];
  assistantTailRows: AssistantWorkRow[];
  /** Browser auto turn-end screenshot: renders after the file-diff summary, before message actions, when complete. */
  browserTurnEndRows: AssistantWorkRow[];
  /** turn-local hook product rows; outside assistant work/collapse, feeding only the turn-end detail action. */
  hookInvocations: HookInvocationRow[];
  /** S2: every assistant text segment of the turn, for copy/preview aggregates -- not a render position. */
  assistantTextRows: AssistantTextRow[];
  /** Light boundary (modelChange, S13): a turn-top divider rendered before the user input. */
  leadingBoundaryRows: TimelineMarkerRow[];
  /** The completed turn's final body; fork/retry/action/preview attach here only. */
  latestAssistantTextRow?: AssistantTextRow;
  /** Visible user/assistant interleaving inside one product turn; adjacent work rows stay grouped. */
  flowItems: ConversationTurnFlowItem[];
  /** One visual work segment per original input and per accepted guide. */
  workSegments?: ConversationTurnWorkSegment[];
  renderRows: ConversationRow[];
  isLastTurn: boolean;
  isRunning: boolean;
  assistantHistoryDefaultOpen: boolean;
  timelineOnly: boolean;
  /** Turn-level aggregate work status, legacy-callers only; new components read workSegments[].workStatus. */
  workStatus?: ConversationTurnWorkStatus;
  startedAt?: number;
  /** Launch metadata for hub-started turns (rules in `workflowLaunchTurn.ts`); present, the turn renders as a run card with no user bubble. */
  workflowLaunch?: WorkflowLaunchMeta;
}

export interface BuildConversationTurnRenderUnitsOptions {
  nowMs?: number;
  sessionPhase?: SessionPhase;
  /** Plugin-card collapse verdict (timeline assembled from derivation + manual state). */
  pluginUiPinResolver?: PluginUiRowPinResolver;
}
