export type FeedbackTicketType = "bug" | "usage" | "feature" | "performance";

export type FeedbackTicketStatus =
  | "已提交"
  | "信息不足"
  | "已采纳"
  | "答复关闭"
  | "已归档"
  | "已拒绝"
  | "开发中"
  | "已解决"
  | "已上线";

export type FeedbackAttachmentKind = "log" | "image" | "other";

export type FeedbackTicketModule =
  | "Plugin / MCP"
  | "Agent任务执行失败"
  | "模型配置 / API Key"
  | "模型调用报错"
  | "权限 / 配置保存"
  | "SSH连接失败"
  | "WSL连接失败"
  | "UI布局 / 交互"
  | "模型响应慢 / 额度"
  | "崩溃 / Internal Error"
  | "文档 / 使用咨询"
  | "其它";

export type FeedbackTicketFramework = "zcode-agent";

/**
 * The UI Select forbids empty-string option values (Radix throws),
 * so this sentinel stands for "unspecified"; converted to undefined before ticket submission.
 */
export const FEEDBACK_FRAMEWORK_NONE = "none" as const;
export type FeedbackTicketFrameworkSelectValue =
  | FeedbackTicketFramework
  | typeof FEEDBACK_FRAMEWORK_NONE;

export type FeedbackTicketSeverity = "P1-高" | "P2-中" | "P3-低";

export interface FeedbackReporter {
  user_id?: string;
  username?: string;
  display_name?: string;
}

export interface FeedbackDeviceInfo {
  appVersion?: string;
  buildCommitId?: string;
  buildTime?: string;
  electronVersion?: string;
  nodeVersion?: string;
  osType?: string;
  osPlatform?: string;
  osRelease?: string;
  osVersion?: string;
  osArch?: string;
  /// The agent at submission time; pinned to ZCode Agent in single-agent mode.
  agentProvider?: string;
  /// Framework id normalized for the feedback platform at submission; currently fixed to zcode-agent.
  agentFramework?: FeedbackTicketFramework;
  /// Raw selected value in the model config at submission.
  agentModel?: string;
  /// Display name matched from the model list at submission; falls back to agentModel when absent.
  agentModelDisplay?: string;
  /// Option count of the model list at submission.
  agentModelOptionCount?: number;
  /// Display-name preview of the model list at submission, for debugging config context.
  agentModelOptionsPreview?: string[];
  hostname?: string;
  deviceMid?: string;
}

export interface CreateFeedbackTicketInput {
  title: string;
  description: string;
  type: FeedbackTicketType;
  severity?: FeedbackTicketSeverity;
  module?: FeedbackTicketModule;
  framework?: FeedbackTicketFramework;
  source?: string;
  reporter?: FeedbackReporter;
  device?: FeedbackDeviceInfo;
  /// Optional user contact (email or other social handle); not required by the backend.
  contact?: string;
  /// Current UI locale, header passthrough only, never written into the ticket body.
  locale?: "zh-CN" | "en-US";
}

export interface FeedbackTicketSummary {
  id: string;
  title: string;
  type: FeedbackTicketType;
  severity?: FeedbackTicketSeverity;
  module?: FeedbackTicketModule;
  status: FeedbackTicketStatus;
  assignee_id?: string | null;
  /// Assignee display name (backend-filled); null when unassigned
  assignee_display?: string | null;
  /// Reporter display name returned by the backend
  reporter_display?: string | null;
  /// Any new activity since last viewed
  unread?: boolean;
  /// Time of the user's latest activity
  last_user_activity_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type FeedbackTicketEventType =
  | "created"
  | "status_changed"
  | "assignee_changed"
  | "staff_replied"
  | "user_replied";

export interface FeedbackTicketEvent {
  id: number;
  type: FeedbackTicketEventType;
  summary: string;
  actor_display_name?: string | null;
  payload?: Record<string, unknown> | null;
  created_at: string;
}

export interface FeedbackAttachment {
  id: number;
  kind: FeedbackAttachmentKind;
  filename: string;
  size: number;
  sha256?: string | null;
  redacted: boolean;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
  created_at: string;
}

export interface FeedbackCommentAttachment {
  id: number;
  filename: string;
  size: number;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
}

export interface FeedbackComment {
  id: number;
  /// Backend message_id, letting attachments bind to that message after creation.
  message_id?: string;
  author_user_id?: string | null;
  author_display_name?: string | null;
  body: string;
  attachments?: FeedbackCommentAttachment[];
  is_staff: boolean;
  created_at: string;
}

export interface FeedbackTicketDetail extends FeedbackTicketSummary {
  description: string;
  framework?: FeedbackTicketFramework;
  reporter?: FeedbackReporter | null;
  device?: FeedbackDeviceInfo | null;
  attachments: FeedbackAttachment[];
  comments: FeedbackComment[];
  events: FeedbackTicketEvent[];
  lark_record_id?: string | null;
}

export interface FeedbackListQuery {
  mine?: boolean;
  status?: FeedbackTicketStatus;
  type?: FeedbackTicketType;
  offset?: number;
  limit?: number;
}

export interface FeedbackListResult {
  items: FeedbackTicketSummary[];
  total: number;
}

export const FEEDBACK_TICKET_MODULES: FeedbackTicketModule[] = [
  "Plugin / MCP",
  "Agent任务执行失败",
  "模型配置 / API Key",
  "模型调用报错",
  "权限 / 配置保存",
  "SSH连接失败",
  "WSL连接失败",
  "UI布局 / 交互",
  "模型响应慢 / 额度",
  "崩溃 / Internal Error",
  "文档 / 使用咨询",
  "其它",
];

export const FEEDBACK_TICKET_TYPES: { value: FeedbackTicketType; label: string }[] = [
  { value: "bug", label: "Bug report" },
  { value: "usage", label: "Usage issue" },
  { value: "feature", label: "Feature request" },
  { value: "performance", label: "Performance issue" },
];

export const FEEDBACK_TICKET_SEVERITIES: FeedbackTicketSeverity[] = ["P1-高", "P2-中", "P3-低"];

export const DEFAULT_FEEDBACK_TICKET_FRAMEWORK: FeedbackTicketFramework = "zcode-agent";

export const FEEDBACK_TICKET_FRAMEWORK_OPTIONS: {
  value: FeedbackTicketFramework;
  label: string;
}[] = [{ value: "zcode-agent", label: "ZCode Agent" }];

/** Full list including "Unspecified", for admin surfaces and the like. */
export const FEEDBACK_TICKET_FRAMEWORKS: {
  value: FeedbackTicketFrameworkSelectValue;
  label: string;
}[] = [{ value: FEEDBACK_FRAMEWORK_NONE, label: "Unspecified" }, ...FEEDBACK_TICKET_FRAMEWORK_OPTIONS];
