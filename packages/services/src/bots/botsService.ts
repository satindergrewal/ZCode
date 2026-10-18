import { replyToBotChannel } from "#src/bots/channelReply.js";
import {
  BotAdminRequiredError,
  BotReplyError,
  createGroupAdminAttention,
} from "#src/bots/groupAdminAttention.js";
import { createTopicPreparationState } from "#src/bots/topicPreparationState.js";
import { createTopicContinuation } from "#src/bots/topicContinuation.js";
import { TopicHistoryPermissionError } from "#src/bots/topicHistory.js";
import {
  createTopicHistoryAttachment,
  botGroupCommandId,
} from "#src/bots/topicHistoryAttachment.js";
import { createGroupDeliveryThrottle } from "#src/bots/groupDeliveryThrottle.js";
import { createGroupResultDelivery } from "#src/bots/groupResultDelivery.js";
import { createGroupQueueCardSync } from "#src/bots/groupQueueCard.js";
import { readAuthorizedTopicResource, authorizeTopicResource } from "#src/bots/topicResource.js";
import {
  getBotConversationKey,
  getBotStateKey,
  isGroupOwnerCommand,
  canAnswerGroupQuestion,
} from "./groupSessions.js";
/* eslint-disable max-lines -- The bots service keeps the legacy RPC filename while centralizing auth, command routing, and the ZCode Agent bridge. */
import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IDisposable } from "@zcode/rpc";
import { completeNewModelSelection } from "@zcode/provider";
import {
  ALL_BOT_WORKSPACES,
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  generateTraceId,
  normalizeAgentProviderToZCodeAgent,
  ZCODE_AGENT_PROVIDER,
  BOT_TASK_BROADCAST_CHANNEL,
  BOT_TASK_STREAM_BROADCAST_CHANNEL,
  appendAssistantMessagePart,
  buildZCodeAssistantPresentation,
  decodeCustomModelValue,
  encodeCustomModelValue,
  getPermissionRequestPreview,
  getSupportedBotReplyGranularities,
  normalizeBotReplyGranularity,
  type ZCodeConfigOption,
  type ZCodeElicitationRequest,
  type ZCodeElicitationQuestion,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
  type ZCodePromptAttachment,
  type ZCodeTaskMode,
  type ZCodeAssistantMessagePart,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeProvider,
  type ZCodeStreamEvent,
  type TaskStreamMirrorableEvent,
  type ZCodeTaskMeta,
  type BotActor,
  type BotTaskBroadcastPayload,
  type BotTaskStreamBroadcastPayload,
  type BotConfig,
  type BotContextState,
  type BotDraftOptions,
  type BotCommand,
  type BotInboundAttachment,
  type BotInboundMessage,
  type BotOutboundMessage,
  type BotGroupDelivery,
  type BotGroupInputProgress,
  type BotGroupInputStatus,
  type BotPendingElicitation,
  type BotStructuredElicitationResponse,
  isFeishuBotProvider,
  type BotProvider,
  type BotProviderCallbackResult,
  type BotReplyGranularity,
  type BotRuntimeInfo,
  type BotWorkspaceRef,
  type ModelSelection,
  type BotsConfigFile,
  type Locale,
  type SelectionPrompt,
} from "@zcode/shared";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import { resolveProviderModeIdFromConfigOptions } from "#src/session/sessionModeOptions.js";
import { deriveSessionTitle as deriveTaskTitle } from "#src/session/sessionTitle.js";
import type { IBroadcastService } from "../broadcast/broadcast.js";
import type { ICredentialService } from "../credential/credential.js";
import { getAppConfigDir } from "../paths.js";
import type { ISettingService } from "../setting/setting.js";
import type {
  IModelSelectionService,
  ModelSelectionView,
} from "../model-provider/providerFacadeServices.js";
import type { ZCodeAgentAppRuntimePreferences } from "../zcode-agent/zcodeAgent.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  BotBindCodeResult,
  BotAutomationRunWatchParams,
  BotCreateBindCodeParams,
  BotListWorkspaceRefsParams,
  BotSaveBotParams,
  BotTestResult,
  BotUserConfigOptionsParams,
  IBotsService,
} from "./bots.js";
import {
  beginFeishuAppRegistration,
  pollFeishuAppRegistration,
} from "./providers/feishuAppRegistration.js";
import {
  BOT_BIND_CODE_TTL_MS,
  buildBotCredentialKey,
  buildBotWebhookSecretKey,
  getDefaultBotReplyGranularity,
  normalizeBotCommandPolicy,
  normalizeBotCurrentOptions,
} from "./config.js";
import { BOT_MENU_COMMAND_ORDER } from "./commandOrder.js";
import { parseBotCommand } from "./commandParser.js";
import { BotsRepo } from "./repo.js";
import type {
  BotProviderAdapter,
  BotStreamingReplyCardBlock,
  BotStreamingReplyCardHandle,
  BotTransientInteractionCardHandle,
  BotTypingTarget,
} from "./providers/types.js";
import { createTelegramBotProvider } from "./providers/telegramProvider.js";
import { createWebhookBotProvider } from "./providers/webhookProvider.js";
import { createWeixinBotProvider } from "./providers/weixinProvider.js";
import {
  beginWeixinRegistration as beginWeixinQrRegistration,
  pollWeixinRegistration as pollWeixinQrRegistration,
} from "./providers/weixinRegistration.js";
import { createFeishuBotProvider, splitFeishuText } from "./providers/feishuProvider.js";
import { formatBotMessage, type BotMessageId } from "./messages.js";
import {
  extractBotAssistantResponseMessages,
  formatBotAssistantReplyBlocks,
  formatBotToolCallSummaryLine,
  formatBotPermissionRequestSummary,
  formatBotToolCallReply,
  isBotToolCallReplyTerminal,
  updateBotReplyToolCalls,
  type BotAssistantReplyBlock,
  type BotReplyToolCallState,
} from "./replyFormatter.js";
import {
  findBoundUser,
  findAuthorizedBot,
  findCallbackBot,
  findBot,
  isUserCommandAllowed,
  normalizeBotConfig,
  normalizeConfigBots,
} from "./botConfigHelpers.js";
import {
  firstAllowedWorkspace,
  createWorkspaceRef,
  filterAllowedWorkspaces,
  getWorkspaceLabel,
  getWorkspaceKey,
  isWorkspaceAllowed,
  normalizeAllowedWorkspaces,
  normalizeConfiguredAllowedWorkspaces,
  resolveWorkspaceByValue,
} from "./workspaceHelpers.js";
import { getNativeModelProviderId } from "./modelSelectionHelpers.js";
import {
  formatStatusStreamToolProgress,
  formatStatusTaskLine,
  formatTaskRunningDuration,
  normalizeStatusProgressText,
  readLatestAssistantTurnChangeSummary,
  readLatestTaskProgress,
  readTaskWorkedDurationMs,
  taskStatus,
  truncateLiveStatusProgressText,
} from "./statusFormatting.js";
import { createTelegramChannelRuntime } from "./telegramChannelRuntime.js";
import { createBotTaskStreamHub } from "#src/bots/taskStreamHub.js";
import { createWeixinChannelRuntime } from "./weixinChannelRuntime.js";
import { createFeishuChannelRuntime } from "./feishuChannelRuntime.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

const botsLogger = createServiceLogger("bots");

function formatBotModelSelectionValue(selection: ModelSelection | undefined): string | undefined {
  if (!selection) return undefined;
  return selection.providerId === ZCODE_AGENT_PROVIDER
    ? selection.modelId
    : encodeCustomModelValue(selection.providerId, selection.modelId);
}

function parseBotModelOptionValue(value: string): ModelSelection | undefined {
  const decoded = decodeCustomModelValue(value);
  if (decoded?.providerId && decoded.modelName) {
    return { providerId: decoded.providerId, modelId: decoded.modelName };
  }
  const separatorIndex = value.indexOf("/");
  if (separatorIndex > 0 && separatorIndex < value.length - 1) {
    return {
      providerId: value.slice(0, separatorIndex),
      modelId: value.slice(separatorIndex + 1),
    };
  }
  return value.trim() ? { providerId: ZCODE_AGENT_PROVIDER, modelId: value.trim() } : undefined;
}

const BOT_REPLY_GRANULARITY_OPTIONS = [
  {
    id: "assistant_changes",
    label: { "zh-CN": "标准回复", "en-US": "Standard reply" },
    aliases: ["assistant", "assistant_changes", "normal", "default", "standard", "标准回复"],
  },
  {
    id: "assistant_toolcalls_changes",
    label: { "zh-CN": "完整回复", "en-US": "Full reply" },
    aliases: ["full", "tool", "toolcalls", "assistant_toolcalls_changes", "完整回复"],
  },
  {
    id: "summary_changes",
    label: { "zh-CN": "摘要回复", "en-US": "Summary reply" },
    aliases: ["summary", "summary_changes", "latest", "摘要回复"],
  },
  {
    id: "streaming_card",
    label: { "zh-CN": "流式卡片", "en-US": "Streaming card" },
    aliases: ["stream", "streaming", "streaming_card", "流式", "流式卡片"],
  },
] as const satisfies ReadonlyArray<{
  id: BotReplyGranularity;
  label: Record<"zh-CN" | "en-US", string>;
  aliases: readonly string[];
}>;

const BOT_EXCLUSIVE_CREDENTIAL_PROVIDERS = new Set<BotProvider>(["telegram", "feishu", "lark"]);
const FEISHU_STREAMING_CARD_MIN_UPDATE_INTERVAL_MS = 1_000;
const FEISHU_STREAMING_CARD_REQUEST_TIMEOUT_MS = 15_000;
const FEISHU_STREAMING_CARD_FAILURE_BACKOFF_BASE_MS = 1_000;
const FEISHU_STREAMING_CARD_FAILURE_CIRCUIT_THRESHOLD = 3;
const BOT_ELICITATION_PROGRESS_BROADCAST_TIMEOUT_MS = 1_000;
const BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS = 3_000;

type StreamingCardTimelineBlock =
  | {
      type: "message";
      text: string;
    }
  | {
      type: "tools";
      toolIds: string[];
    };

const helpMessageByCommand = {
  help: "helpHelp",
  bind: "helpBind",
  status: "helpStatus",
  new: "helpNew",
  workspace: "helpWorkspace",
  model: "helpModel",
  mode: "helpMode",
  thoughtLevel: "helpThoughtLevel",
  reply: "helpReply",
} as const satisfies Record<(typeof BOT_MENU_COMMAND_ORDER)[number], BotMessageId>;

function validateBotConfig(config: BotsConfigFile, candidate: BotConfig): void {
  if (!candidate.id.trim()) {
    throw new Error("Bot id is required.");
  }
  if (candidate.enabled && candidate.providerUserId?.trim()) {
    const duplicateBinding = config.bots.find(
      (bot) =>
        bot.id !== candidate.id &&
        bot.enabled &&
        bot.provider === candidate.provider &&
        bot.providerUserId === candidate.providerUserId,
    );
    if (duplicateBinding) {
      throw new Error("An enabled bot with this provider user already exists.");
    }
  }
  if (
    candidate.enabled &&
    candidate.credentialRef?.trim() &&
    BOT_EXCLUSIVE_CREDENTIAL_PROVIDERS.has(candidate.provider)
  ) {
    const duplicateCredential = config.bots.find(
      (bot) =>
        bot.id !== candidate.id &&
        bot.enabled &&
        bot.provider === candidate.provider &&
        bot.credentialRef === candidate.credentialRef,
    );
    if (duplicateCredential) {
      throw new Error("Enabled polling bots cannot share the same credential.");
    }
  }
}

interface BotsServiceDeps {
  credentialService: ICredentialService;
  zcodeTaskService: IZCodeTaskService;
  broadcastService?: IBroadcastService;
  settingService?: ISettingService;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
  remoteWorkspaceService?: BotRemoteWorkspaceService;
  repo?: BotsRepo;
  // Fix: during desktop-attached remote startup, bot polling, the runtime lock, and model caches must not jump the gun;
  // These background tasks belong to the local desktop host, not the SSH/Docker remote first-connect path.
  runStartupBackgroundTasks?: boolean;
}

interface BotRemoteWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity: string;
}

interface BotRemoteWorkspaceReconnectResult {
  ok: boolean;
  message?: string;
}

interface BotRemoteWorkspaceService {
  isConnected(target: BotRemoteWorkspaceTarget): Promise<boolean>;
  ensureConnected(target: BotRemoteWorkspaceTarget): Promise<BotRemoteWorkspaceReconnectResult>;
  getZCodeTaskService?(target: BotRemoteWorkspaceTarget): Promise<IZCodeTaskService | null>;
  getModelSelectionService?(
    target: BotRemoteWorkspaceTarget,
  ): Promise<Pick<IModelSelectionService, "getView"> | null>;
  syncAppRuntimePreferences?(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
}

interface PreparedTopicMessage {
  generation: number;
  message: BotInboundMessage;
  prepared: PreparedBotMessageContent;
}

interface PreparedBotMessageContent {
  content: string;
  zcodeAttachments: ZCodePromptAttachment[];
}

type BotAuthorizedCommand =
  | "help"
  | "status"
  | "new"
  | "reconnect"
  | "workspace"
  | "model"
  | "mode"
  | "thoughtLevel"
  | "task"
  | "reply"
  | "stop"
  | "message"
  | "approve";

interface BindCodeRecord {
  botId: string;
  code: string;
  allowedWorkspaces: string[];
  expiresAt: number;
}

interface BotModelOption {
  id: string;
  label: string;
  description?: string;
}

interface BotModelProviderOption {
  id: string;
  label: string;
  description?: string;
  models: BotModelOption[];
}

interface BotTaskSelectionEntry {
  task: ZCodeTaskMeta;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface BotWorkspaceSelectionEntry {
  workspace: BotWorkspaceRef;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNestedRecord(
  value: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const nested = value?.[key];
  return isRecord(nested) ? nested : null;
}

function readNestedString(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const nested = value?.[key];
  return typeof nested === "string" && nested.trim().length > 0 ? nested : undefined;
}

function summarizeCallbackPayload(payload: unknown): string {
  if (!isRecord(payload)) {
    return `type=${typeof payload}`;
  }
  const header = readNestedRecord(payload, "header");
  const event = readNestedRecord(payload, "event") ?? payload;
  const message = readNestedRecord(event, "message");
  const context = readNestedRecord(payload, "context");
  const action = readNestedRecord(payload, "action");
  const keys = Object.keys(payload).slice(0, 16).join(",");
  return [
    `keys=${keys || "none"}`,
    `botId=${readNestedString(payload, "botId") ?? "none"}`,
    `eventType=${readNestedString(header, "event_type") ?? readNestedString(header, "type") ?? readNestedString(payload, "event_type") ?? "none"}`,
    `messageType=${readNestedString(message, "message_type") ?? "none"}`,
    `chatType=${readNestedString(message, "chat_type") ?? readNestedString(context, "chat_type") ?? readNestedString(payload, "chat_type") ?? "none"}`,
    `hasAction=${action ? "true" : "false"}`,
  ].join(" ");
}

function createCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function getReplyGranularityOptions(locale: Locale | undefined, provider?: BotProvider) {
  const messageLocale = locale === "en-US" ? "en-US" : "zh-CN";
  const supportedIds = provider ? new Set(getSupportedBotReplyGranularities(provider)) : null;
  return BOT_REPLY_GRANULARITY_OPTIONS.filter(
    (option) => !supportedIds || supportedIds.has(option.id),
  ).map((option) => ({
    id: option.id,
    label: option.label[messageLocale],
  }));
}

function resolveReplyGranularityByValue(
  value: string,
  locale: Locale | undefined,
  provider?: BotProvider,
) {
  const trimmed = value.trim();
  const index = Number.parseInt(trimmed, 10);
  const options = getReplyGranularityOptions(locale, provider);
  if (Number.isFinite(index) && index > 0) {
    return options[index - 1] ?? null;
  }
  const normalized = normalizeText(trimmed);
  const option = BOT_REPLY_GRANULARITY_OPTIONS.find(
    (item) =>
      (item.aliases as readonly string[]).includes(normalized) ||
      normalizeText(item.label["zh-CN"]) === normalized ||
      normalizeText(item.label["en-US"]) === normalized,
  );
  return option ? (options.find((item) => item.id === option.id) ?? null) : null;
}

function resolveOptionByValue<T extends { id: string; label: string }>(
  items: T[],
  value: string,
): T | null {
  const trimmed = value.trim();
  if (/^[1-9]\d*$/u.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10);
    return items[index - 1] ?? null;
  }
  const normalized = normalizeText(trimmed);
  return (
    items.find(
      (item) => normalizeText(item.id) === normalized || normalizeText(item.label) === normalized,
    ) ?? null
  );
}

function isSelectionIndexValue(value: string): boolean {
  return /^[1-9]\d*$/u.test(value.trim());
}

function createOutbound(
  actor: BotActor,
  text: string,
  selection?: SelectionPrompt,
  extras: Pick<
    BotOutboundMessage,
    "elicitation" | "locale" | "groupSourceCommandId" | "groupTaskId"
  > = {},
): BotOutboundMessage {
  return {
    botId: actor.botId,
    provider: actor.provider,
    providerUserId: actor.chatId ?? actor.providerUserId,
    ...(isFeishuBotProvider(actor.provider) && actor.chatType === "group" && actor.providerMessageId
      ? {
          replyToMessageId: actor.providerMessageId,
          mentionedUserIds:
            !actor.threadId || actor.mentionedBot === true ? [actor.providerUserId] : undefined,
        }
      : {}),
    ...(actor.threadId ? { threadId: actor.threadId, rootMessageId: actor.rootMessageId } : {}),
    ...(actor.conversationThreadId !== undefined
      ? { conversationThreadId: actor.conversationThreadId }
      : {}),
    text,
    ...(selection ? { selection } : {}),
    ...extras,
    ...(actor.providerContextToken ? { providerContextToken: actor.providerContextToken } : {}),
  };
}

function groupCardFor(
  actor: BotActor,
  context: BotContextState,
): import("@zcode/shared").BotGroupCard {
  const group = context.group!;
  const threadId = actor.threadId ?? group.threadId;
  return {
    chatId: group.chatId,
    threadId,
    taskId: context.activeTaskId,
    authorizationId: group.authorizationId!,
    ...(threadId !== group.threadId ? { conversationThreadId: group.threadId ?? null } : {}),
  };
}

function resolveAutomationBotDeliveryTarget(
  actor: BotActor,
): ZCodeAutomationBotDeliveryTarget | undefined {
  if (actor.provider !== "feishu" && actor.provider !== "lark" && actor.provider !== "weixin") {
    return undefined;
  }
  const providerUserId = actor.chatId?.trim() || actor.providerUserId.trim();
  if (!providerUserId) return undefined;
  return {
    provider: actor.provider,
    botId: actor.botId,
    providerUserId,
    chatType: actor.chatType,
    ...(actor.threadId ? { threadId: actor.threadId, rootMessageId: actor.rootMessageId } : {}),
  };
}

function formatSelectionFallback(selection: SelectionPrompt, locale?: Locale): string {
  const lines = selection.options.map((option, index) => {
    const description = option.description ? ` ${option.description}` : "";
    return `${index + 1}. ${option.label}${description}`;
  });
  // Bugfix: plain-text channels like WeCom have no option cards; expanding full slash commands and long paths,
  // workspace/remote identities bloat messages. Show the index only; numeric parsing stays in pending selection.
  if (selection.showCancel === false) {
    return `${selection.title}\n${lines.join("\n")}\n\n${formatBotMessage(locale, "selectionTextHintNoCancel")}`;
  }
  const cancelLabel = selection.cancelLabel ?? formatBotMessage(locale, "selectionCancelOption");
  return `${selection.title}\n0. ${cancelLabel}\n${lines.join("\n")}\n\n${formatBotMessage(locale, "selectionTextHint")}`;
}

type BotPermissionOptionDisplayKind =
  | "allowOnce"
  | "allowAlways"
  | "rejectOnce"
  | "rejectAlways"
  | "custom";

const BOT_PERMISSION_OPTION_PRIORITY = {
  allowOnce: 0,
  allowAlways: 1,
  rejectOnce: 2,
  rejectAlways: 3,
  custom: 4,
} as const satisfies Record<BotPermissionOptionDisplayKind, number>;

function getBotPermissionOptionDisplayKind(
  option: ZCodePermissionOption,
): BotPermissionOptionDisplayKind {
  const text = `${option.optionId} ${option.kind} ${option.name}`.toLowerCase();
  const isAlways =
    /\b(always|persistent|permanent|remember)\b/u.test(text) ||
    /始终|永久|记住|不再询问/u.test(text);
  const isAllow = /\b(allow|approve|accept|yes)\b/u.test(text) || /允许|同意|批准/u.test(text);
  const isReject = /\b(deny|reject|decline|no)\b/u.test(text) || /拒绝|不允许|否/u.test(text);
  if (isAllow) {
    return isAlways ? "allowAlways" : "allowOnce";
  }
  if (isReject) {
    return isAlways ? "rejectAlways" : "rejectOnce";
  }
  return "custom";
}

function sortBotPermissionOptions(
  options: readonly ZCodePermissionOption[],
): ZCodePermissionOption[] {
  return [...options].sort((left, right) => {
    const leftPriority = BOT_PERMISSION_OPTION_PRIORITY[getBotPermissionOptionDisplayKind(left)];
    const rightPriority = BOT_PERMISSION_OPTION_PRIORITY[getBotPermissionOptionDisplayKind(right)];
    return leftPriority - rightPriority;
  });
}

function formatBotPermissionOptionLabel(option: ZCodePermissionOption, locale?: Locale): string {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  if (locale === "en-US") {
    switch (displayKind) {
      case "allowOnce":
        return "Allow";
      case "allowAlways":
        return "Always Allow";
      case "rejectOnce":
        return "Deny";
      case "rejectAlways":
        return "Always Deny";
      case "custom":
        return option.name;
    }
  }
  switch (displayKind) {
    case "allowOnce":
      return "允许";
    case "allowAlways":
      return "始终允许";
    case "rejectOnce":
      return "拒绝";
    case "rejectAlways":
      return "始终拒绝";
    case "custom":
      return option.name;
  }
}

function formatBotPermissionOptionDescription(
  option: ZCodePermissionOption,
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
  locale?: Locale,
): string | undefined {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  if (displayKind === "custom") {
    return option.kind;
  }
  const scope = getPermissionRequestPreview(request).scope;
  if (locale === "en-US") {
    if (displayKind === "allowOnce") {
      return "Allow this time only";
    }
    if (displayKind === "rejectOnce") {
      return "Reject this time";
    }
    if (displayKind === "allowAlways") {
      return scope === "command"
        ? "Do not ask again for the same command"
        : scope === "file"
          ? "Do not ask again for the same file operation"
          : "Do not ask again for the same permission request";
    }
    return scope === "command"
      ? "Always reject the same command"
      : scope === "file"
        ? "Always reject the same file operation"
        : "Always reject the same permission request";
  }
  if (displayKind === "allowOnce") {
    return "仅允许这一次";
  }
  if (displayKind === "rejectOnce") {
    return "这次先拒绝";
  }
  if (displayKind === "allowAlways") {
    return scope === "command"
      ? "后续相同命令不再询问"
      : scope === "file"
        ? "后续相同文件操作不再询问"
        : "后续相同权限请求不再询问";
  }
  return scope === "command"
    ? "后续相同命令也会直接拒绝"
    : scope === "file"
      ? "后续相同文件操作也会直接拒绝"
      : "后续相同权限请求也会直接拒绝";
}

function isBotPermissionRejectOption(option: ZCodePermissionOption): boolean {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  return displayKind === "rejectOnce" || displayKind === "rejectAlways";
}

function stripModelProviderDescriptionsForTextSelection(
  selection: SelectionPrompt,
): SelectionPrompt {
  if (selection.action !== "model.provider.set") {
    return selection;
  }
  return {
    ...selection,
    options: selection.options.map((option) => ({
      ...option,
      description: undefined,
    })),
  };
}

function formatWorkspaceOptionLabel(workspace: BotWorkspaceRef, locale?: Locale): string {
  if (!workspace.workspaceIdentity) {
    return workspace.label;
  }
  const remoteLabel = locale === "en-US" ? "[Remote]" : "[远端]";
  return `${workspace.label} ${remoteLabel}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_BOT_ZCODE_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;
// Bot mode is hard-locked to yolo: every bot task runs interaction-free and /mode switching is disabled.
const BOT_FORCED_MODE = "yolo";
const BOT_TYPING_INTERVAL_MS = 4_000;
const BOT_TASK_META_RETRY_DELAYS_MS = [80, 160, 320] as const;
const BOT_WORKSPACE_REFS_CACHE_TTL_MS = 5_000;
const BOT_MAX_ATTACHMENTS_PER_MESSAGE = 4;
const BOT_MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;
const BOT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
const REMOTE_RECONNECT_DEDUPE_TTL_MS = 3_000;
const REMOTE_RECONNECT_DELIVERY_DEDUPE_TTL_MS = 2 * 60_000;
const BOT_INBOUND_DELIVERY_DEDUPE_TTL_MS = 2 * 60_000;
const BOT_AUTOMATION_DELIVERY_WARNING_TTL_MS = 5 * 60_000;
const BOT_ELICITATION_CUSTOM_OPTION_ID = "__custom__";
const BOT_ELICITATION_SUBMIT_OPTION_ID = "__submit__";
const BOT_ELICITATION_SKIP_OPTION_ID = "__skip__";
const BOT_ELICITATION_FORM_VALUE_PREFIX = "__form__:";

export function createBotsService(
  deps: BotsServiceDeps,
): IBotsService & { disposeAll(): void; disposeAllAndWait(): Promise<void> } {
  const runStartupBackgroundTasks = deps.runStartupBackgroundTasks !== false;
  const repo = deps.repo ?? new BotsRepo();
  const bindCodes = new Map<string, BindCodeRecord>();
  const automationDeliveryWarningAtByKey = new Map<string, number>();
  const streamSubscriptions = new Map<
    string,
    IDisposable & { automation(runId?: string): void; imInput(): void }
  >();
  const taskStreamHub = createBotTaskStreamHub<ZCodeStreamEvent | TaskStreamMirrorableEvent>();
  const failedPrivateDeliveries = new Map<
    string,
    {
      id: string;
      message: BotOutboundMessage;
      bindingId: string | undefined;
      taskId: string;
      sending: boolean;
    }
  >();
  const privateReconciliations = new Map<string, Promise<void>>();
  const privateImTraces = new Set<string>();
  const watchStarts = new Map<string, Promise<void>>();
  const privateWatches = new Map<string, { signature: string; key: string }>();
  const forwardedTaskEvents = new WeakSet<object>();
  let privateRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  let privateRecoveryPending = false;
  const streamingCardRequestControllers = new Set<AbortController>();
  const transientInteractionCards = new Map<
    string,
    {
      bot: BotConfig;
      taskId: string;
      handle: BotTransientInteractionCardHandle;
    }
  >();
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  const typingTargets = new Map<string, { bot: BotConfig; target: BotTypingTarget }>();
  const runningTasks = new Set<string>();
  const topicContinuations = new Map<
    string,
    ReturnType<typeof createTopicContinuation<PreparedTopicMessage>>
  >();
  const topicHistoryReady = new Map<string, string>();
  const botHistoryEpoch = new Map<string, number>();
  const groupHistoryEpoch = new Map<string, number>();
  const topicStops = new Map<string, Promise<void>>();
  const topicPreparation = createTopicPreparationState();
  const publishTopicPreparation = () =>
    deps.broadcastService?.send({ channel: "bots:group-state", payload: {} });
  const topicGenerations = new Map<string, number>();
  const topicReplies = new Map<string, Map<string, (replies: BotOutboundMessage[]) => void>>();

  const liveStatusProgressByTaskId = new Map<
    string,
    { kind: "message" | "thought" | "tool"; text: string }
  >();
  const runtimeByBotId = new Map<string, BotRuntimeInfo>();
  const pendingSelectionsByContext = new Map<string, SelectionPrompt>();
  // Read only subscription and running-state counts; never expose message contents.
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("bots", () => ({
    streamSubs: streamSubscriptions.size,
    runningTasks: runningTasks.size,
    typingIntervals: typingIntervals.size,
    liveStatusProgress: liveStatusProgressByTaskId.size,
  }));
  const pendingTaskSelectionsByContext = new Map<string, Map<string, BotTaskSelectionEntry>>();
  const pendingWorkspaceSelectionsByContext = new Map<
    string,
    Map<string, BotWorkspaceSelectionEntry>
  >();
  const pendingRemoteReconnectsByKey = new Map<string, Promise<BotOutboundMessage[]>>();
  const recentRemoteReconnectAtByKey = new Map<string, number>();
  const recentRemoteReconnectDeliveryAtByKey = new Map<string, number>();
  const recentInboundDeliveryAtByKey = new Map<string, number>();
  const inboundProcessingQueuesByContext = new Map<string, Promise<void>>();
  let botStorageMigrationPromise: Promise<void> | null = null;
  const cachedWorkspaceRefsByKey = new Map<
    string,
    { expiresAt: number; value: BotWorkspaceRef[] }
  >();
  let cachedLocale: Locale | undefined;
  const providers: Record<BotProvider, BotProviderAdapter | null> = {
    telegram: createTelegramBotProvider({
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    webhook: createWebhookBotProvider({
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    feishu: createFeishuBotProvider({
      onDeliveryResult,
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    lark: createFeishuBotProvider({
      onDeliveryResult,
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    weixin: createWeixinBotProvider({
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    discord: null,
    wecom: null,
  };
  let service: IBotsService & {
    disposeAll(): void;
    disposeAllAndWait(): Promise<void>;
  };
  let shutdownPromise: Promise<void> | null = null;

  function onDeliveryResult(bot: BotConfig, deliveryError: string | undefined): void {
    // Receiving fine does not mean replies deliver; keep delivery errors out of the connection bucket.
    const current = runtimeByBotId.get(bot.id);
    setRuntimeStatus({
      botId: bot.id,
      provider: bot.provider,
      status: current?.status ?? (bot.enabled ? "idle" : "disabled"),
      deliveryError:
        deliveryError ?? (failedPrivateDeliveries.has(bot.id) ? current?.deliveryError : undefined),
    });
  }

  function setRuntimeStatus(status: BotRuntimeInfo): void {
    runtimeByBotId.set(status.botId, {
      ...runtimeByBotId.get(status.botId),
      ...status,
      lastUpdateAt: Date.now(),
    });
  }

  const statusSink = {
    getRuntimeStatus(botId: string) {
      return runtimeByBotId.get(botId);
    },
    setRuntimeStatus,
  };
  const telegramRuntime = createTelegramChannelRuntime({
    runBackgroundTasks: runStartupBackgroundTasks,
    credentialService: deps.credentialService,
    telegramProvider: providers.telegram,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated,
    readConfig: () => repo.readConfig(),
    readTelegramOffset,
    writeTelegramOffset,
    processProviderCallback,
  });
  const weixinRuntime = createWeixinChannelRuntime({
    runBackgroundTasks: runStartupBackgroundTasks,
    credentialService: deps.credentialService,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated,
    readConfig: () => repo.readConfig(),
    readWeixinGetUpdatesBuf,
    writeWeixinGetUpdatesBuf,
    processProviderCallback,
  });
  const feishuRuntime = createFeishuChannelRuntime({
    runBackgroundTasks: runStartupBackgroundTasks,
    credentialService: deps.credentialService,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated,
    readConfig: () => repo.readConfig(),
    summarizeCallbackPayload,
    onConnectionInvalidated: (botId) =>
      botHistoryEpoch.set(botId, (botHistoryEpoch.get(botId) ?? 0) + 1),
    processProviderCallback,
  });

  async function readTelegramOffset(botId: string): Promise<number | undefined> {
    return (await repo.readState()).bots[botId]?.telegramOffset;
  }

  async function writeTelegramOffset(botId: string, offset: number): Promise<void> {
    await serializeStateWrite(async () => {
      const state = await repo.readState();
      const existing = state.bots[botId];
      if (existing) {
        state.bots[botId] = {
          ...existing,
          telegramOffset: offset,
          updatedAt: Date.now(),
        };
      } else {
        const bot = findBot(await repo.readConfig(), botId);
        const workspace = bot ? firstAllowedWorkspace(await listWorkspaceRefs(), bot) : null;
        if (bot && workspace) {
          state.bots[botId] = {
            botId: botId,
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
            workspaceId: workspace.id,
            mode: "draft",
            activeTaskId: null,
            telegramOffset: offset,
            updatedAt: Date.now(),
          };
        }
      }
      await repo.writeState(state);
    });
  }

  async function readWeixinGetUpdatesBuf(botId: string): Promise<string | undefined> {
    return (await repo.readState()).bots[botId]?.weixinGetUpdatesBuf;
  }

  async function writeWeixinGetUpdatesBuf(botId: string, buf: string): Promise<void> {
    await serializeStateWrite(async () => {
      const state = await repo.readState();
      const existing = state.bots[botId];
      if (existing) {
        state.bots[botId] = {
          ...existing,
          weixinGetUpdatesBuf: buf,
          updatedAt: Date.now(),
        };
      } else {
        const bot = findBot(await repo.readConfig(), botId);
        const workspace = bot ? firstAllowedWorkspace(await listWorkspaceRefs(), bot) : null;
        if (bot && workspace) {
          state.bots[botId] = {
            botId,
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
            workspaceId: workspace.id,
            mode: "draft",
            activeTaskId: null,
            weixinGetUpdatesBuf: buf,
            updatedAt: Date.now(),
          };
        }
      }
      await repo.writeState(state);
    });
  }

  async function readContext(actor: BotActor, bot: BotConfig): Promise<BotContextState | null> {
    await ensureBotStorageMigrated();
    const state = await repo.readState();
    const existing = state.bots[getBotConversationKey(actor)];
    if (existing) {
      const latestWorkspaces = await listWorkspaceRefs();
      const canonicalWorkspace = resolveCanonicalContextWorkspace(existing, latestWorkspaces);
      if (!canonicalWorkspace) {
        return existing;
      }
      const currentWorkspaceKey = getWorkspaceKey(
        existing.workspacePath,
        existing.workspaceIdentity,
      );
      const nextWorkspaceId =
        existing.workspaceId && existing.workspaceId !== currentWorkspaceKey
          ? existing.workspaceId
          : canonicalWorkspace.id;
      const nextContext: BotContextState = {
        ...existing,
        workspacePath: canonicalWorkspace.workspacePath,
        workspaceIdentity: canonicalWorkspace.workspaceIdentity,
        workspaceId: nextWorkspaceId,
      };
      if (
        nextContext.workspacePath === existing.workspacePath &&
        nextContext.workspaceIdentity === existing.workspaceIdentity &&
        nextContext.workspaceId === existing.workspaceId
      ) {
        return existing;
      }
      // Bugfix: historical bot context may carry only workspacePath with no persisted remote workspaceIdentity.
      // createTask would still succeed, but the bots:task broadcast gets dropped by the UI on identity mismatch,
      // net effect: the third-party session replies while the sidebar task list never refreshes. Heal legacy context in the service layer first.
      await writeContext(nextContext);
      return nextContext;
    }
    if (actor.chatType === "group") {
      if (!actor.threadId) return null;
      const parent =
        state.bots[
          getBotConversationKey({ ...actor, threadId: undefined, conversationThreadId: undefined })
        ];
      if (!parent?.group?.enabled || parent.group.ownerId !== bot.providerUserId) return null;
      let topicTitle = actor.topicTitle;
      let topicUrl = actor.topicUrl;
      let rootMessageId = actor.rootMessageId;
      if (!topicTitle && actor.providerMessageId) {
        try {
          const resolved = await providers[bot.provider]?.resolveTopic?.(bot, actor);
          topicTitle = resolved?.topicTitle;
          topicUrl = resolved?.topicUrl;
          rootMessageId = resolved?.rootMessageId ?? rootMessageId;
        } catch {
          // When native events carry the topic identity, a missing read permission only affects the title; never widen history reads.
          topicTitle = actor.threadId;
        }
      }
      // Topics inherit the config snapshot only; never copy the default task's inputs, answers, or approval grants.
      const topic: BotContextState = {
        botId: bot.id,
        workspacePath: parent.workspacePath,
        workspaceIdentity: parent.workspaceIdentity,
        workspaceId: parent.workspaceId,
        mode: "draft",
        activeTaskId: null,
        updatedAt: Date.now(),
        draftOptions: { ...(await buildActiveTaskDraftOptions(parent)), mode: "default" },
        group: {
          chatId: parent.group.chatId,
          threadId: actor.threadId,
          rootMessageId,
          topicTitle,
          topicUrl,
          name: parent.group.name,
          ownerId: parent.group.ownerId,
          enabled: true,
          authorizationId: parent.group.authorizationId,
          taskIds: [],
          currentOptions: { ...parent.group.currentOptions, mode: "default" },
        },
      };
      await serializeStateWrite(async () => {
        const latest = await repo.readState();
        const currentParent = latest.bots[getBotStateKey(parent)];
        const key = getBotStateKey(topic);
        if (
          latest.bots[key] ||
          !currentParent?.group?.enabled ||
          currentParent.group.authorizationId !== topic.group!.authorizationId
        )
          return;
        latest.bots[key] = topic;
        await repo.writeState(latest);
      });
      return (await repo.readState()).bots[getBotStateKey(topic)] ?? null;
    }
    const workspace = firstAllowedWorkspace(await listWorkspaceRefs(), bot);
    if (!workspace) {
      return null;
    }
    return {
      botId: bot.id,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      workspaceId: workspace.id,
      mode: "draft",
      activeTaskId: null,
      draftOptions: await buildInitializedDraftOptions(workspace),
      updatedAt: Date.now(),
    };
  }

  let stateWriteTail: Promise<void> = Promise.resolve();
  async function readQueueCardScope(key: string) {
    const [botId, chatId, taskId, authorizationId, inputId, threadId] = JSON.parse(key) as string[];
    const state = await repo.readState();
    const context =
      state.bots[getBotConversationKey({ botId: botId!, chatType: "group", chatId, threadId })];
    const bot = findBot(await repo.readConfig(), botId!);
    const input = context?.group?.inputs?.[inputId!];
    if (
      !bot?.enabled ||
      !context?.group?.enabled ||
      context.group.ownerId !== bot.providerUserId ||
      context.group.authorizationId !== authorizationId ||
      context.activeTaskId !== taskId ||
      input?.taskId !== taskId
    )
      return undefined;
    return { state, context, bot, input };
  }
  const queueCards = createGroupQueueCardSync({
    read: async (key) => (await readQueueCardScope(key))?.input.progress ?? undefined,
    mutate: async (key, update) => {
      let result: BotGroupInputProgress | undefined;
      await serializeStateWrite(async () => {
        const scope = await readQueueCardScope(key);
        if (!scope) return;
        result = update(scope.input.progress ?? { status: "waiting" });
        scope.input.progress = result;
        await repo.writeState(scope.state);
      });
      return result;
    },
    render: async (key, providerMessageId, status) => {
      const scope = await readQueueCardScope(key);
      // Topics reuse the one-way state record but never render or refresh legacy queue cards.
      if (!scope || scope.context.group?.threadId) return;
      const english = (await readMessageLocale()) === "en-US";
      const text: Record<BotGroupInputStatus, string> = english
        ? {
            waiting: "Waiting to run",
            working: "Running",
            done: "Completed",
            failed: "Failed",
            stopped: "Stopped",
            cancelled: "Cancelled",
            discarded: "Not executed",
          }
        : {
            waiting: "等待执行",
            working: "正在执行",
            done: "已完成",
            failed: "执行失败",
            stopped: "已停止",
            cancelled: "已取消",
            discarded: "未执行",
          };
      const adapter = providers[scope.bot.provider];
      if (!adapter?.updateTransientInteractionCard)
        throw new Error("Queue card update unavailable");
      await adapter.updateTransientInteractionCard(
        scope.bot,
        { providerMessageId },
        {
          botId: scope.bot.id,
          provider: scope.bot.provider,
          providerUserId: scope.context.group!.chatId,
          text: text[status],
        },
      );
    },
  });
  function serializeStateWrite(operation: () => Promise<void>): Promise<void> {
    const next = stateWriteTail.catch(() => undefined).then(operation);
    stateWriteTail = next;
    return next;
  }
  async function writeBotConfig(next: BotsConfigFile): Promise<BotsConfigFile> {
    const invalidatedTopics: BotActor[] = [];
    const previous = await repo.readConfig();
    const saved = await repo.writeConfig(next);
    const changedBindings = new Set(
      previous.bots
        .filter((before) => {
          const after = saved.bots.find((bot) => bot.id === before.id);
          return (
            !after ||
            before.providerUserId !== after.providerUserId ||
            before.provider !== after.provider ||
            before.feishuAppId !== after.feishuAppId ||
            before.credentialRef !== after.credentialRef
          );
        })
        .map((bot) => bot.id),
    );
    const operation = stateWriteTail
      .catch(() => undefined)
      .then(async () => {
        const state = await repo.readState();
        let changed = false;
        for (const [key, context] of Object.entries(state.bots)) {
          const group = context.group;
          if (!group) {
            const before = previous.bots.find((item) => item.id === context.botId);
            const after = saved.bots.find((item) => item.id === context.botId);
            if (changedBindings.has(context.botId) || before?.enabled !== after?.enabled) {
              if (
                changedBindings.has(context.botId) &&
                before?.provider === "weixin" &&
                context.privateRecipientId
              )
                await deps.credentialService.delete(
                  weixinContextKey(before, context.privateRecipientId),
                );
              state.bots[key] = {
                ...context,
                privateBindingId: randomUUID(),
                ...(changedBindings.has(context.botId) ? { privateRecipientId: undefined } : {}),
              };
              changed = true;
            }
            continue;
          }
          const current = saved.bots.find((bot) => bot.id === context.botId);
          if (!changedBindings.has(context.botId) && current?.providerUserId === group.ownerId)
            continue;
          const originalBot = previous.bots.find((bot) => bot.id === context.botId);
          if (group.threadId && originalBot)
            invalidatedTopics.push({
              botId: context.botId,
              provider: originalBot.provider,
              chatType: "group",
              chatId: group.chatId,
              threadId: group.threadId,
              providerUserId: group.ownerId,
            });
          state.bots[key] = {
            ...context,
            group: {
              ...group,
              enabled: false,
              authorizationId: randomUUID(),
              deliveries: Object.fromEntries(
                Object.entries(group.deliveries ?? {}).map(([id, result]) => [
                  id,
                  result.status === "sent" ? result : { ...result, status: "invalidated" as const },
                ]),
              ),
            },
          };
          changed = true;
        }
        if (changed) await repo.writeState(state);
      });
    stateWriteTail = operation;
    await operation;
    // Grant changes must also invalidate uncommitted material instead of waiting for the old prep to return.
    await Promise.all(invalidatedTopics.map(cancelTopicInputs));
    if (changedBindings.size)
      await deps.broadcastService
        ?.send({ channel: "bots:group-state", payload: {} })
        .catch(() => undefined);
    for (const botId of new Set([...previous.bots, ...saved.bots].map((item) => item.id)))
      await reconcilePrivateSynchronization(botId);
    return saved;
  }

  async function writeContext(
    context: BotContextState,
    updateAuthorization = false,
    expectedTaskId?: string | null,
  ): Promise<void> {
    const next = stateWriteTail
      .catch(() => undefined)
      .then(async () => {
        const state = await repo.readState();
        const key = getBotStateKey(context);
        const latest = state.bots[key];
        const latestGroup = latest?.group;
        if (
          !context.group &&
          expectedTaskId !== undefined &&
          (latest?.activeTaskId !== expectedTaskId ||
            latest?.privateBindingId !== context.privateBindingId)
        )
          return;
        // Group events may start processing before a disable/rebind/switch lands; stale events never revive revoked associations.
        if (
          context.group &&
          !updateAuthorization &&
          latestGroup &&
          (latestGroup.authorizationId !== context.group.authorizationId ||
            (expectedTaskId !== undefined && latest?.activeTaskId !== expectedTaskId))
        )
          return;
        const group =
          context.group && latestGroup && !updateAuthorization
            ? {
                ...context.group,
                enabled: latestGroup.enabled,
                ownerId: latestGroup.ownerId,
                authorizationId: latestGroup.authorizationId,
                // Other topics may have flipped the group history switch; stale writes must not clobber the latest config.
                historyEnabled: latestGroup.historyEnabled,
                topicActive: latestGroup.topicActive ?? context.group.topicActive,
                taskIds: [...new Set([...latestGroup.taskIds, ...context.group.taskIds])],
                // A confirmed admission is terminal; late stream events must not write back into pending.
                inputs: Object.fromEntries(
                  Object.entries({ ...latestGroup.inputs, ...context.group.inputs }).map(
                    ([id, input]) => {
                      const latestInput = latestGroup.inputs?.[id];
                      const selected =
                        latestInput?.admission === "accepted" ||
                        latestInput?.admission === "rejected"
                          ? latestInput
                          : input;
                      // Stream events can land before admission; preserve the advanced card state when writing the receipt.
                      return [
                        id,
                        { ...selected, progress: latestInput?.progress ?? selected.progress },
                      ];
                    },
                  ),
                ),
                taskWorkspaces: { ...latestGroup.taskWorkspaces, ...context.group.taskWorkspaces },
                topicAliases: latestGroup.topicAliases,
                deliveries: latestGroup.deliveries,
              }
            : context.group;
        // Auto-reply counts persist serially at the entry; late task/grant writebacks must not restore budget from a stale snapshot.
        if (group && latestGroup?.autoReplyGuard) group.autoReplyGuard = latestGroup.autoReplyGuard;
        // Background checkpoints are updated at entry/receipt commit; stale task snapshots never overwrite or revive them.
        if (group && latestGroup) group.backgroundHistory = latestGroup.backgroundHistory;
        if (group && (!group.enabled || state.bots[key]?.activeTaskId !== context.activeTaskId)) {
          group.deliveries = Object.fromEntries(
            Object.entries(group.deliveries ?? {}).map(([id, entry]) => [
              id,
              entry.status === "sent" ? entry : { ...entry, status: "invalidated" as const },
            ]),
          );
        }
        const taskIds =
          group && context.activeTaskId
            ? [...new Set([...group.taskIds, context.activeTaskId])]
            : group?.taskIds;
        state.bots[key] = {
          ...context,
          ...(!group
            ? {
                privateBindingId:
                  latest?.activeTaskId === context.activeTaskId &&
                  getWorkspaceKey(latest.workspacePath, latest.workspaceIdentity) ===
                    getWorkspaceKey(context.workspacePath, context.workspaceIdentity)
                    ? (latest.privateBindingId ?? randomUUID())
                    : randomUUID(),
              }
            : {}),
          ...(group
            ? {
                group: {
                  ...group,
                  taskIds: taskIds!,
                  taskWorkspaces: {
                    ...group.taskWorkspaces,
                    ...(context.activeTaskId
                      ? {
                          [context.activeTaskId]: {
                            workspacePath: context.workspacePath,
                            workspaceIdentity: context.workspaceIdentity,
                          },
                        }
                      : {}),
                  },
                },
              }
            : {}),
          updatedAt: Date.now(),
        };
        if (updateAuthorization && group && !group.threadId) {
          // The group grant is the single authority; disable/rebind must invalidate every topic card in one write.
          for (const [topicKey, topic] of Object.entries(state.bots)) {
            if (
              topic.botId !== context.botId ||
              topic.group?.chatId !== group.chatId ||
              !topic.group.threadId
            )
              continue;
            stopGroupSynchronization(topic);
            state.bots[topicKey] = {
              ...topic,
              group: {
                ...topic.group,
                enabled: group.enabled,
                ownerId: group.ownerId,
                authorizationId: group.authorizationId,
                deliveries: Object.fromEntries(
                  Object.entries(topic.group.deliveries ?? {}).map(([id, result]) => [
                    id,
                    result.status === "sent"
                      ? result
                      : { ...result, status: "invalidated" as const },
                  ]),
                ),
              },
            };
          }
        }
        await repo.writeState(state);
      });
    stateWriteTail = next;
    await next;
    if (!context.group) {
      context.privateBindingId = (await repo.readState()).bots[context.botId]?.privateBindingId;
      await reconcilePrivateSynchronization(context.botId);
    }
    if (context.group)
      await deps.broadcastService
        ?.send({
          channel: "bots:group-state",
          payload: { botId: context.botId, chatId: context.group.chatId },
        })
        .catch(() => undefined);
  }

  function privateSyncSupported(bot: BotConfig): boolean {
    return ["feishu", "lark", "telegram", "weixin"].includes(bot.provider);
  }

  function taskStreamKey(context: BotContextState, actor: BotActor): string {
    return [
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      context.activeTaskId,
      getBotConversationKey(actor),
    ].join("::");
  }

  async function reconcilePrivateSynchronization(botId: string): Promise<void> {
    const previous = privateReconciliations.get(botId) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => restorePrivateSynchronization(botId))
      .catch(async (error: unknown) => {
        const bot = findBot(await repo.readConfig(), botId);
        if (bot) onDeliveryResult(bot, error instanceof Error ? error.message : String(error));
        botsLogger.warn(undefined, `Private Bot subscription failed bot=${botId}`);
      });
    privateReconciliations.set(botId, pending);
    try {
      await pending;
    } finally {
      if (privateReconciliations.get(botId) === pending) privateReconciliations.delete(botId);
    }
  }

  async function restorePrivateSynchronization(botId: string): Promise<void> {
    const bot = findBot(await repo.readConfig(), botId);
    let context = (await repo.readState()).bots[botId];
    const recipient =
      bot?.provider === "weixin" ? context?.privateRecipientId : bot?.providerUserId;
    const valid =
      !shutdownPromise &&
      bot?.enabled &&
      recipient &&
      privateSyncSupported(bot) &&
      context &&
      !context.group &&
      context.mode === "task" &&
      context.activeTaskId &&
      isWorkspaceAllowed(
        context.workspaceId ?? getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
        bot.allowedWorkspaces,
      ) &&
      (await isRemoteWorkspaceConnected(context));
    if (valid && context && !context.privateBindingId) {
      await serializeStateWrite(async () => {
        const state = await repo.readState();
        const latest = state.bots[botId];
        if (latest && !latest.privateBindingId) {
          state.bots[botId] = { ...latest, privateBindingId: randomUUID() };
          await repo.writeState(state);
        }
      });
      context = (await repo.readState()).bots[botId];
    }
    const signature = valid
      ? JSON.stringify([
          context?.privateBindingId,
          bot?.provider,
          recipient,
          context?.activeTaskId,
          context?.workspacePath,
          context?.workspaceIdentity,
        ])
      : "";
    const existing = privateWatches.get(botId);
    if (existing && existing.signature !== signature) {
      streamSubscriptions.get(existing.key)?.dispose();
      streamSubscriptions.delete(existing.key);
      privateWatches.delete(botId);
      failedPrivateDeliveries.delete(botId);
      const runtime = runtimeByBotId.get(botId);
      if (runtime)
        setRuntimeStatus({ ...runtime, deliveryRetryId: undefined, deliveryError: undefined });
    }
    if (!valid || !bot || !context || !signature || privateWatches.has(botId)) return;
    if (!(await isRemoteWorkspaceConnected(context))) return;
    const taskService = await resolveZCodeTaskServiceForContext(context);
    const deleted = await taskService.listDeletedTaskIds?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    if (deleted?.includes(context.activeTaskId!)) return;
    // Read the authoritative snapshot for cold recovery only; commit no input and replay no historical bodies.
    await taskService.getTaskSnapshot({
      taskId: context.activeTaskId!,
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      clientMode: "desktop-continuous",
    });
    if (shutdownPromise) return;
    const actor: BotActor = {
      botId,
      provider: bot.provider,
      providerUserId: recipient!,
      chatType: "private",
    };
    const key = taskStreamKey(context, actor);
    await watchTaskStream(bot, actor, context, bot);
    privateWatches.set(botId, { signature, key });
  }

  function weixinContextKey(bot: BotConfig, userId: string): string {
    // Credentials are isolated per account and recipient; they never enter normal bot state or logs.
    return `bot-weixin-context-${createHash("sha256")
      .update(JSON.stringify([bot.id, bot.providerUserId, bot.credentialRef, userId]))
      .digest("hex")}`;
  }

  async function capturePrivateContextToken(message: BotInboundMessage): Promise<void> {
    if (message.actor.provider !== "weixin" || message.actor.chatType !== "private") return;
    const bot = findAuthorizedBot(await repo.readConfig(), message.actor);
    if (!bot || bot.id !== message.botId) return;
    const context = await readContext(message.actor, bot);
    if (!context) return;
    // iLink's config.providerUserId is the bot identity, not an outbound recipient.
    await serializeStateWrite(async () => {
      const state = await repo.readState();
      const latest = state.bots[bot.id];
      if (!latest) return;
      if (latest.privateRecipientId !== message.actor.providerUserId) {
        state.bots[bot.id] = {
          ...latest,
          privateRecipientId: message.actor.providerUserId,
          privateBindingId: randomUUID(),
        };
        await repo.writeState(state);
      }
    });
    if (message.actor.providerContextToken)
      await deps.credentialService.save(
        weixinContextKey(bot, message.actor.providerUserId),
        message.actor.providerContextToken,
      );
    await reconcilePrivateSynchronization(bot.id);
  }

  function stopGroupSynchronization(context: BotContextState): void {
    if (!context.group || !context.activeTaskId) return;
    const key = [
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      context.activeTaskId,
      getBotStateKey(context),
    ].join("::");
    streamSubscriptions.get(key)?.dispose();
    streamSubscriptions.delete(key);
  }

  async function restoreGroupSynchronization(context: BotContextState): Promise<void> {
    if (!context.group?.enabled || !context.activeTaskId || shutdownPromise) return;
    const bot = findBot(await repo.readConfig(), context.botId);
    if (
      !bot?.enabled ||
      !isFeishuBotProvider(bot.provider) ||
      bot.providerUserId !== context.group.ownerId
    )
      return;
    // Recovery subscribes to future events only; no new connections when remote is down and no replay of received inputs.
    if (!(await isRemoteWorkspaceConnected(context))) return;
    await watchTaskStream(
      bot,
      {
        botId: bot.id,
        provider: bot.provider,
        chatType: "group",
        chatId: context.group.chatId,
        threadId: context.group.threadId,
        rootMessageId: context.group.rootMessageId,
        providerUserId: context.group.ownerId,
      },
      context,
      { ...bot, currentOptions: context.group.currentOptions, replyMode: "summary_changes" },
    );
  }

  async function handleGroupActivation(
    message: BotInboundMessage,
    enabled: boolean,
  ): Promise<BotOutboundMessage[]> {
    const locale = await readMessageLocale();
    const config = await repo.readConfig();
    const bot = findBot(config, message.botId);
    if (
      !bot?.enabled ||
      !isFeishuBotProvider(bot.provider) ||
      message.actor.chatType !== "group" ||
      !message.actor.chatId
    ) {
      return [createOutbound(message.actor, msg(locale, "privateChatOnly"))];
    }
    if (bot.providerUserId !== message.actor.providerUserId) {
      return [
        {
          ...administratorReply(
            message.actor,
            bot,
            "owner-command",
            createOutbound(message.actor, msg(locale, "groupOwnerOnly")),
          ),
          callbackToastOnly: true,
        },
      ];
    }
    // Enabling a group grants nothing on the platform; first and repeat enablement expose the same permission entry.
    const activationValues = {
      permissionsUrl:
        bot.provider === "lark" ? "https://open.larksuite.com/app" : "https://open.feishu.cn/app",
    };
    const key = getBotConversationKey({
      ...message.actor,
      threadId: undefined,
      conversationThreadId: undefined,
    });
    const existing = (await repo.readState()).bots[key];
    if (existing?.group?.ownerId === bot.providerUserId) {
      if (existing.group.enabled !== enabled) {
        stopGroupSynchronization(existing);
        const updated = {
          ...existing,
          group: { ...existing.group, enabled, authorizationId: randomUUID() },
        };
        await writeContext(updated, true);
        if (!enabled) await cancelGroupTopicInputs(message.actor);
        if (enabled) {
          for (const candidate of Object.values((await repo.readState()).bots)) {
            if (candidate.botId === bot.id && candidate.group?.chatId === message.actor.chatId)
              await restoreGroupSynchronization(candidate);
          }
        }
      }
      return [
        createOutbound(
          message.actor,
          msg(locale, enabled ? "groupEnabled" : "groupDisabled", activationValues),
        ),
      ];
    }
    if (!enabled) return [createOutbound(message.actor, msg(locale, "groupDisabled"))];
    const privateContext = await readContext(
      { ...message.actor, chatType: "private", chatId: undefined },
      bot,
    );
    if (!privateContext)
      return [
        administratorReply(
          message.actor,
          bot,
          "workspace",
          createOutbound(message.actor, msg(locale, "noWorkspaceAllowed")),
        ),
      ];
    const inherited = await buildActiveTaskDraftOptions(privateContext);
    const info = await providers[bot.provider]?.getGroupInfo?.(bot, message.actor.chatId);
    const context: BotContextState = {
      botId: bot.id,
      workspacePath: privateContext.workspacePath,
      workspaceIdentity: privateContext.workspaceIdentity,
      workspaceId: privateContext.workspaceId,
      mode: "draft",
      activeTaskId: null,
      updatedAt: Date.now(),
      draftOptions: { ...inherited, mode: "default" },
      group: {
        chatId: message.actor.chatId,
        chatMode: info?.chatMode,
        name: info?.name ?? message.actor.chatId,
        ownerId: bot.providerUserId!,
        enabled: true,
        authorizationId: randomUUID(),
        taskIds: [],
        currentOptions: {
          // After the model rework the full selection is inherited; legacy model/thoughtLevel fields are no longer persisted.
          modelSelection: bot.currentOptions.modelSelection,
          mode: "default",
        },
      },
    };
    await writeContext(context, true);
    return [createOutbound(message.actor, msg(locale, "groupEnabled", activationValues))];
  }

  async function handleGroupHistory(
    message: BotInboundMessage,
    enabled?: boolean,
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "workspace");
    if (!auth.ok) return auth.reply;
    if (!auth.context.group)
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US"
            ? "Topic history is configured in a group."
            : "请在群里配置话题历史读取。",
        ),
      ];
    const key = getBotConversationKey({
      ...message.actor,
      threadId: undefined,
      conversationThreadId: undefined,
    });
    let active = false;
    await serializeStateWrite(async () => {
      const state = await repo.readState();
      const parent = state.bots[key];
      if (!parent?.group?.enabled || parent.group.ownerId !== message.actor.providerUserId)
        throw new Error("Group authorization changed");
      if (enabled !== undefined) {
        parent.group.historyEnabled = enabled;
        await repo.writeState(state);
      }
      if (enabled !== undefined) {
        const key = JSON.stringify([message.botId, parent.group.chatId]);
        groupHistoryEpoch.set(key, (groupHistoryEpoch.get(key) ?? 0) + 1);
      }
      active = parent.group.historyEnabled !== false;
    });
    if (enabled === false) await cancelGroupTopicInputs(message.actor);
    return [
      createOutbound(
        message.actor,
        auth.locale === "en-US"
          ? active
            ? "Topic history enabled. The next topic input reconciles discussion history."
            : "Topic history is off. Topic input is paused."
          : active
            ? "已开启话题历史读取。下次话题输入会补齐讨论历史。"
            : "话题历史读取已关闭，话题输入已暂停。",
      ),
    ];
  }

  async function writeDraftContext(
    context: BotContextState,
    draftOptions?: BotDraftOptions,
  ): Promise<BotContextState> {
    // Bugfix: new-draft state used to be scattered across /new and /workspace, each hand-writing activeTaskId=null.
    // After a workspace switch, stale tasks/pending permissions make Telegram permission buttons hit the wrong context.
    // Route every entering-new-draft state change through one helper so old task state never leaks across workspaces.
    const draftContext: BotContextState = {
      ...context,
      mode: "draft",
      activeTaskId: null,
      draftOptions,
      pendingPermissionOptions: undefined,
      pendingElicitation: undefined,
    };
    if (context.group) {
      const prefix = `${context.botId}::`;
      for (const key of pendingSelectionsByContext.keys()) {
        if (key.startsWith(prefix) && key.includes(`::${context.group.chatId}::`)) {
          pendingSelectionsByContext.delete(key);
          pendingTaskSelectionsByContext.delete(key);
          pendingWorkspaceSelectionsByContext.delete(key);
        }
      }
    } else clearPrivatePendingSelectionsForBot(context.botId);
    await writeContext(draftContext);
    stopGroupSynchronization(context);
    return draftContext;
  }

  async function handleWeixinFirstActivation(
    message: BotInboundMessage,
    command: BotCommand,
  ): Promise<BotOutboundMessage[] | null> {
    if (message.actor.provider !== "weixin" || command.type !== "message") {
      return null;
    }
    const state = await repo.readState();
    const existing = state.bots[message.botId];
    if (
      existing?.weixinActivatedAt ||
      existing?.draftOptions ||
      existing?.activeTaskId ||
      existing?.pendingPermissionOptions ||
      existing?.pendingElicitation
    ) {
      return null;
    }
    const auth = await withAuthorizedContext(message, "help");
    if (!auth.ok) {
      return auth.reply;
    }
    if (auth.context.weixinActivatedAt) {
      return null;
    }
    // Bugfix: WeCom QR login returns only the bot token/id, never a deliverable user id.
    // The first WeCom inbound exists to pin the session target, so reply with activation copy instead of treating "hello" as a task prompt.
    await writeContext({
      ...auth.context,
      weixinActivatedAt: Date.now(),
    });
    return [
      createOutbound(
        message.actor,
        [msg(auth.locale, "weixinActivatedWelcome"), buildHelpText(auth.locale, auth.bot)].join(
          "\n\n",
        ),
      ),
    ];
  }

  const adminAttention = createGroupAdminAttention();

  function administratorReply(
    actor: BotActor,
    bot: Pick<BotConfig, "providerUserId">,
    reason: string,
    reply: BotOutboundMessage,
  ): BotOutboundMessage {
    if (actor.chatType !== "group") return reply;
    const mentionedUserIds = adminAttention.mention(actor, bot.providerUserId, reason);
    return { ...reply, mentionedUserIds, administratorAttention: !!mentionedUserIds?.length };
  }

  function administratorErrorReply(
    actor: BotActor,
    bot: BotConfig | null | undefined,
    error: unknown,
    reply: BotOutboundMessage,
  ): BotOutboundMessage {
    if (!bot || actor.chatType !== "group" || !(error instanceof BotAdminRequiredError))
      return reply;
    const hint =
      error.reason === "model"
        ? cachedLocale === "en-US"
          ? "Please check this conversation's model configuration."
          : "请机器人管理员检查当前会话的模型配置。"
        : undefined;
    return administratorReply(
      actor,
      bot,
      error.reason,
      hint ? { ...reply, text: `${reply.text}\n\n${hint}` } : reply,
    );
  }

  async function readMessageLocale(): Promise<Locale | undefined> {
    const settings = await deps.settingService?.get().catch(() => null);
    cachedLocale = settings?.locale ?? cachedLocale;
    return cachedLocale;
  }

  function msg(
    locale: Locale | undefined,
    id: BotMessageId,
    values?: Record<string, string | number | undefined>,
  ): string {
    return formatBotMessage(locale, id, values);
  }

  function isSessionExpiredError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /\bSession (not found|is not active):/i.test(message);
  }

  function formatUserFacingBotError(error: unknown, locale: Locale | undefined): string {
    // Bugfix: stale bot messages or a dirty task index make the protocol layer throw Session not found.
    // A raw session id is not actionable for users; keep it in logs and just point them at a new task.
    if (isSessionExpiredError(error)) {
      return msg(locale, "sessionExpiredNewTaskHint");
    }
    return error instanceof Error ? error.message : String(error);
  }

  function sanitizeAttachmentFilename(filename: string): string {
    const normalized = Array.from(filename.trim())
      .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? "_" : char))
      .join("");
    return normalized.length > 0 ? normalized.slice(0, 160) : "attachment";
  }

  function formatAttachmentSize(sizeBytes: number | undefined): string {
    if (!sizeBytes || sizeBytes <= 0) {
      return "unknown size";
    }
    if (sizeBytes >= 1024 * 1024) {
      return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
    }
    if (sizeBytes >= 1024) {
      return `${Math.ceil(sizeBytes / 1024)}KB`;
    }
    return `${sizeBytes}B`;
  }

  function formatAttachmentRejectedReason(error: unknown, locale: Locale | undefined): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/exceeds 5MB/i.test(message)) {
      return msg(locale, "attachmentTooLarge");
    }
    if (
      /attachment download failed/i.test(message) ||
      /file download failed/i.test(message) ||
      /download .+ failed: HTTP/i.test(message) ||
      /file download timed out/i.test(message) ||
      /attachment download timed out/i.test(message) ||
      /download .+ timed out/i.test(message)
    ) {
      // Bugfix: provider download errors carry Feishu/Telegram/HTTP internals; echoing them raw is unfriendly and unactionable.
      return msg(locale, "attachmentDownloadUnavailable");
    }
    return message;
  }

  function buildAttachmentCachePath(params: {
    botId: string;
    providerMessageId?: string;
    attachment: BotInboundAttachment;
  }): string {
    const messageKey = params.providerMessageId?.trim() || `message-${Date.now()}`;
    const digest = createHash("sha256")
      .update(`${params.botId}:${messageKey}:${params.attachment.id}`)
      .digest("hex")
      .slice(0, 16);
    return join(
      getAppConfigDir(),
      "bot-attachments",
      sanitizeAttachmentFilename(params.botId),
      sanitizeAttachmentFilename(messageKey),
      `${digest}-${sanitizeAttachmentFilename(params.attachment.filename)}`,
    );
  }

  async function fetchAttachmentDownloadUrl(
    attachment: BotInboundAttachment,
  ): Promise<Uint8Array | null> {
    if (!attachment.downloadUrl) {
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BOT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(attachment.downloadUrl, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`download ${attachment.filename} failed: HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if ((error as { name?: unknown })?.name === "AbortError") {
        // Bugfix: a stuck attachment download must fail fast and reply; never leave the bot callback hanging.
        throw new Error(`download ${attachment.filename} timed out.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolveAttachmentBytes(
    bot: BotConfig,
    attachment: BotInboundAttachment,
    actor: BotActor,
  ): Promise<{ attachment: BotInboundAttachment; data: Uint8Array } | null> {
    if (attachment.dataBase64) {
      return {
        attachment,
        data: Buffer.from(attachment.dataBase64, "base64"),
      };
    }
    if (attachment.localPath) {
      return {
        attachment,
        data: await readFile(attachment.localPath),
      };
    }
    const provider = providers[bot.provider];
    const downloaded = await provider?.downloadAttachment?.(bot, attachment, actor);
    if (downloaded) {
      return downloaded;
    }
    const fromUrl = await fetchAttachmentDownloadUrl(attachment);
    return fromUrl ? { attachment, data: fromUrl } : null;
  }

  async function cacheResolvedAttachment(params: {
    bot: BotConfig;
    message: BotInboundMessage;
    attachment: BotInboundAttachment;
    data: Uint8Array;
  }): Promise<BotInboundAttachment> {
    const localPath = buildAttachmentCachePath({
      botId: params.bot.id,
      providerMessageId: params.message.actor.providerMessageId,
      attachment: params.attachment,
    });
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, params.data);
    return {
      ...params.attachment,
      localPath,
      sizeBytes: params.data.byteLength,
    };
  }

  async function prepareBotMessageContent(
    bot: BotConfig,
    message: BotInboundMessage,
    locale: Locale | undefined,
  ): Promise<PreparedBotMessageContent> {
    const isGroup = message.actor.chatType === "group";
    if (isGroup && (message.attachments?.length ?? 0) > BOT_MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(
        locale === "en-US"
          ? "Attach at most 4 files per message."
          : "每条消息最多提交 4 个附件，请拆分后发送。",
      );
    }
    const rawAttachments = (message.attachments ?? []).slice(0, BOT_MAX_ATTACHMENTS_PER_MESSAGE);
    const zcodeAttachments: ZCodePromptAttachment[] = [];
    const fileLines: string[] = [];
    for (const rawAttachment of rawAttachments) {
      const resolved = await resolveAttachmentBytes(bot, rawAttachment, message.actor);
      if (!resolved) {
        if (isGroup) throw new Error("attachment download failed");
        fileLines.push(
          `Attachment: ${rawAttachment.filename} (${rawAttachment.mimeType}, ${formatAttachmentSize(rawAttachment.sizeBytes)}) could not be downloaded.`,
        );
        continue;
      }
      if (resolved.data.byteLength > BOT_MAX_ATTACHMENT_SIZE_BYTES) {
        throw new Error(`${resolved.attachment.filename} exceeds 5MB.`);
      }
      const cached = await cacheResolvedAttachment({
        bot,
        message,
        attachment: resolved.attachment,
        data: resolved.data,
      });
      const dataBase64 = Buffer.from(resolved.data).toString("base64");
      if (isGroup) {
        // The legacy path glued file paths into text, losing V4 attachments and breaking the trailing quote block; group input uses standard registration only.
        zcodeAttachments.push({
          kind: cached.kind === "image" || cached.kind === "audio" ? cached.kind : "file",
          filename: cached.filename,
          mimeType: cached.mimeType,
          sizeBytes: resolved.data.byteLength,
          dataBase64,
          localPath: cached.localPath,
        });
        continue;
      }
      if (cached.kind === "image" || cached.kind === "audio") {
        zcodeAttachments.push({
          kind: cached.kind,
          filename: cached.filename,
          mimeType: cached.mimeType,
          dataBase64,
          // Bugfix: the bot already cached the attachment locally; ZCodePromptAttachment must carry that path too.
          // describing the path only in prompt text leaves downstream attachment policy unable to pick the local file.
          localPath: cached.localPath,
        });
        // Bugfix: bot attachments are already downloaded and cached locally by the gateway. Passing images only as ZCode Agent image blocks,
        // downstream agents may re-curl the internal temp URL into /tmp, causing duplicate downloads, extra prompts, and security blocks.
        // so the local cache path is also written into the prompt, pinning later tool operations to local files.
        fileLines.push(
          `Attachment: ${cached.filename} (${cached.mimeType}, ${formatAttachmentSize(cached.sizeBytes)}), provided as ${cached.kind === "image" ? "an image" : "audio"} input and saved to: ${cached.localPath}. To read it, use this local path directly instead of downloading or hitting temporary/remote URLs.`,
        );
        continue;
      }
      fileLines.push(
        `Attachment: ${cached.filename} (${cached.mimeType}, ${formatAttachmentSize(cached.sizeBytes)}), saved to: ${cached.localPath}`,
      );
    }
    const trimmed = message.text.trim();
    const baseContent =
      trimmed || (rawAttachments.length > 0 ? msg(locale, "attachmentOnlyPrompt") : "");
    return {
      content: [baseContent, ...fileLines].filter(Boolean).join("\n\n"),
      zcodeAttachments,
    };
  }

  function requiresRemoteWorkspaceRuntime(requestedCommand: BotAuthorizedCommand): boolean {
    return (
      requestedCommand !== "help" &&
      requestedCommand !== "status" &&
      requestedCommand !== "workspace" &&
      requestedCommand !== "reconnect" &&
      requestedCommand !== "reply"
    );
  }

  async function isRemoteWorkspaceConnected(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
  ): Promise<boolean> {
    if (!context.workspaceIdentity) {
      return true;
    }
    if (!deps.remoteWorkspaceService) {
      // Bugfix: a remote workspace without an injected reconnect service must not default to connected.
      // or the bot keeps creating tasks with the cached model and the remote API finally surfaces misleading "model not found" errors.
      return false;
    }
    return deps.remoteWorkspaceService
      .isConnected({
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      })
      .catch(() => false);
  }

  async function reconnectRemoteWorkspaceForBot(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
  ): Promise<BotRemoteWorkspaceReconnectResult> {
    if (!context.workspaceIdentity) {
      return { ok: true };
    }
    if (!deps.remoteWorkspaceService) {
      return {
        ok: false,
        message: "remote reconnect service unavailable",
      };
    }
    return deps.remoteWorkspaceService.ensureConnected({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
  }

  async function resolveZCodeTaskServiceForContext(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
  ): Promise<IZCodeTaskService> {
    if (!context.workspaceIdentity) {
      return deps.zcodeTaskService;
    }
    const remoteZCodeTaskService = await deps.remoteWorkspaceService?.getZCodeTaskService?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    if (remoteZCodeTaskService) {
      return remoteZCodeTaskService;
    }
    // Bugfix: bot requests on a remote workspace must not silently fall back to the local zcodeTaskService when the runtime is missing.
    // or remote paths like /root create tasks on the local macOS/Windows host with the wrong models and filesystem.
    throw new BotAdminRequiredError(
      "remote",
      `Remote project ${context.workspacePath} runtime is unavailable. Send **/reconnect** and retry.`,
    );
  }

  async function resolveModelSelectionServiceForContext(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
  ): Promise<Pick<IModelSelectionService, "getView">> {
    if (!context.workspaceIdentity) return deps.modelSelectionService;
    const service = await deps.remoteWorkspaceService?.getModelSelectionService?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    if (service) return service;
    throw new BotAdminRequiredError(
      "remote",
      `Remote project ${context.workspacePath} runtime is unavailable. Send **/reconnect** and retry.`,
    );
  }

  async function blockDisconnectedRemoteWorkspace(params: {
    message: BotInboundMessage;
    context: BotContextState;
    locale: Locale | undefined;
    requestedCommand: BotAuthorizedCommand;
  }): Promise<BotOutboundMessage[] | null> {
    if (
      !params.context.workspaceIdentity ||
      !requiresRemoteWorkspaceRuntime(params.requestedCommand)
    ) {
      return null;
    }
    if (await isRemoteWorkspaceConnected(params.context)) {
      adminAttention.clear(params.message.actor, params.context.group?.ownerId, "remote");
      return null;
    }
    // Bugfix: plain messages, config edits, and permission replies must not implicitly mutate remote connection state.
    // Remote recovery triggers only on explicit /reconnect, or the same message sometimes runs and sometimes merely dials.
    return [
      administratorReply(
        params.message.actor,
        { providerUserId: params.context.group?.ownerId },
        "remote",
        createOutbound(
          params.message.actor,
          msg(params.locale, "remoteDisconnected", {
            workspacePath: params.context.workspacePath,
          }),
        ),
      ),
    ];
  }

  function currentOptionSuffix(locale: Locale | undefined): string {
    return locale === "en-US" ? "current" : "当前";
  }

  function formatReplyGranularityLabel(
    id: BotReplyGranularity | undefined,
    locale: Locale | undefined,
    provider?: BotProvider,
  ): string {
    const currentId = provider
      ? normalizeBotReplyGranularity(provider, id)
      : (id ?? getDefaultBotReplyGranularity());
    return (
      getReplyGranularityOptions(locale, provider).find((option) => option.id === currentId)
        ?.label ?? currentId
    );
  }

  function clearCandidateCaches(): void {
    cachedWorkspaceRefsByKey.clear();
  }

  function markCurrentSelection(
    selection: SelectionPrompt,
    locale: Locale | undefined,
  ): SelectionPrompt {
    const cancelLabel = msg(locale, "selectionCancelOption");
    if (!selection.currentId) {
      return { ...selection, cancelLabel };
    }
    const suffix = currentOptionSuffix(locale);
    return {
      ...selection,
      cancelLabel,
      options: selection.options.map((option) =>
        option.id === selection.currentId
          ? { ...option, label: `${option.label} · ${suffix}` }
          : option,
      ),
    };
  }

  async function listUserConfigOptions(
    _params: BotUserConfigOptionsParams,
  ): Promise<ZCodeConfigOption[]> {
    return [];
  }
  async function ensureBotStorageMigrated(): Promise<void> {
    // One-way imports are the Repo's job; wait for initialization only, reading no legacy model fields nor rewriting state.
    if (!botStorageMigrationPromise) {
      botStorageMigrationPromise = Promise.all([repo.readConfig(), repo.readState()])
        .then(() => undefined)
        .catch((error: unknown) => {
          botStorageMigrationPromise = null;
          throw error;
        });
    }
    await botStorageMigrationPromise;
  }

  async function listActiveTaskConfigOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    taskId: string,
  ): Promise<ZCodeConfigOption[]> {
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    return zcodeTaskService.getTaskConfigOptions({ taskId });
  }

  function findSelectConfigOption(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
  ): (ZCodeConfigOption & { type: "select" }) | undefined {
    const category = configId === "thoughtLevel" ? "thought_level" : configId;
    return options.find(
      (item): item is ZCodeConfigOption & { type: "select" } =>
        item.type === "select" && (item.category === category || item.id === category),
    );
  }

  function listConfigSelectOptions(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): BotModelOption[] {
    const option = findSelectConfigOption(options, configId);
    return (option?.options ?? []).map((item) => {
      const baseOption = {
        id: item.value,
        label: item.name,
        description: item.description,
      };
      return {
        ...baseOption,
        // keeping the bot's mode display aligned with the toolbar.
        label: formatConfigOptionLabel(baseOption, {
          configId,
          locale: context.locale,
          provider: context.provider,
        }),
      };
    });
  }

  function getConfigCommandMissingMessageId(configId: "mode" | "thoughtLevel"): BotMessageId {
    return configId === "mode" ? "modeMissing" : "thoughtLevelMissing";
  }

  function getModeDisplayLabel(
    locale: Locale | undefined,
    provider: ZCodeProvider | undefined,
    option: Pick<BotModelOption, "id" | "label">,
  ): string {
    if (!provider) {
      return option.label;
    }
    const isEnglish = locale === "en-US";
    const labels: Partial<Record<ZCodeProvider, Record<string, string>>> = {
      glm: {
        default: isEnglish ? "Default" : "默认",
        yolo: "Yolo",
        plan: isEnglish ? "Plan" : "计划",
      },
    };
    return labels[provider]?.[option.id] ?? option.label;
  }

  function formatConfigOptionLabel(
    option: BotModelOption,
    context: {
      configId: "model" | "mode" | "thoughtLevel";
      locale?: Locale;
      provider?: ZCodeProvider;
    },
  ): string {
    if (context.configId !== "mode") {
      return option.label;
    }
    return getModeDisplayLabel(context.locale, context.provider, option);
  }

  function createModelSelectionProviderOption(
    provider: ModelSelectionView["providers"][number],
  ): BotModelProviderOption {
    return {
      id: provider.providerId,
      label: provider.providerName?.trim() || provider.providerId,
      models: provider.models.map((model) => ({
        id: encodeCustomModelValue(provider.providerId, model.modelId),
        label: model.modelId,
      })),
    };
  }

  async function readModelSelectionView(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    selection?: ModelSelection,
  ): Promise<ModelSelectionView | null> {
    const service = await resolveModelSelectionServiceForContext(context).catch(() => null);
    if (!service) return null;
    return service.getView
      .call(service, selection ? { selection } : undefined)
      .catch((error: unknown) => {
        botsLogger.warn(
          undefined,
          `read model selection view for bot model display failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
  }

  async function listModelSelectionProviderOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
  ): Promise<BotModelProviderOption[]> {
    const view = await readModelSelectionView(context);
    // The legacy cache lacked workspaceIdentity isolation and showed another host's candidates after disconnects.
    // The menu consumes the target view only; on failure stay empty until the next normal read, no local patching.
    if (!view) return [];
    return view.providers
      .map(createModelSelectionProviderOption)
      .filter((provider) => provider.models.length > 0);
  }

  async function listModelProviderOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    _activeProvider: ZCodeProvider,
  ): Promise<BotModelProviderOption[]> {
    return listModelSelectionProviderOptions(task);
  }

  async function listModelOptionsForProviderFromActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
    providerId: string,
  ): Promise<BotModelOption[]> {
    return (
      (await listModelProviderOptionsForActiveTask(task, activeProvider)).find(
        (provider) => provider.id === providerId,
      )?.models ?? []
    );
  }

  function readModelProviderSelectionModels(provider: unknown): BotModelOption[] {
    const models = isRecord(provider) ? provider.models : undefined;
    if (!Array.isArray(models)) {
      return [];
    }
    return models.filter(
      (model): model is BotModelOption =>
        isRecord(model) && typeof model.id === "string" && typeof model.label === "string",
    );
  }

  async function listAllModelOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
  ): Promise<BotModelOption[]> {
    return (await listModelProviderOptionsForActiveTask(task, activeProvider)).flatMap(
      (provider) => provider.models,
    );
  }

  function readCurrentActiveTaskModel(
    task: Pick<ZCodeTaskMeta, "model">,
    options: readonly ZCodeConfigOption[],
  ): string | undefined {
    return readConfigSelectCurrentValue(options, "model") ?? task.model;
  }

  async function formatStatusModelLabel(
    model: string | undefined,
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
  ): Promise<string> {
    if (!model) {
      return "-";
    }
    const customModel = decodeCustomModelValue(model);
    if (customModel?.providerId) {
      const modelSelectionOptions = await listModelSelectionProviderOptions(context);
      const providerLabel = modelSelectionOptions.find(
        (item) => item.id === customModel.providerId,
      )?.label;
      if (providerLabel && customModel.modelName) {
        return `${providerLabel}/${customModel.modelName}`;
      }
      return providerLabel ?? model;
    }
    const separatorIndex = model.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
      return model;
    }
    const providerId = model.slice(0, separatorIndex);
    const modelName = model.slice(separatorIndex + 1);
    const modelSelectionOptions = await listModelSelectionProviderOptions(context);
    const providerLabel = modelSelectionOptions.find((item) => item.id === providerId)?.label;
    // Bugfix: /status should only expose provider names users can recognize.
    // Legacy bot-state/task configs may store providerId/modelId, and providerId means nothing to users.
    return providerLabel ? `${providerLabel}/${modelName}` : model;
  }

  async function readCurrentModelProviderId(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    options: readonly ZCodeConfigOption[],
    activeProvider: ZCodeProvider,
  ): Promise<string | undefined> {
    const currentValue = readCurrentActiveTaskModel(task, options);
    if (!currentValue) {
      return undefined;
    }
    const customModel = decodeCustomModelValue(currentValue);
    if (customModel?.providerId) {
      return customModel.providerId;
    }
    return (
      (await listModelProviderOptionsForActiveTask(task, activeProvider)).find((provider) =>
        provider.models.some((model) => model.id === currentValue),
      )?.id ?? getNativeModelProviderId(activeProvider)
    );
  }

  function resolveCustomModelRuntimeModelId(
    _activeProvider: ZCodeProvider,
    customModel: { providerId: string; modelName?: string },
  ): string | undefined {
    if (!customModel.modelName) {
      return undefined;
    }
    return customModel.modelName;
  }

  function readConfigSelectCurrentValue(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
  ): string | undefined {
    const currentValue = findSelectConfigOption(options, configId)?.currentValue;
    return typeof currentValue === "string" ? currentValue : undefined;
  }

  function resolveSupportedDraftMode(
    options: readonly ZCodeConfigOption[],
    mode: string | undefined,
    provider: ZCodeProvider,
  ): string | undefined {
    if (!mode) {
      return undefined;
    }
    return resolveProviderModeIdFromConfigOptions({
      configOptions: options,
      modeId: mode,
      provider,
    })
      ? mode
      : undefined;
  }

  function readConfigSelectCurrentLabel(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): string | undefined {
    const currentValue = readConfigSelectCurrentValue(options, configId);
    if (!currentValue) {
      return undefined;
    }
    return (
      listConfigSelectOptions(options, configId, context).find(
        (option) => option.id === currentValue,
      )?.label ?? currentValue
    );
  }

  function readConfigSelectLabelForValue(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    value: string | undefined,
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): string | undefined {
    if (!value) {
      return undefined;
    }
    return (
      listConfigSelectOptions(options, configId, context).find((option) => option.id === value)
        ?.label ?? value
    );
  }

  function readCurrentActiveTaskMode(
    task: Pick<ZCodeTaskMeta, "mode">,
    options: readonly ZCodeConfigOption[],
  ): string | undefined {
    return readConfigSelectCurrentValue(options, "mode") ?? task.mode;
  }

  async function listProviderConfigOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
  ): Promise<ZCodeConfigOption[]> {
    return listUserConfigOptions({
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
      provider: activeProvider,
    });
  }

  function normalizeBotDraftOptions(draftOptions: BotDraftOptions): BotDraftOptions {
    // Bugfix: bot-state can still hold a stale third-party CLI draft provider.
    // Reusing it directly makes the first post-/new message respawn the third-party runtime, bypassing the ZCode Agent source of truth.
    return {
      ...draftOptions,
      provider: normalizeAgentProviderToZCodeAgent(draftOptions.provider),
    };
  }

  async function buildInitializedDraftOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    provider?: ZCodeProvider,
  ): Promise<BotDraftOptions> {
    const requestedProvider = normalizeAgentProviderToZCodeAgent(
      provider ?? DEFAULT_BOT_ZCODE_PROVIDER,
    );
    if (context.workspaceIdentity && !(await isRemoteWorkspaceConnected(context))) {
      // Bugfix: even draft initialization while disconnected must not silently request a remote runtime.
      // Only /reconnect restores the connection; drafts keep minimal defaults and refresh after a successful reconnect.
      return { provider: requestedProvider };
    }
    const resolvedProvider = requestedProvider;
    return {
      provider: resolvedProvider,
      mode: "group" in context && context.group ? "default" : BOT_FORCED_MODE,
    };
  }

  async function buildActiveTaskDraftOptions(context: BotContextState): Promise<BotDraftOptions> {
    const activeTask = await readContextActiveTaskMeta(context);
    if (!context.activeTaskId || !activeTask?.provider) {
      return context.draftOptions
        ? normalizeBotDraftOptions(context.draftOptions)
        : buildInitializedDraftOptions(context);
    }
    const configOptions = await listActiveTaskConfigOptions(context, context.activeTaskId).catch(
      () => [],
    );
    const resolvedProvider = normalizeAgentProviderToZCodeAgent(activeTask.provider);
    // Hard-locked to yolo: inheriting the current task still forces yolo instead of the old task's mode.
    const forcedMode = resolveSupportedDraftMode(
      configOptions,
      "group" in context && context.group ? "default" : BOT_FORCED_MODE,
      resolvedProvider,
    );
    // Inherit the domain selection, not the menu label; $max in a label was once stored as modelId.
    // The same workspace's task service reads the real choice, preserving provider, model, and explicit thinking level.
    const taskService = await resolveZCodeTaskServiceForContext(context);
    const modelSelection = await taskService.getTaskModelSelection({
      taskId: context.activeTaskId,
    });
    return {
      provider: resolvedProvider,
      ...(modelSelection ? { modelSelection } : {}),
      ...(forcedMode ? { mode: forcedMode } : {}),
    };
  }

  async function ensureDraftOptions(context: BotContextState): Promise<BotDraftOptions> {
    if (context.draftOptions) {
      const normalizedDraftOptions = normalizeBotDraftOptions(context.draftOptions);
      if (normalizedDraftOptions.provider !== context.draftOptions.provider) {
        await writeContext({ ...context, draftOptions: normalizedDraftOptions });
      }
      return normalizedDraftOptions;
    }
    const draftOptions = await buildInitializedDraftOptions(context);
    await writeContext({ ...context, draftOptions });
    return draftOptions;
  }

  async function writeDraftOptions(
    context: BotContextState,
    draftOptions: BotDraftOptions,
  ): Promise<BotContextState> {
    const normalizedDraftOptions = normalizeBotDraftOptions(draftOptions);
    const nextContext: BotContextState = {
      ...context,
      mode: "draft",
      activeTaskId: null,
      draftOptions: normalizedDraftOptions,
    };
    await writeContext(nextContext);
    return nextContext;
  }

  async function resolveDraftOptionsForDisplay(context: BotContextState): Promise<BotDraftOptions> {
    const original = await ensureDraftOptions(context);
    const view = await readModelSelectionView(context, original.modelSelection);
    // The menu must also show the identity dispatch would use. Return a copy only; viewing never writes the draft back.
    return {
      ...original,
      modelSelection:
        (original.modelSelection ? view?.effectiveSelection : view?.preferredSelection) ??
        undefined,
    };
  }

  async function listDraftConfigOptions(
    context: BotContextState,
    draftOptions: BotDraftOptions,
    resolvedView?: ModelSelectionView | null,
  ): Promise<ZCodeConfigOption[]> {
    const view =
      resolvedView === undefined
        ? await readModelSelectionView(context, draftOptions.modelSelection)
        : resolvedView;
    const selection = draftOptions.modelSelection
      ? view?.effectiveSelection
      : view?.preferredSelection;
    if (!selection) return [];
    const model = view?.providers
      .find((provider) => provider.providerId === selection.providerId)
      ?.models.find((candidate) => candidate.modelId === selection.modelId);
    const spec = model?.config.optionSpecs.reasoningLevel;
    if (!spec) return [];
    return [
      {
        id: "thought_level",
        name: "Reasoning",
        category: "thought_level",
        type: "select",
        currentValue: selection.options?.reasoningLevel ?? "",
        options: spec.values.map((value) => ({ value, name: value })),
      },
    ];
  }

  async function applyDraftConfigOptions(
    context: BotContextState,
    taskId: string,
    traceId: string,
  ): Promise<void> {
    const draftOptions = context.draftOptions;
    if (!draftOptions) {
      return;
    }
    // Bugfix: workspace configOptions describe the pre-switch model and must not validate the new task's config.
    // e.g. GLM's enabled leaking onto the newly-switched provider's model and failing the first WeCom callback.
    const configOptions = await listActiveTaskConfigOptions(context, taskId);
    const modeOption = configOptions.find(
      (option) => option.category === "mode" && option.type === "select",
    );
    // Hard-locked to yolo: whatever the draft/inherited mode, task creation always sends yolo.
    // This is the only gate where mode enters the agent session, guaranteeing interaction-free bot tasks.
    const forcedDraftMode = resolveSupportedDraftMode(
      configOptions,
      context.group ? (draftOptions.mode ?? "default") : BOT_FORCED_MODE,
      draftOptions.provider,
    );
    if ((modeOption?.id && forcedDraftMode) || context.group) {
      const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
      await zcodeTaskService.setMode({
        taskId,
        mode: (forcedDraftMode ?? "default") as ZCodeTaskMode,
      });
    } else if (modeOption?.id) {
      // Non-ZCode-Agent providers without yolo keep their own default mode so the first message's callback cannot fail.
      botsLogger.debug(
        traceId,
        `skip forced yolo mode unsupported provider=${draftOptions.provider}`,
      );
    }
  }

  function getActorContextKey(actor: BotActor): string {
    return [
      actor.botId,
      actor.provider,
      actor.chatId?.trim() || actor.providerUserId,
      ...(actor.threadId ? [actor.threadId] : []),
      ...(actor.chatType === "group" ? [actor.providerUserId] : []),
    ].join("::");
  }

  function clearPrivatePendingSelectionsForBot(botId: string): void {
    // DM creation must not wipe group members' menus; the group key adds a sender segment.
    const matchesBot = (contextKey: string): boolean =>
      contextKey === botId ||
      (contextKey.startsWith(`${botId}::`) &&
        contextKey.slice(botId.length + 2).split("::").length === 2);
    for (const contextKey of pendingSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        pendingSelectionsByContext.delete(contextKey);
      }
    }
    for (const contextKey of pendingTaskSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        pendingTaskSelectionsByContext.delete(contextKey);
      }
    }
    for (const contextKey of pendingWorkspaceSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        pendingWorkspaceSelectionsByContext.delete(contextKey);
      }
    }
  }

  function resolvePendingSelectionOption(
    actor: BotActor,
    action: SelectionPrompt["action"],
    value: string,
  ): SelectionPrompt["options"][number] | null {
    const actorContextKey = getActorContextKey(actor);
    const selection = pendingSelectionsByContext.get(actorContextKey);
    if (selection?.action !== action) {
      return null;
    }
    const option = resolveOptionByValue(selection.options, value);
    if (option) {
      pendingSelectionsByContext.delete(actorContextKey);
    }
    return option;
  }

  function clearPendingSelection(actor: BotActor): void {
    const actorContextKey = getActorContextKey(actor);
    pendingSelectionsByContext.delete(actorContextKey);
    pendingTaskSelectionsByContext.delete(actorContextKey);
    pendingWorkspaceSelectionsByContext.delete(actorContextKey);
  }

  function resolvePendingSelectionCommand(actor: BotActor, value: string): BotCommand | null {
    const actorContextKey = getActorContextKey(actor);
    const selection = pendingSelectionsByContext.get(actorContextKey);
    if (!selection) {
      return null;
    }
    if (actor.provider !== "weixin") {
      // Bugfix: only WeCom lacks structured options and must carry pending selections via "reply with a number".
      // Providers like Telegram/Feishu have button callbacks; plain text must not be parsed as a menu choice implicitly.
      clearPendingSelection(actor);
      return null;
    }
    if (!isSelectionIndexValue(value)) {
      // Bugfix: list commands like /task leave a pending selection behind.
      // The old flow matched options by label from plain text, switching tasks whenever a message equaled a task title.
      // Implicit selection accepts bare digits only; id/label picks go through explicit /task <value> style commands.
      clearPendingSelection(actor);
      return null;
    }
    const option = resolveOptionByValue(selection.options, value);
    if (!option) {
      clearPendingSelection(actor);
      return null;
    }
    pendingSelectionsByContext.delete(actorContextKey);
    switch (selection.action) {
      case "queue.cancel":
        return parseBotCommand(option.id);
      case "workspace.set":
        return { type: "workspace.set", value: option.id };
      case "model.provider.set":
        return { type: "model.provider.set", value: option.id };
      case "model.set":
        return { type: "model.set", value: option.id };
      case "mode.set":
        return { type: "mode.set", value: option.id };
      case "thoughtLevel.set":
        return { type: "thoughtLevel.set", value: option.id };
      case "task.set":
        return { type: "task.set", value: option.id };
      case "reply.set":
        return { type: "reply.set", value: option.id };
      case "permission.respond":
        return { type: "permission.respond", value };
      case "elicitation.respond":
        return { type: "elicitation.respond", value: option.id };
    }
  }

  function shouldUseTransientInteractionCard(bot: BotConfig, user: BotConfig): boolean {
    const adapter = providers[bot.provider];
    return (
      isFeishuBotProvider(bot.provider) &&
      normalizeBotReplyGranularity(bot.provider, user.replyMode) === "streaming_card" &&
      Boolean(adapter?.createTransientInteractionCard) &&
      Boolean(adapter?.updateTransientInteractionCard)
    );
  }

  async function upsertTransientInteractionCard(
    bot: BotConfig,
    actor: BotActor,
    taskId: string,
    message: BotOutboundMessage,
  ): Promise<void> {
    const adapter = providers[bot.provider];
    const key = getActorContextKey(actor);
    const existing = transientInteractionCards.get(key);
    if (existing) {
      // Fix: posting a new card then DELETEing the old one leaves a visible recall trail.
      // Even the fallback after a failed token update must PATCH the original message_id, keeping one stable card identity.
      await adapter?.updateTransientInteractionCard?.(existing.bot, existing.handle, message);
      return;
    }
    const handle = await adapter?.createTransientInteractionCard?.(bot, message);
    if (!handle) {
      return;
    }
    transientInteractionCards.set(key, { bot, taskId, handle });
  }

  async function finalizeTransientInteractionCard(
    actor: BotActor,
    fallback: BotOutboundMessage,
  ): Promise<boolean> {
    const key = getActorContextKey(actor);
    const existing = transientInteractionCards.get(key);
    if (!existing) {
      return false;
    }
    const adapter = providers[existing.bot.provider];
    try {
      // Fix: recalling cards after completion erases Q&A and plans from history, leaving users unable to review
      // decision context. Terminal states only strip controls, release the runtime handle, and let later interactions spawn new cards.
      await adapter?.updateTransientInteractionCard?.(existing.bot, existing.handle, fallback);
    } catch (error) {
      botsLogger.warn(
        undefined,
        `finalize interaction card failed bot=${existing.bot.id} task=${existing.taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      transientInteractionCards.delete(key);
    }
    return true;
  }

  const waitForGroupDeliverySlot = createGroupDeliveryThrottle();
  const groupDeliverySenders = new Map<string, ReturnType<typeof createGroupResultDelivery>>();
  function getGroupDeliverySender(bot: BotConfig, chatId: string, threadId?: string) {
    const key = getBotConversationKey({ botId: bot.id, chatType: "group", chatId, threadId });
    const existing = groupDeliverySenders.get(key);
    if (existing) return existing;
    const authorized = async (result: BotGroupDelivery): Promise<boolean> => {
      const state = (await repo.readState()).bots[key];
      const currentBot = findBot(await repo.readConfig(), bot.id);
      return Boolean(
        currentBot?.enabled &&
        (!result.appId || result.appId === currentBot.feishuAppId) &&
        (!result.contentParts ||
          !["cancelled", "discarded", "stopped"].includes(
            state?.group?.inputs?.[result.sourceCommandId ?? ""]?.progress?.status ?? "",
          )) &&
        state?.group?.enabled &&
        state.group.ownerId === currentBot.providerUserId &&
        state.activeTaskId === result.taskId &&
        state.group.deliveries?.[result.id]?.status !== "invalidated" &&
        (!result.authorizationId || result.authorizationId === state.group.authorizationId),
      );
    };
    const sender = createGroupResultDelivery({
      onSettled: async () => {
        await deps.broadcastService
          ?.send({ channel: "bots:group-state", payload: { botId: bot.id, chatId } })
          .catch(() => undefined);
      },
      read: async (id) => (await repo.readState()).bots[key]?.group?.deliveries?.[id],
      authorized,
      write: async (result) => {
        const operation = stateWriteTail
          .catch(() => undefined)
          .then(async () => {
            const state = await repo.readState();
            const context = state.bots[key];
            if (!context?.group) return;
            const invalidated =
              !context.group.enabled ||
              context.activeTaskId !== result.taskId ||
              (Boolean(result.authorizationId) &&
                context.group.authorizationId !== result.authorizationId) ||
              context.group.deliveries?.[result.id]?.status === "invalidated";
            state.bots[key] = {
              ...context,
              group: {
                ...context.group,
                deliveries: {
                  ...context.group.deliveries,
                  [result.id]: invalidated ? { ...result, status: "invalidated" } : result,
                },
              },
            };
            await repo.writeState(state);
          });
        stateWriteTail = operation;
        await operation;
        await deps.broadcastService
          ?.send({ channel: "bots:group-state", payload: { botId: bot.id, chatId } })
          .catch(() => undefined);
      },
      send: async (result) => {
        await waitForGroupDeliverySlot(`${bot.provider}:${chatId}`);
        if (!(await authorized(result)))
          throw Object.assign(new Error("Group delivery authorization changed"), {
            deliveryRejected: true,
          });
        const currentBot = findBot(await repo.readConfig(), bot.id);
        const adapter = currentBot && providers[currentBot.provider];
        if (!adapter || !currentBot)
          throw Object.assign(new Error("Bot provider unavailable"), { deliveryRejected: true });
        if (
          result.contentParts &&
          (currentBot.provider !== bot.provider || currentBot.feishuAppId !== result.appId)
        )
          throw Object.assign(new Error("Channel reply application changed"), {
            deliveryRejected: true,
          });
        return adapter.send(currentBot, {
          botId: bot.id,
          provider: bot.provider,
          providerUserId: chatId,
          text: result.text,
          deliveryId: result.id,
          replyToMessageId: result.replyToMessageId,
          mentionedUserIds: result.mentionedUserIds,
          contentParts: result.contentParts,
          trace: result.trace,
          threadId: result.threadId ?? threadId,
          rootMessageId:
            result.rootMessageId ?? (await repo.readState()).bots[key]?.group?.rootMessageId,
        });
      },
    });
    groupDeliverySenders.set(key, sender);
    return sender;
  }

  async function sendOutbound(
    bot: BotConfig,
    message: BotOutboundMessage,
    authorize?: () => Promise<boolean>,
  ): Promise<void> {
    const conversationThreadId =
      message.conversationThreadId !== undefined
        ? (message.conversationThreadId ?? undefined)
        : message.threadId;
    if (isFeishuBotProvider(bot.provider) && message.groupTaskId && message.deliveryId) {
      const parts = splitFeishuText(message.text);
      const group = (await repo.readState()).bots[
        getBotConversationKey({
          botId: bot.id,
          chatType: "group",
          chatId: message.providerUserId,
          threadId: message.threadId,
          conversationThreadId: message.conversationThreadId,
        })
      ]?.group;
      const authorizationId = message.groupCard?.authorizationId ?? group?.authorizationId;
      for (const [index, text] of parts.entries()) {
        const id = createHash("sha256").update(`${message.deliveryId}:${index}`).digest("hex");
        const result: BotGroupDelivery = {
          authorizationId,
          id,
          taskId: message.groupTaskId,
          sourceCommandId: message.groupSourceCommandId,
          text,
          replyToMessageId: message.replyToMessageId,
          mentionedUserIds: index === 0 ? message.mentionedUserIds : undefined,
          threadId: message.threadId,
          rootMessageId: message.rootMessageId,
          status: "pending",
          updatedAt: Date.now(),
        };
        await getGroupDeliverySender(bot, message.providerUserId, conversationThreadId)(result);
      }
      return;
    }
    if (isFeishuBotProvider(bot.provider) && message.providerUserId.startsWith("oc_")) {
      await waitForGroupDeliverySlot(`${bot.provider}:${message.providerUserId}`);
    }
    // Scheduled tasks pin the same group target; re-check enablement after the send budget clears.
    if (authorize && !(await authorize())) return;
    if (isFeishuBotProvider(bot.provider) && message.groupTaskId) {
      const groupState = (await repo.readState()).bots[
        getBotConversationKey({
          botId: bot.id,
          chatType: "group",
          chatId: message.providerUserId,
          threadId: message.threadId,
          conversationThreadId: message.conversationThreadId,
        })
      ];
      const currentBot = findBot(await repo.readConfig(), bot.id);
      if (
        !currentBot?.enabled ||
        !groupState?.group?.enabled ||
        groupState.group.ownerId !== currentBot.providerUserId ||
        groupState.activeTaskId !== message.groupTaskId
      )
        return;
    }
    const adapter = providers[bot.provider];
    if (!adapter) {
      return;
    }
    if (bot.provider === "weixin") {
      const token = await deps.credentialService.load(
        weixinContextKey(bot, message.providerUserId),
      );
      if (token) message = { ...message, providerContextToken: token };
    }
    let handle: Awaited<ReturnType<BotProviderAdapter["send"]>>;
    try {
      handle = await adapter.send(bot, message);
      onDeliveryResult(bot, undefined);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const locale = await readMessageLocale();
      onDeliveryResult(
        bot,
        bot.provider === "weixin"
          ? locale === "en-US"
            ? `${detail}. Send a message to the bot in Weixin, then retry.`
            : `${detail}。请在微信给机器人发一条消息后重试。`
          : detail,
      );
      throw error;
    }
    if (
      message.selection?.action === "queue.cancel" &&
      message.groupSourceCommandId &&
      message.groupCard?.taskId &&
      handle?.providerMessageId
    ) {
      await queueCards
        .attach(
          JSON.stringify([
            bot.id,
            message.groupCard.chatId,
            message.groupCard.taskId,
            message.groupCard.authorizationId,
            message.groupSourceCommandId,
            message.groupCard.conversationThreadId !== undefined
              ? message.groupCard.conversationThreadId
              : message.groupCard.threadId,
          ]),
          handle.providerMessageId,
        )
        .catch((error) => {
          botsLogger.warn(
            undefined,
            `queue card catch-up failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  }

  function buildInboundDeliveryKey(message: BotInboundMessage): string | null {
    const providerMessageId = message.actor.providerMessageId?.trim();
    if (!providerMessageId) {
      return null;
    }
    return [
      message.actor.botId,
      message.actor.provider,
      message.actor.chatId ?? message.actor.providerUserId,
      providerMessageId,
    ].join("::");
  }

  function releaseInboundDelivery(message: BotInboundMessage): void {
    const deliveryKey = buildInboundDeliveryKey(message);
    if (deliveryKey) {
      recentInboundDeliveryAtByKey.delete(deliveryKey);
    }
  }

  async function enqueueInboundProcessing<T>(
    actor: BotActor,
    task: () => Promise<T>,
    control = false,
  ): Promise<T> {
    // Control requests serialize on their own lane and must not queue behind inputs waiting on attachments or admission.
    const actorContextKey = `${getBotConversationKey(actor)}${control ? ":control" : ""}`;
    const previous = inboundProcessingQueuesByContext.get(actorContextKey) ?? Promise.resolve();
    let releaseQueue = (): void => undefined;
    const current = previous
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            releaseQueue = resolve;
          }),
      );
    inboundProcessingQueuesByContext.set(actorContextKey, current);
    await previous.catch(() => undefined);
    try {
      // Bugfix: the same user may tap AskUserQuestion buttons repeatedly or fire off several quick replies.
      // Serialize inbound handling per actor or two concurrent requests read one pendingElicitation and respond twice.
      return await task();
    } finally {
      releaseQueue();
      if (inboundProcessingQueuesByContext.get(actorContextKey) === current) {
        inboundProcessingQueuesByContext.delete(actorContextKey);
      }
    }
  }

  function pruneRecentInboundDeliveryDedupe(now: number): void {
    for (const [key, at] of recentInboundDeliveryAtByKey) {
      if (now - at >= BOT_INBOUND_DELIVERY_DEDUPE_TTL_MS) {
        recentInboundDeliveryAtByKey.delete(key);
      }
    }
  }

  function markInboundDelivery(message: BotInboundMessage): boolean {
    const now = Date.now();
    pruneRecentInboundDeliveryDedupe(now);
    const deliveryKey = buildInboundDeliveryKey(message);
    if (!deliveryKey) {
      return true;
    }
    if (recentInboundDeliveryAtByKey.has(deliveryKey)) {
      return false;
    }
    // Bugfix: Feishu may redeliver im.message.receive_v1, and WeCom/Telegram can replay the same message id after retries.
    // Plain messages create/send tasks, so dedupe by provider message id before business handling or one hello runs twice.
    recentInboundDeliveryAtByKey.set(deliveryKey, now);
    return true;
  }

  async function sendTyping(bot: BotConfig, actor: BotActor): Promise<void> {
    const adapter = providers[bot.provider];
    const targetId = actor.chatId ?? actor.providerUserId;
    if (!adapter?.sendTyping || !targetId) {
      return;
    }
    await adapter
      .sendTyping(bot, {
        providerUserId: targetId,
        providerMessageId: actor.providerMessageId,
        providerContextToken: actor.providerContextToken,
      })
      .catch(() => undefined);
  }

  async function stopInboundTyping(bot: BotConfig, actor: BotActor): Promise<void> {
    const adapter = providers[bot.provider];
    const targetId = actor.chatId ?? actor.providerUserId;
    if (!adapter?.stopTyping || !targetId || !actor.providerMessageId) {
      return;
    }
    const isLongRunningTyping = Array.from(typingTargets.values()).some(
      (typing) =>
        typing.bot.id === bot.id && typing.target.providerMessageId === actor.providerMessageId,
    );
    if (isLongRunningTyping) {
      return;
    }
    // Bugfix: Feishu sendTyping only adds a Typing reaction to the inbound message.
    // Once the short-command reply lands, delete by the same messageId explicitly; no timers or next-command cleanup.
    await adapter
      .stopTyping(bot, {
        providerUserId: targetId,
        providerMessageId: actor.providerMessageId,
        providerContextToken: actor.providerContextToken,
      })
      .catch(() => undefined);
  }

  function startTyping(bot: BotConfig, actor: BotActor, taskId: string): void {
    const adapter = providers[bot.provider];
    const targetId = actor.chatId ?? actor.providerUserId;
    if (!adapter || !targetId || typingTargets.has(taskId) || typingIntervals.has(taskId)) {
      return;
    }
    const target: BotTypingTarget = {
      providerUserId: targetId,
      providerMessageId: actor.providerMessageId,
      providerContextToken: actor.providerContextToken,
    };
    if (adapter.startTyping) {
      typingTargets.set(taskId, { bot, target });
      void adapter.startTyping(bot, target).catch(() => undefined);
      return;
    }
    if (adapter.sendTyping) {
      void adapter.sendTyping(bot, target).catch(() => undefined);
      typingIntervals.set(
        taskId,
        setInterval(() => {
          void adapter.sendTyping?.(bot, target).catch(() => undefined);
        }, BOT_TYPING_INTERVAL_MS),
      );
    }
  }

  function stopTyping(taskId: string): void {
    const activeTyping = typingTargets.get(taskId);
    if (activeTyping) {
      typingTargets.delete(taskId);
      const adapter = providers[activeTyping.bot.provider];
      void adapter?.stopTyping?.(activeTyping.bot, activeTyping.target).catch(() => undefined);
    }
    const intervalId = typingIntervals.get(taskId);
    if (!intervalId) {
      return;
    }
    clearInterval(intervalId);
    typingIntervals.delete(taskId);
  }

  function updateLiveStatusProgress(event: ZCodeStreamEvent): void {
    if (event.type === "agent_message_chunk" || event.type === "agent_thought_chunk") {
      const text = normalizeStatusProgressText(event.content);
      if (!text) {
        return;
      }
      const kind = event.type === "agent_message_chunk" ? "message" : "thought";
      const previous = liveStatusProgressByTaskId.get(event.taskId);
      liveStatusProgressByTaskId.set(event.taskId, {
        kind,
        text: truncateLiveStatusProgressText(
          previous?.kind === kind ? `${previous.text}${text}` : text,
        ),
      });
      return;
    }
    if (event.type === "tool_call" || event.type === "tool_call_update") {
      const text = formatStatusStreamToolProgress(event);
      if (text) {
        liveStatusProgressByTaskId.set(event.taskId, { kind: "tool", text });
      }
    }
  }

  async function broadcastTaskListChange(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    taskId: string,
    event: BotTaskBroadcastPayload["event"],
    extras: Partial<
      Pick<
        BotTaskBroadcastPayload,
        | "task"
        | "provider"
        | "configOptions"
        | "prompt"
        | "permissionRequest"
        | "elicitationRequest"
        | "requestId"
        | "error"
      >
    > = {},
  ): Promise<void> {
    await deps.broadcastService
      ?.send({
        channel: BOT_TASK_BROADCAST_CHANNEL,
        payload: {
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          taskId,
          event,
          updatedAt: Date.now(),
          ...extras,
        },
      })
      .catch(() => undefined);
  }

  async function broadcastTaskStreamEvent(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    event: ZCodeStreamEvent,
  ): Promise<void> {
    const payload: BotTaskStreamBroadcastPayload = {
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      taskId: event.taskId,
      event,
      updatedAt: Date.now(),
    };
    await deps.broadcastService
      ?.send({
        channel: BOT_TASK_STREAM_BROADCAST_CHANNEL,
        payload,
      })
      .catch(() => undefined);
  }

  async function listWorkspaceRefs(
    params: BotListWorkspaceRefsParams = {},
  ): Promise<BotWorkspaceRef[]> {
    const cacheKey = params.currentWorkspace
      ? getWorkspaceKey(
          params.currentWorkspace.workspacePath,
          params.currentWorkspace.workspaceIdentity,
        )
      : "__default__";
    const nowMs = Date.now();
    const cached = cachedWorkspaceRefsByKey.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) {
      return cached.value;
    }
    const workspaceByKey = new Map<string, BotWorkspaceRef>();
    if (params.currentWorkspace) {
      workspaceByKey.set(
        getWorkspaceKey(
          params.currentWorkspace.workspacePath,
          params.currentWorkspace.workspaceIdentity,
        ),
        params.currentWorkspace,
      );
    }

    const settings = await deps.settingService?.get().catch(() => null);
    for (const entry of settings?.lastWorkspaceSession ?? []) {
      const workspace = createWorkspaceRef(
        entry.workspacePath,
        entry.kind === "remote" ? entry.workspaceIdentity : undefined,
      );
      workspaceByKey.set(
        getWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity),
        workspace,
      );
    }

    const value = [...workspaceByKey.values()];
    cachedWorkspaceRefsByKey.set(cacheKey, {
      expiresAt: nowMs + BOT_WORKSPACE_REFS_CACHE_TTL_MS,
      value,
    });
    return value;
  }

  function resolveCanonicalContextWorkspace(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "workspaceId">,
    workspaces: readonly BotWorkspaceRef[],
  ): BotWorkspaceRef | null {
    const currentWorkspaceKey = getWorkspaceKey(context.workspacePath, context.workspaceIdentity);
    const exactWorkspace = workspaces.find(
      (workspace) =>
        getWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity) ===
        currentWorkspaceKey,
    );
    if (exactWorkspace) {
      return exactWorkspace;
    }
    if (context.workspaceId) {
      const workspaceById = workspaces.find((workspace) => workspace.id === context.workspaceId);
      if (workspaceById) {
        return workspaceById;
      }
    }
    // Bugfix: legacy path-only state can backfill remote identity only from path candidates.
    // Upgrade only when the same-path candidate is unique, or two remote workspaces could bind to one identity.
    // A remote context with workspaceIdentity must not be downgraded by a same-path local candidate, or /workspace loses the remote entry.
    if (context.workspaceIdentity) {
      return null;
    }
    const samePathWorkspaces = workspaces.filter(
      (workspace) => workspace.workspacePath === context.workspacePath,
    );
    return samePathWorkspaces.length === 1 ? samePathWorkspaces[0]! : null;
  }

  async function normalizeBotWorkspaceConfig(
    config: BotsConfigFile,
    bot: BotConfig,
    currentWorkspace?: BotWorkspaceRef,
  ): Promise<{
    config: BotsConfigFile;
    bot: BotConfig;
    user: BotConfig;
    workspaces: BotWorkspaceRef[];
  }> {
    const workspaces = await listWorkspaceRefs({ currentWorkspace });
    const nextAllowedWorkspaces = normalizeConfiguredAllowedWorkspaces(
      bot.allowedWorkspaces,
      workspaces,
    );
    const nextBot: BotConfig = {
      ...bot,
      // Bugfix: workspace candidates now come from settings.lastWorkspaceSession and are no longer written to bot-config.json.
      // Also upgrade legacy path-only workspace grants to workspaceIdentity keys, so after remote-context self-healing
      // while grants still used path semantics, misjudging the message flow as workspaceOutOfScope.
      allowedWorkspaces: nextAllowedWorkspaces,
    };
    const nextConfig: BotsConfigFile = {
      ...config,
      bots: config.bots.map((item) => (item.id === bot.id ? nextBot : item)),
    };
    const shouldWrite = nextBot.allowedWorkspaces.join("\n") !== bot.allowedWorkspaces.join("\n");
    if (shouldWrite) {
      await writeBotConfig(nextConfig);
    }
    return { config: nextConfig, bot: nextBot, user: nextBot, workspaces };
  }

  async function readTaskMeta(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    taskId: string,
  ): Promise<ZCodeTaskMeta | null> {
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    const tasks = await zcodeTaskService.listTasks({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    return tasks.find((task) => task.taskId === taskId) ?? null;
  }

  async function listContextTaskSelectionEntries(
    context: BotContextState,
    user: BotConfig,
  ): Promise<BotTaskSelectionEntry[]> {
    const currentWorkspace = createWorkspaceRef(context.workspacePath, context.workspaceIdentity);
    const currentWorkspaceKey = getWorkspaceKey(context.workspacePath, context.workspaceIdentity);
    const workspaceRefs = context.group
      ? [
          ...new Map(
            [
              currentWorkspace,
              ...Object.values(context.group.taskWorkspaces ?? {}).map((ref) =>
                createWorkspaceRef(ref.workspacePath, ref.workspaceIdentity),
              ),
            ].map((ref) => [getWorkspaceKey(ref.workspacePath, ref.workspaceIdentity), ref]),
          ).values(),
        ]
      : await listWorkspaceRefs({ currentWorkspace });
    const allowedWorkspaces = filterAllowedWorkspaces(workspaceRefs, user.allowedWorkspaces);
    const candidateWorkspaces = allowedWorkspaces.filter((workspace) => {
      if (context.group) return true;
      const workspaceKey = getWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity);
      return (
        workspaceKey === currentWorkspaceKey ||
        (!context.workspaceIdentity && workspace.workspacePath === context.workspacePath)
      );
    });
    const workspaces = candidateWorkspaces.length > 0 ? candidateWorkspaces : [currentWorkspace];
    const entries = (
      await Promise.all(
        workspaces.map(async (workspace) => {
          if (context.group && !(await isRemoteWorkspaceConnected(workspace))) return [];
          const zcodeTaskService = await resolveZCodeTaskServiceForContext(workspace);
          const tasks = await zcodeTaskService
            .listTasks({
              workspacePath: workspace.workspacePath,
              workspaceIdentity: workspace.workspaceIdentity,
            })
            .catch(() => []);
          return tasks.map((task) => ({
            task,
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
          }));
        }),
      )
    ).flat();
    const entryByKey = new Map<string, BotTaskSelectionEntry>();
    for (const entry of entries) {
      entryByKey.set(
        `${getWorkspaceKey(entry.workspacePath, entry.workspaceIdentity)}:${entry.task.taskId}`,
        entry,
      );
    }
    return [...entryByKey.values()].filter(
      (entry) => !context.group || context.group.taskIds.includes(entry.task.taskId),
    );
  }

  function resolvePendingTaskSelectionEntry(
    actor: BotActor,
    value: string,
  ): BotTaskSelectionEntry | null {
    const actorContextKey = getActorContextKey(actor);
    const directEntry = pendingTaskSelectionsByContext.get(actorContextKey)?.get(value.trim());
    if (directEntry) {
      return directEntry;
    }
    const option = resolvePendingSelectionOption(actor, "task.set", value);
    if (!option) {
      return null;
    }
    return pendingTaskSelectionsByContext.get(actorContextKey)?.get(option.id) ?? null;
  }

  function resolvePendingWorkspaceSelectionEntry(
    actor: BotActor,
    value: string,
  ): BotWorkspaceSelectionEntry | null {
    const actorContextKey = getActorContextKey(actor);
    const directEntry = pendingWorkspaceSelectionsByContext.get(actorContextKey)?.get(value.trim());
    if (directEntry) {
      return directEntry;
    }
    const option = resolvePendingSelectionOption(actor, "workspace.set", value);
    if (!option) {
      return null;
    }
    return pendingWorkspaceSelectionsByContext.get(actorContextKey)?.get(option.id) ?? null;
  }

  function createCurrentWorkspaceRef(context: BotContextState): BotWorkspaceRef {
    return createWorkspaceRef(context.workspacePath, context.workspaceIdentity);
  }

  async function readContextActiveTaskMeta(
    context: BotContextState,
  ): Promise<ZCodeTaskMeta | null> {
    if (!context.activeTaskId) {
      return null;
    }
    const listedTask = await readTaskMeta(context, context.activeTaskId).catch(() => null);
    if (listedTask) {
      return listedTask;
    }
    return (
      (
        await (
          await resolveZCodeTaskServiceForContext(context)
        )
          .getTaskSnapshot({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          .catch(() => null)
      )?.meta ?? null
    );
  }

  async function requireActiveTask(
    message: BotInboundMessage,
    auth: {
      context: BotContextState;
      locale: Locale | undefined;
    },
  ): Promise<
    | {
        ok: true;
        taskId: string;
        task: ZCodeTaskMeta;
        configOptions: ZCodeConfigOption[];
      }
    | { ok: false; reply: BotOutboundMessage[] }
  > {
    if (!auth.context.activeTaskId) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))],
      };
    }
    const task = await readContextActiveTaskMeta(auth.context);
    if (!task) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))],
      };
    }
    const configOptions = await listActiveTaskConfigOptions(
      auth.context,
      auth.context.activeTaskId,
    );
    return {
      ok: true,
      taskId: auth.context.activeTaskId,
      task,
      configOptions,
    };
  }

  async function broadcastTaskConfigSync(params: {
    context: BotContextState;
    taskId: string;
    task?: ZCodeTaskMeta | null;
    provider?: ZCodeProvider;
    configOptions?: ZCodeConfigOption[];
  }): Promise<void> {
    await broadcastTaskListChange(params.context, params.taskId, "updated", {
      ...(params.task ? { task: params.task } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.configOptions ? { configOptions: params.configOptions } : {}),
    });
  }

  function isTerminalTaskMeta(
    task: ZCodeTaskMeta | null,
    eventType: "task_complete" | "task_error",
  ): boolean {
    if (!task) {
      return false;
    }
    if (eventType === "task_error") {
      return task.status === "error";
    }
    return task.status === "completed";
  }

  async function readTerminalTaskMeta(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
    taskId: string,
    eventType: "task_complete" | "task_error",
  ): Promise<ZCodeTaskMeta | null> {
    let latestTask = await readTaskMeta(context, taskId).catch(() => null);
    if (isTerminalTaskMeta(latestTask, eventType)) {
      return latestTask;
    }

    for (const retryDelayMs of BOT_TASK_META_RETRY_DELAYS_MS) {
      await delay(retryDelayMs);
      latestTask = await readTaskMeta(context, taskId).catch(() => latestTask);
      if (isTerminalTaskMeta(latestTask, eventType)) {
        return latestTask;
      }
    }

    return latestTask;
  }

  async function processProviderCallback(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult> {
    const adapter = providers[provider];
    if (!adapter) {
      return { ok: false, replies: [], status: 400 };
    }
    const locale = await readMessageLocale();
    const config = await repo.readConfig();
    const callbackBot = findCallbackBot(config, provider, payload);
    // Verify the callback before reading quoted attachments or handling leaves, keeping unverified events side-effect free.
    if (callbackBot && isFeishuBotProvider(provider) && callbackBot.webhookSecretRef) {
      const expectedToken = await deps.credentialService.load(callbackBot.webhookSecretRef);
      const header = isRecord(payload) && isRecord(payload.header) ? payload.header : null;
      const inboundToken = isRecord(payload)
        ? (readNestedString(payload, "token") ?? readNestedString(header, "token"))
        : undefined;
      if (!expectedToken || expectedToken !== inboundToken) {
        return {
          ok: false,
          replies: [],
          status: 401,
          responseBody: { error: msg(locale, "webhookSecretInvalid") },
        };
      }
    }
    let materialPayload = payload;
    if (callbackBot && isFeishuBotProvider(provider) && isRecord(payload)) {
      const event = isRecord(payload.event) ? payload.event : payload;
      const native = isRecord(event.message) ? event.message : {};
      const chatId = readNestedString(native, "chat_id");
      const threadId = readNestedString(native, "thread_id");
      const topic =
        chatId && threadId
          ? (await repo.readState()).bots[
              getBotConversationKey({ botId: callbackBot.id, chatType: "group", chatId, threadId })
            ]
          : undefined;
      // The root quote belongs to the first input, not the active state; re-joining must not read it again.
      // Trust only the service record; external callbacks must not claim receipt to skip first-time prep.
      materialPayload = {
        ...payload,
        zcodeTopicHasAcceptedInput: Object.values(topic?.group?.inputs ?? {}).some(
          (input) => input.admission === "accepted",
        ),
      };
    }
    const preparedPayload = callbackBot
      ? ((await adapter
          .prepareCallbackPayload?.(callbackBot, materialPayload)
          .catch((error: unknown) => ({
            zcodeCallbackPrepareError: error instanceof Error ? error.message : String(error),
          }))) ?? payload)
      : payload;
    if (
      isRecord(preparedPayload) &&
      typeof preparedPayload.zcodeCallbackPrepareError === "string"
    ) {
      return {
        ok: false,
        replies: [],
        responseBody: { error: preparedPayload.zcodeCallbackPrepareError },
        status: 401,
      };
    }
    const callbackResponse = callbackBot
      ? await adapter.handleCallbackResponse?.(callbackBot, preparedPayload)
      : null;
    if (callbackResponse?.responseBody !== undefined) {
      return {
        ok: (callbackResponse.status ?? 200) < 400,
        replies: [],
        responseBody: callbackResponse.responseBody,
        status: callbackResponse.status,
      };
    }
    if (
      callbackBot &&
      isFeishuBotProvider(provider) &&
      isRecord(preparedPayload) &&
      preparedPayload.zcodeBotRemoved === true
    ) {
      const event = isRecord(preparedPayload.event) ? preparedPayload.event : preparedPayload;
      const chatId = readNestedString(event, "chat_id");
      if (chatId) {
        const state = (await repo.readState()).bots[
          getBotConversationKey({ botId: callbackBot.id, chatType: "group", chatId })
        ];
        if (state?.group) {
          await writeContext(
            { ...state, group: { ...state.group, enabled: false, authorizationId: randomUUID() } },
            true,
          );
          await cancelGroupTopicInputs({
            botId: callbackBot.id,
            provider: callbackBot.provider,
            chatType: "group",
            chatId,
            providerUserId: state.group.ownerId,
          });
        }
      }
      return { ok: true, replies: [] };
    }
    let parsePayload =
      isFeishuBotProvider(provider) && isRecord(preparedPayload)
        ? { ...preparedPayload, zcodeProvider: provider }
        : preparedPayload;
    if (callbackBot && isFeishuBotProvider(provider) && isRecord(parsePayload)) {
      const event = isRecord(parsePayload.event) ? parsePayload.event : parsePayload;
      const cardContext = isRecord(event.context) ? event.context : null;
      const cardChatId =
        readNestedString(cardContext, "open_chat_id") ?? readNestedString(cardContext, "chat_id");
      if (cardChatId) {
        const states = await repo.readState();
        const group =
          states.bots[
            getBotConversationKey({ botId: callbackBot.id, chatType: "group", chatId: cardChatId })
          ];
        if (group?.group) parsePayload = { ...parsePayload, zcodeChatType: "group" };
      }
    }
    const parsedInboundMessages = adapter.parseCallback(parsePayload);
    if (isFeishuBotProvider(provider)) {
      // Bugfix: a connected Feishu WebSocket means the socket is up, not that event subscriptions reached this client.
      // Log a payload digest and parsed count to tell "Feishu never delivered" from "payload shape unrecognized".
      botsLogger.debug(
        undefined,
        `provider callback parsed provider=${provider} count=${parsedInboundMessages.length} ${summarizeCallbackPayload(preparedPayload)}`,
      );
    }
    const replies: BotOutboundMessage[] = [];
    let hadBusinessFailure = false;
    const inboundSecret =
      isRecord(preparedPayload) && typeof preparedPayload.webhookSecret === "string"
        ? preparedPayload.webhookSecret
        : undefined;
    for (const inbound of parsedInboundMessages) {
      const bot = findBot(config, inbound.botId);
      if (bot?.provider === "webhook" && bot.webhookSecretRef) {
        const expectedSecret = await deps.credentialService.load(bot.webhookSecretRef);
        if (expectedSecret && expectedSecret !== inboundSecret) {
          replies.push(createOutbound(inbound.actor, msg(locale, "webhookSecretInvalid")));
          continue;
        }
      }
      if (bot && isFeishuBotProvider(bot.provider) && bot.webhookSecretRef) {
        const expectedToken = await deps.credentialService.load(bot.webhookSecretRef);
        const payloadHeader =
          isRecord(preparedPayload) && isRecord(preparedPayload.header)
            ? preparedPayload.header
            : null;
        const inboundToken =
          isRecord(preparedPayload) && typeof preparedPayload.token === "string"
            ? preparedPayload.token
            : typeof payloadHeader?.token === "string"
              ? payloadHeader.token
              : undefined;
        if (expectedToken && expectedToken !== inboundToken) {
          replies.push(createOutbound(inbound.actor, msg(locale, "webhookSecretInvalid")));
          continue;
        }
      }
      let inboundMessage = inbound;
      if (bot && !inbound.actor.displayName && adapter.resolveActorDisplayName) {
        try {
          const displayName = await adapter.resolveActorDisplayName(bot, inbound.actor);
          if (displayName?.trim()) {
            inboundMessage = {
              ...inbound,
              actor: {
                ...inbound.actor,
                displayName: displayName.trim(),
              },
            };
          }
        } catch (error) {
          // Bugfix: Feishu displayName needs an extra directory permission; its absence must not block messaging or binding.
          botsLogger.debug(
            undefined,
            `resolve actor displayName failed provider=${provider} bot=${inbound.botId} user=${inbound.actor.providerUserId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!markInboundDelivery(inboundMessage)) {
        botsLogger.debug(
          undefined,
          `provider callback duplicated provider=${provider} bot=${inboundMessage.botId} user=${inboundMessage.actor.providerUserId} messageId=${inboundMessage.actor.providerMessageId ?? ""}`,
        );
        continue;
      }
      botsLogger.debug(
        undefined,
        `provider callback provider=${provider} bot=${inboundMessage.botId} messageId=${inboundMessage.actor.providerMessageId ?? ""}`,
      );
      // Callback failures and reconnects follow the same topic-reminder rules, keeping provider-verified mention facts.
      inboundMessage = {
        ...inboundMessage,
        actor: { ...inboundMessage.actor, mentionedBot: inboundMessage.mentionedBot === true },
      };
      let outbound: BotOutboundMessage[];
      let reconnectStartingReply: BotOutboundMessage | null = null;
      let inboundBusinessFailure = false;
      try {
        const command = parseBotCommand(inboundMessage.commandText ?? inboundMessage.text);
        if (bot && inboundMessage.senderType !== "app" && command.type === "reconnect") {
          outbound = await handleReconnect(inboundMessage, {
            onReconnectStart: async (auth) => {
              reconnectStartingReply = createOutbound(
                inboundMessage.actor,
                msg(auth.locale, "remoteReconnectStarting", {
                  workspacePath: auth.context.workspacePath,
                }),
              );
              await sendOutbound(bot, reconnectStartingReply);
            },
          });
        } else {
          outbound = await service.handleInboundMessage(inboundMessage);
        }
      } catch (error) {
        releaseInboundDelivery(inboundMessage);
        hadBusinessFailure = true;
        inboundBusinessFailure = true;
        const message = error instanceof Error ? error.message : String(error);
        const userFacingMessage = formatUserFacingBotError(error, locale);
        botsLogger.warn(
          undefined,
          `provider callback failed provider=${provider} bot=${inboundMessage.botId} user=${inboundMessage.actor.providerUserId}: ${message}`,
        );
        outbound = [
          administratorErrorReply(
            inboundMessage.actor,
            bot,
            error,
            createOutbound(
              inboundMessage.actor,
              isSessionExpiredError(error)
                ? userFacingMessage
                : msg(locale, "callbackFailed", { message: userFacingMessage }),
            ),
          ),
        ];
      }
      if (reconnectStartingReply) {
        replies.push(reconnectStartingReply);
      }
      replies.push(...outbound);
      if (inboundBusinessFailure) {
        // Bugfix: delivering the error notice is not consuming the business message. No callback ACK here,
        // or Feishu strips the buttons; a final ok=false also blocks the WeCom/Telegram external cursor.
        if (bot) {
          for (const outboundMessage of outbound) {
            await sendOutbound(bot, outboundMessage).catch((sendError) => {
              botsLogger.warn(
                undefined,
                `provider callback failure notice failed provider=${provider} bot=${bot.id}: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
              );
            });
          }
          await stopInboundTyping(bot, inboundMessage.actor).catch(() => undefined);
        }
        continue;
      }
      if (bot) {
        const transientCard = transientInteractionCards.get(
          getActorContextKey(inboundMessage.actor),
        );
        const handledByFeishuSynchronousCardAction =
          isFeishuBotProvider(provider) &&
          isRecord(preparedPayload) &&
          ((preparedPayload.zcodeFeishuSynchronousCardAction === true &&
            !(
              isRecord(preparedPayload.zcodeFeishuCardResponseState) &&
              preparedPayload.zcodeFeishuCardResponseState.deferred === true
            ) &&
            Boolean(outbound[0])) ||
            (inboundMessage.groupCardAction === true && outbound[0]?.callbackToastOnly === true));
        // Bugfix: an empty ACK hides the Telegram header spinner without any visible feedback.
        // After handling, write the outcome into the answerCallbackQuery toast so the button result shows even if sendMessage fails.
        const callbackText = outbound[0]?.text ?? msg(locale, "received");
        let acknowledgeResult:
          | Awaited<ReturnType<NonNullable<typeof adapter.acknowledgeCallback>>>
          | undefined;
        const acknowledgeController = new AbortController();
        const acknowledgeTimeout = setTimeout(() => {
          acknowledgeController.abort(
            new Error(
              `Bot provider callback acknowledgement timed out after ${BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS}ms.`,
            ),
          );
        }, BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS);
        try {
          acknowledgeResult = await Promise.race([
            handledByFeishuSynchronousCardAction || (transientCard && !outbound[0]?.elicitation)
              ? Promise.resolve(undefined)
              : adapter.acknowledgeCallback?.(
                  bot,
                  preparedPayload,
                  callbackText,
                  outbound[0],
                  acknowledgeController.signal,
                ),
            new Promise<never>((_resolve, reject) => {
              acknowledgeController.signal.addEventListener(
                "abort",
                () => reject(acknowledgeController.signal.reason),
                { once: true },
              );
            }),
          ]);
        } catch (error) {
          // Fix: the second Feishu question used to wait on card/update; credential or SDK internals
          // A hang in any step starves the fallback. The main flow sets its own deadline and emits the next question on timeout.
          botsLogger.warn(
            undefined,
            `provider callback acknowledge failed provider=${provider} bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          clearTimeout(acknowledgeTimeout);
        }
        const callbackHandledByCardUpdate =
          handledByFeishuSynchronousCardAction || acknowledgeResult?.handled === true;
        const administratorNotice = outbound.find(
          (reply) => reply.callbackToastOnly && reply.administratorAttention,
        );
        if (callbackHandledByCardUpdate && administratorNotice) {
          await sendOutbound(bot, {
            ...administratorNotice,
            callbackToastOnly: undefined,
            administratorAttention: undefined,
          });
        }
        if (
          !handledByFeishuSynchronousCardAction &&
          callbackHandledByCardUpdate &&
          transientCard &&
          outbound[0]?.elicitation
        ) {
          // Fix: real Feishu logs confirm clients can stick on the old question even after card/update returns success.
          // The callback token ACKs the click; a follow-up PATCH on the same message_id forces the visible refresh;
          // Both writes always target the same card; the flickery create-then-recall approach is banned.
          await providers[transientCard.bot.provider]
            ?.updateTransientInteractionCard?.(transientCard.bot, transientCard.handle, outbound[0])
            .catch((error) => {
              // The agent accepted the answer and the callback token ACKed; a failed PATCH must not
              // WeCom/Telegram-style external cursors retry the whole answer, or the same interaction gets submitted twice.
              botsLogger.warn(
                undefined,
                `refresh transient interaction card failed provider=${provider} bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        }
        if (
          callbackHandledByCardUpdate &&
          transientCard &&
          !outbound[0]?.callbackToastOnly &&
          outbound[0]?.elicitation?.status !== "pending"
        ) {
          // Fix: card_update_token already flipped the message to its read-only terminal state; only the in-memory handle is released,
          // No more PATCH, DELETE, or extra result cards.
          transientInteractionCards.delete(getActorContextKey(inboundMessage.actor));
        }
        // Bugfix: the /reconnect "reconnecting" notice must go out live before ensureConnected.
        // handleReconnect returns only the final result, so a stale in-progress state is not dumped after the reconnect lands.
        try {
          for (const outboundMessage of callbackHandledByCardUpdate ? [] : outbound) {
            if (transientCard && !outboundMessage.callbackToastOnly) {
              if (outboundMessage.selection || outboundMessage.elicitation?.status === "pending") {
                await upsertTransientInteractionCard(
                  bot,
                  inboundMessage.actor,
                  transientCard.taskId,
                  outboundMessage,
                );
                continue;
              }
              if (
                outboundMessage.elicitation ||
                /^\/(?:approve|deny)(?:\s|$)/u.test(inboundMessage.text)
              ) {
                await finalizeTransientInteractionCard(inboundMessage.actor, outboundMessage);
                continue;
              }
            }
            await sendOutbound(bot, outboundMessage);
          }
          await stopInboundTyping(bot, inboundMessage.actor);
        } catch (error) {
          releaseInboundDelivery(inboundMessage);
          throw error;
        }
      }
    }
    return {
      ok: !hadBusinessFailure,
      replies,
      ...(hadBusinessFailure ? { status: 503 } : {}),
    };
  }

  function createAssistantReplyBlocks(
    parts: readonly ZCodeAssistantMessagePart[],
    toolCalls: ReadonlyMap<string, BotReplyToolCallState>,
    mode: BotReplyGranularity | undefined,
    changeSummary: ZCodeTaskMeta["changeSummary"] | null | undefined,
  ): BotAssistantReplyBlock[] {
    const blocks: BotAssistantReplyBlock[] = [];
    const resolvedMode = mode ?? getDefaultBotReplyGranularity();
    const presentation = buildZCodeAssistantPresentation({
      content: "",
      toolCalls: [...toolCalls.values()].map((toolCall) => ({
        ...toolCall,
        kind: toolCall.kind ?? "tool",
        input: toolCall.input,
        status: toolCall.status ?? "pending",
      })),
      parts,
    });

    if (resolvedMode === "summary_changes") {
      if (presentation.latestPart?.content.trim()) {
        blocks.push({
          type: "content",
          content: presentation.latestPart.content,
        });
      }
    } else {
      for (const block of presentation.blocks) {
        if (block.type === "content" && block.content.trim()) {
          blocks.push({ type: "content", content: block.content });
          continue;
        }
        if (resolvedMode !== "assistant_toolcalls_changes" || block.type !== "tool-call") {
          continue;
        }
        const toolCall = toolCalls.get(block.toolCall.toolId);
        if (toolCall) {
          blocks.push({ type: "tool-call", toolCall });
        }
      }
    }

    if (changeSummary && changeSummary.fileCount > 0 && changeSummary.files.length > 0) {
      blocks.push({ type: "change-summary", changeSummary });
    }
    return blocks;
  }

  function normalizeBotElicitationQuestions(
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
    locale: Locale | undefined,
  ): ZCodeElicitationQuestion[] {
    const schema = isRecord(event.schema) ? event.schema : null;
    const isPlanApproval = schema?.interaction === "plan_approval";
    if (isPlanApproval) {
      return [
        {
          question: msg(locale, "planApprovalTitle"),
          header: msg(locale, "planApprovalHeader"),
          options: [
            {
              value: "approve",
              label: msg(locale, "planApprovalApprove"),
              description: msg(locale, "planApprovalApproveDescription"),
            },
          ],
        },
      ];
    }
    const sourceQuestions =
      event.questions && event.questions.length > 0
        ? event.questions
        : [
            {
              question: event.message,
              header: event.header ?? event.message,
              options: event.options,
              ...(event.multiSelect ? { multiSelect: true } : {}),
            },
          ];
    return sourceQuestions.map((question) => ({
      question: question.question,
      header: question.header || question.question,
      options: question.options.map((option) => ({
        value: option.value,
        label: option.label || option.value,
        description: option.description,
      })),
      ...(question.multiSelect ? { multiSelect: true } : {}),
    }));
  }

  function readBotElicitationRenderContext(
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
  ): BotPendingElicitation["renderContext"] {
    const schema = isRecord(event.schema) ? event.schema : null;
    if (
      schema?.interaction !== "plan_approval" ||
      typeof schema.plan !== "string" ||
      !schema.plan.trim()
    ) {
      return undefined;
    }
    return { kind: "plan_approval", plan: schema.plan.trim() };
  }

  function createPendingElicitationSchema(
    pending: BotPendingElicitation,
  ): Record<string, unknown> | undefined {
    return pending.renderContext?.kind === "plan_approval"
      ? { interaction: "plan_approval", plan: pending.renderContext.plan }
      : undefined;
  }

  function getElicitationAnswerKey(questionIndex: number): string {
    return String(questionIndex);
  }

  function readElicitationAnswerValues(
    pending: BotPendingElicitation,
    questionIndex: number,
  ): string[] {
    return pending.answers[getElicitationAnswerKey(questionIndex)] ?? [];
  }

  function getPendingElicitationSelectionToken(pending: BotPendingElicitation): string {
    return createHash("sha256")
      .update(
        [pending.taskId, pending.runId, pending.requestId, pending.currentQuestionIndex].join("::"),
      )
      .digest("hex")
      .slice(0, 12);
  }

  function getPendingElicitationSkipOptionId(pending: BotPendingElicitation): string {
    return `${BOT_ELICITATION_SKIP_OPTION_ID}:${getPendingElicitationSelectionToken(pending)}`;
  }

  function parseElicitationResponseValue(value: string): {
    token?: string;
    value: string;
  } {
    const trimmed = value.trim();
    const [maybeToken, ...rest] = trimmed.split(/\s+/u);
    if (maybeToken && rest.length > 0 && /^[a-f0-9]{12}$/iu.test(maybeToken)) {
      return { token: maybeToken.toLowerCase(), value: rest.join(" ") };
    }
    return { value: trimmed };
  }

  function parseElicitationFormValues(value: string): string[] | null {
    if (!value.startsWith(BOT_ELICITATION_FORM_VALUE_PREFIX)) {
      return null;
    }
    const encoded = value.slice(BOT_ELICITATION_FORM_VALUE_PREFIX.length);
    try {
      const parsed = JSON.parse(decodeURIComponent(encoded)) as unknown;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      return values.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
    } catch {
      return [];
    }
  }

  function mergeElicitationFormValues(
    question: ZCodeElicitationQuestion,
    selectedValues: readonly string[],
    formValues: readonly string[],
  ): string[] {
    const customValues = formValues.filter(Boolean);
    if (!question.multiSelect) {
      return customValues.length > 0 ? customValues.slice(0, 1) : selectedValues.slice(0, 1);
    }
    const merged: string[] = [];
    for (const value of [...selectedValues, ...customValues]) {
      if (!value || merged.includes(value)) {
        continue;
      }
      merged.push(value);
    }
    return merged;
  }

  function toggleElicitationCustomAnswerExpanded(
    pending: BotPendingElicitation,
  ): BotPendingElicitation {
    const current = new Set(pending.expandedCustomAnswerQuestionIndexes ?? []);
    if (current.has(pending.currentQuestionIndex)) {
      current.delete(pending.currentQuestionIndex);
    } else {
      current.add(pending.currentQuestionIndex);
    }
    return {
      ...pending,
      expandedCustomAnswerQuestionIndexes: [...current].sort((left, right) => left - right),
    };
  }

  function resolveElicitationQuestionValue(
    question: ZCodeElicitationQuestion,
    value: string,
    options: { includeSubmit?: boolean } = {},
  ): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    const normalized = normalizeText(trimmed);
    if (
      question.multiSelect &&
      options.includeSubmit !== false &&
      ["submit", "done", "完成", "提交", BOT_ELICITATION_SUBMIT_OPTION_ID].includes(normalized)
    ) {
      return BOT_ELICITATION_SUBMIT_OPTION_ID;
    }
    const option = resolveOptionByValue(
      question.options.map((item) => ({ id: item.value, label: item.label })),
      trimmed,
    );
    if (option) {
      return option.id;
    }
    const index = Number.parseInt(trimmed, 10);
    if (
      question.multiSelect &&
      options.includeSubmit !== false &&
      /^[1-9]\d*$/u.test(trimmed) &&
      index === question.options.length + 1
    ) {
      return BOT_ELICITATION_SUBMIT_OPTION_ID;
    }
    return trimmed;
  }

  function isPendingElicitationOwnedByActor(
    pending: BotPendingElicitation,
    actor: BotActor,
  ): boolean {
    return (
      !pending.actorKey ||
      pending.actorKey === getActorContextKey(actor) ||
      (actor.chatType === "group" &&
        pending.actorKey.startsWith(`${actor.botId}::${actor.provider}::${actor.chatId}::`))
    );
  }

  function clearPendingElicitationSelection(pending: BotPendingElicitation): void {
    const token = getPendingElicitationSelectionToken(pending);
    for (const [contextKey, selection] of pendingSelectionsByContext) {
      if (
        selection.action === "elicitation.respond" &&
        (selection.token === token || selection.id.startsWith(`elicitation-${pending.requestId}-`))
      ) {
        pendingSelectionsByContext.delete(contextKey);
      }
    }
  }

  function buildBotElicitationContent(
    pending: BotPendingElicitation,
    answers: BotPendingElicitation["answers"] = pending.answers,
  ): Record<string, unknown> {
    // Fix: bots share the desktop contract where a missing key means skipped; an unanswered question must not be written as
    // an empty string, or the agent reads it as a user-supplied preference.
    const answerEntries = pending.questions.flatMap((question, index) => {
      const values = answers[getElicitationAnswerKey(index)] ?? [];
      const text = values.join(", ").trim();
      return text ? [[question.question, text]] : [];
    });
    const content: Record<string, unknown> = {
      answers: Object.fromEntries(answerEntries),
    };
    pending.questions.forEach((question, index) => {
      const values = answers[getElicitationAnswerKey(index)] ?? [];
      if (values.length > 0) {
        content[`answer_${index}`] = question.multiSelect ? values : values[0];
      }
    });
    if (pending.questions.length === 1) {
      const values = answers[getElicitationAnswerKey(0)] ?? [];
      if (values.length > 0) {
        content.answer = pending.questions[0]?.multiSelect ? values : values[0];
      }
    }
    return content;
  }

  function createBotElicitationRequestSnapshot(
    pending: BotPendingElicitation,
  ): ZCodeElicitationRequest {
    const currentQuestion = pending.questions[pending.currentQuestionIndex] ?? pending.questions[0];
    const answerDrafts = Object.fromEntries(
      Object.entries(pending.answers).map(([index, values]) => [`answer_${index}`, values]),
    );
    return {
      type: "elicitation_request",
      taskId: pending.taskId,
      traceId: pending.runId,
      requestId: pending.requestId,
      ...(pending.origin ? { origin: pending.origin } : {}),
      message: currentQuestion?.question ?? "",
      header: currentQuestion?.header,
      options: currentQuestion?.options ?? [],
      ...(currentQuestion?.multiSelect ? { multiSelect: true } : {}),
      questions: pending.questions,
      currentQuestionIndex: pending.currentQuestionIndex,
      answerDrafts,
      ...(createPendingElicitationSchema(pending)
        ? { schema: createPendingElicitationSchema(pending) }
        : {}),
    };
  }

  async function broadcastPendingElicitationProgress(
    context: BotContextState,
    pending: BotPendingElicitation,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      broadcastTaskListChange(context, pending.taskId, "elicitation_request", {
        elicitationRequest: createBotElicitationRequestSnapshot(pending),
        requestId: pending.requestId,
      }).then(() => "broadcast" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(
          () => resolve("timeout"),
          BOT_ELICITATION_PROGRESS_BROADCAST_TIMEOUT_MS,
        );
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (outcome === "timeout") {
      // Fix: v4/UI progress broadcasts are advisory. Awaiting a hung broadcast RPC forever
      // A Feishu button callback that cannot build the next question never reaches card/update, stranding users on question one.
      botsLogger.warn(
        undefined,
        `elicitation progress broadcast timed out task=${pending.taskId} request=${pending.requestId}`,
      );
    }
  }

  function formatBotElicitationTitle(
    pending: BotPendingElicitation,
    locale: Locale | undefined,
  ): string {
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return pending.requestId;
    }
    const isCustomAnswerExpanded =
      pending.expandedCustomAnswerQuestionIndexes?.includes(pending.currentQuestionIndex) === true;
    if (pending.renderContext?.kind === "plan_approval") {
      // Bugfix: Feishu cards consume schema.plan directly, but Telegram/WeCom render only message.text.
      // Project the full plan into the shared outbound title so every text channel keeps the approval context.
      return [
        pending.renderContext.plan,
        "------",
        msg(locale, "planApprovalTitle"),
        isCustomAnswerExpanded ? msg(locale, "elicitationCustomPlaceholder") : null,
      ]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join("\n\n");
    }
    const parts = [
      pending.questions.length > 1
        ? `${pending.currentQuestionIndex + 1}/${pending.questions.length}`
        : null,
      question.header && question.header !== question.question ? question.header : null,
      question.question,
      question.multiSelect ? msg(locale, "elicitationMultiSelectHint") : null,
      isCustomAnswerExpanded ? msg(locale, "elicitationCustomPlaceholder") : null,
      msg(locale, "elicitationTextHint"),
    ].filter((part): part is string => typeof part === "string" && part.length > 0);
    return parts.join("\n");
  }

  function createBotElicitationSelection(
    pending: BotPendingElicitation,
    locale: Locale | undefined,
  ): SelectionPrompt {
    const question = pending.questions[pending.currentQuestionIndex];
    const selectedValues = new Set(
      readElicitationAnswerValues(pending, pending.currentQuestionIndex),
    );
    const options: SelectionPrompt["options"] =
      question?.options.map((option) => ({
        id: option.value,
        label: question.multiSelect
          ? `${selectedValues.has(option.value) ? "[x]" : "[ ]"} ${option.label}`
          : option.label,
        // Plan approval notes are semantic metadata; text channels show only approve/custom actions,
        // Keep exit-plan-mode from growing extra body text, matching the Feishu card.
        description:
          pending.renderContext?.kind === "plan_approval" ? undefined : option.description,
      })) ?? [];
    if (pending.renderContext?.kind === "plan_approval") {
      // Bugfix: the Feishu provider adds its own custom-answer form, while Telegram/WeCom rely on the shared selection.
      // Plan approval needs an entry point here so text-only channels can do more than approve.
      options.push({
        id: BOT_ELICITATION_CUSTOM_OPTION_ID,
        label: msg(locale, "elicitationCustomOption"),
      });
    }
    if (question?.multiSelect) {
      options.push({
        id: BOT_ELICITATION_SUBMIT_OPTION_ID,
        label: msg(locale, "elicitationSubmitOption"),
      });
    } else if (question) {
      options.push({
        id: getPendingElicitationSkipOptionId(pending),
        label: msg(locale, "elicitationSkipOption"),
      });
    }
    return {
      id: `elicitation-${pending.requestId}-${pending.currentQuestionIndex}`,
      token: getPendingElicitationSelectionToken(pending),
      title: formatBotElicitationTitle(pending, locale),
      action: "elicitation.respond",
      options,
    };
  }

  async function createElicitationReply(
    actor: BotActor,
    pending: BotPendingElicitation,
    locale: Locale | undefined,
    status: NonNullable<BotOutboundMessage["elicitation"]>["status"] = "pending",
  ): Promise<BotOutboundMessage[]> {
    const currentQuestionIndex =
      status === "pending"
        ? pending.currentQuestionIndex
        : Math.max(0, pending.questions.length - 1);
    return createSelectionReply(actor, createBotElicitationSelection(pending, locale), locale, {
      locale,
      elicitation: {
        requestId: pending.requestId,
        taskId: pending.taskId,
        runId: pending.runId,
        currentQuestionIndex,
        questions: pending.questions,
        answers: pending.answers,
        status,
        ...(pending.expandedCustomAnswerQuestionIndexes?.length
          ? {
              expandedCustomAnswerQuestionIndexes: pending.expandedCustomAnswerQuestionIndexes,
            }
          : {}),
        ...(createPendingElicitationSchema(pending)
          ? { schema: createPendingElicitationSchema(pending) }
          : {}),
      },
    });
  }

  function createCompletedElicitationOutbound(
    actor: BotActor,
    pending: BotPendingElicitation,
    locale: Locale | undefined,
    action: "accept" | "decline" | "cancel",
  ): BotOutboundMessage {
    const status = action === "cancel" ? "cancelled" : "completed";
    return createOutbound(
      actor,
      msg(locale, action === "accept" ? "elicitationSubmitted" : "elicitationCancelled"),
      undefined,
      {
        locale,
        elicitation: {
          requestId: pending.requestId,
          taskId: pending.taskId,
          runId: pending.runId,
          currentQuestionIndex: Math.max(0, pending.questions.length - 1),
          questions: pending.questions,
          answers: pending.answers,
          status,
          ...(createPendingElicitationSchema(pending)
            ? { schema: createPendingElicitationSchema(pending) }
            : {}),
        },
      },
    );
  }

  async function clearPendingElicitationForRequest(
    context: BotContextState,
    requestId: string,
  ): Promise<void> {
    if (context.pendingElicitation?.requestId !== requestId) {
      return;
    }
    clearPendingElicitationSelection(context.pendingElicitation);
    await writeContext({ ...context, pendingElicitation: undefined }, false, context.activeTaskId);
  }

  async function submitPendingElicitation(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    pending: BotPendingElicitation,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ): Promise<BotOutboundMessage[]> {
    if (!isPendingElicitationOwnedByActor(pending, actor)) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    if (pending.handledAt) {
      return [createOutbound(actor, msg(auth.locale, "elicitationHandled"))];
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
    const submitted = await zcodeTaskService.respondElicitation({
      taskId: pending.taskId,
      workspacePath: auth.context.workspacePath,
      workspaceIdentity: auth.context.workspaceIdentity,
      runId: pending.runId,
      requestId: pending.requestId,
      action,
      content,
    });
    // Fix: v4 resolveInteraction is the business commit point. Writing handledAt before the ACK
    // After a transient failure the same button reads as handled and the agent waits on input forever.
    const handledAt = Date.now();
    await writeContext({
      ...auth.context,
      pendingElicitation: { ...pending, handledAt },
    });
    clearPendingElicitationSelection(pending);
    await writeContext({ ...auth.context, pendingElicitation: undefined });
    await broadcastTaskListChange(auth.context, pending.taskId, "elicitation_resolved", {
      requestId: pending.requestId,
    });
    if (!submitted) {
      return [createOutbound(actor, msg(auth.locale, "elicitationHandled"))];
    }
    if (action === "accept") {
      startTyping(auth.bot, actor, pending.taskId);
      // Bugfix: answering AskUserQuestion is not a config success; keep the original answer copy so /status is not echoed by mistake.
      return [createCompletedElicitationOutbound(actor, pending, auth.locale, action)];
    }
    // Bugfix: cancelled/rejected answers use the elicitation's own result copy, keeping unrelated task state out of bots.
    return [createCompletedElicitationOutbound(actor, pending, auth.locale, action)];
  }

  async function advancePendingElicitation(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    pending: BotPendingElicitation,
    answers: BotPendingElicitation["answers"],
  ): Promise<BotOutboundMessage[]> {
    if (pending.currentQuestionIndex >= pending.questions.length - 1) {
      return submitPendingElicitation(
        auth,
        actor,
        { ...pending, answers },
        "accept",
        buildBotElicitationContent(pending, answers),
      );
    }
    const nextPending: BotPendingElicitation = {
      ...pending,
      currentQuestionIndex: pending.currentQuestionIndex + 1,
      answers,
    };
    await writeContext({ ...auth.context, pendingElicitation: nextPending });
    // Bugfix: after the bot answers AskUserQuestion on the user's behalf, a UI fed only the final response keeps a stale local draft.
    // Every step syncs question index and answers so desktop/mobile web keep the same selection state.
    await broadcastPendingElicitationProgress(auth.context, nextPending);
    return createElicitationReply(actor, nextPending, auth.locale);
  }

  async function handlePendingElicitationValue(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    value: string,
  ): Promise<BotOutboundMessage[]> {
    const pending = auth.context.pendingElicitation;
    if (!pending || pending.taskId !== auth.context.activeTaskId) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    if (!isPendingElicitationOwnedByActor(pending, actor)) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    const parsedValue = parseElicitationResponseValue(value);
    if (actor.provider !== "weixin") {
      const expectedToken = getPendingElicitationSelectionToken(pending);
      if (!parsedValue.token || parsedValue.token !== expectedToken) {
        // Bugfix: stale Telegram/Feishu/Webhook buttons can arrive after a newer AskUserQuestion.
        // Non-WeCom channels must carry this turn's short token or the previous turn's button index reads as the current answer.
        return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
      }
    }
    if (parsedValue.value === getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const formValues = parseElicitationFormValues(parsedValue.value);
    if (formValues) {
      const answerKey = getElicitationAnswerKey(pending.currentQuestionIndex);
      const nextValues = mergeElicitationFormValues(
        question,
        readElicitationAnswerValues(pending, pending.currentQuestionIndex),
        formValues,
      );
      if (nextValues.length === 0) {
        return createElicitationReply(actor, pending, auth.locale);
      }
      // Bugfix: Feishu/Lark flat options keep the draft in buttons; the form only submits and takes custom input.
      // On submit, merge the radio/checkbox draft with custom input or an empty form wipes the chosen options.
      return advancePendingElicitation(auth, actor, pending, {
        ...pending.answers,
        [answerKey]: nextValues,
      });
    }
    const selectionOption = resolvePendingSelectionOption(
      actor,
      "elicitation.respond",
      parsedValue.value,
    );
    if (selectionOption?.id === getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const selectedValue = resolveElicitationQuestionValue(
      question,
      selectionOption?.id ?? parsedValue.value,
    );
    if (!selectedValue) {
      return createElicitationReply(actor, pending, auth.locale);
    }
    if (selectedValue === BOT_ELICITATION_SUBMIT_OPTION_ID) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    if (selectedValue === BOT_ELICITATION_CUSTOM_OPTION_ID) {
      const nextPending = toggleElicitationCustomAnswerExpanded(pending);
      await writeContext({ ...auth.context, pendingElicitation: nextPending });
      await broadcastPendingElicitationProgress(auth.context, nextPending);
      return createElicitationReply(actor, nextPending, auth.locale);
    }
    const answerKey = getElicitationAnswerKey(pending.currentQuestionIndex);
    if (question.multiSelect) {
      const currentValues = readElicitationAnswerValues(pending, pending.currentQuestionIndex);
      const nextValues = currentValues.includes(selectedValue)
        ? currentValues.filter((item) => item !== selectedValue)
        : [...currentValues, selectedValue];
      const nextPending = {
        ...pending,
        answers: { ...pending.answers, [answerKey]: nextValues },
      };
      await writeContext({ ...auth.context, pendingElicitation: nextPending });
      // Bugfix: toggling a multi-select in the bot raises no ZCode Agent response; push the draft to the UI explicitly.
      await broadcastPendingElicitationProgress(auth.context, nextPending);
      return createElicitationReply(actor, nextPending, auth.locale);
    }
    return advancePendingElicitation(auth, actor, pending, {
      ...pending.answers,
      [answerKey]: [selectedValue],
    });
  }

  async function handlePendingElicitationText(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    text: string,
  ): Promise<BotOutboundMessage[] | null> {
    const pending = auth.context.pendingElicitation;
    if (!pending || pending.taskId !== auth.context.activeTaskId) {
      return null;
    }
    if (!isPendingElicitationOwnedByActor(pending, actor)) {
      return null;
    }
    const value = text.trim();
    if (!value) {
      return createElicitationReply(actor, pending, auth.locale);
    }
    if (value === getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const answerKey = getElicitationAnswerKey(pending.currentQuestionIndex);
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    if (
      !question.multiSelect &&
      /^[1-9]\d*$/u.test(value) &&
      Number.parseInt(value, 10) === question.options.length + 1
    ) {
      // Fix: free text is user data and must survive; only the menu's extra index means skip,
      // so legitimate options or custom answers named skip/next/跳过/__skip__ are not swallowed.
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const values = question?.multiSelect
      ? value
          .split(/[,\n，、]/u)
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) =>
            resolveElicitationQuestionValue(question, item, {
              includeSubmit: false,
            }),
          )
      : [resolveElicitationQuestionValue(question, value, { includeSubmit: false })];
    return advancePendingElicitation(auth, actor, pending, {
      ...pending.answers,
      [answerKey]: values,
    });
  }

  async function handleStructuredElicitationResponse(
    message: BotInboundMessage,
    response: BotStructuredElicitationResponse,
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    const pending = auth.context.pendingElicitation;
    if (!pending || pending.requestId !== response.requestId) {
      return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
    }
    if (!isPendingElicitationOwnedByActor(pending, message.actor)) {
      return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
    }
    return submitPendingElicitation(
      auth,
      message.actor,
      pending,
      response.action,
      response.content,
    );
  }

  async function handleElicitationRequest(
    bot: BotConfig,
    user: BotConfig,
    actor: BotActor,
    context: BotContextState,
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
    mentionedUserIds?: string[],
  ): Promise<void> {
    const locale = await readMessageLocale();
    stopTyping(event.taskId);
    const pendingElicitation: BotPendingElicitation = {
      taskId: event.taskId,
      requestId: event.requestId,
      runId: event.traceId,
      // Bugfix: subagent-initiated elicitations must keep their origin, or bot broadcasts and later responses
      // Request ownership is unrecoverable; after the rebase only top-level stream events carry origin.
      ...(event.origin ? { origin: event.origin } : {}),
      actorKey: getActorContextKey(actor),
      currentQuestionIndex: 0,
      // Fix: ExitPlanMode's protocol question and options are stable English; reusing them verbatim mixes languages on zh bot cards.
      // The bot localizes the whole approval copy at the outbound edge by app locale; plain AskUserQuestion keeps the model's original text.
      questions: normalizeBotElicitationQuestions(event, locale),
      answers: {},
      // Fix: Feishu/Lark rebuilds the original card on custom answers, completion, and restart recovery;
      // Passing schema only on the first send loses the plan on later updates, degrading to a generic question card.
      ...(readBotElicitationRenderContext(event)
        ? { renderContext: readBotElicitationRenderContext(event) }
        : {}),
    };
    // Bugfix: bots used to consume permission_request only and never surfaced the ZCode Agent's
    // Without converting AskUserQuestion/elicitation_request into answerable messages the task waits on user input forever.
    if (context.pendingElicitation) {
      clearPendingElicitationSelection(context.pendingElicitation);
    }
    Object.assign(context, { pendingElicitation });
    await writeContext({ ...context, pendingElicitation }, false, context.activeTaskId);
    await broadcastPendingElicitationProgress(context, pendingElicitation);
    for (const reply of await createElicitationReply(actor, pendingElicitation, locale)) {
      // Reason: transient interaction cards bypass the normal outbound branch and used to lose group task/grant versions; attach before choosing transport.
      const scopedReply = context.group
        ? {
            ...reply,
            mentionedUserIds:
              pendingElicitation.renderContext?.kind === "plan_approval"
                ? adminAttention.mention(
                    actor,
                    bot.providerUserId,
                    `plan:${event.taskId}:${event.requestId}`,
                  )
                : mentionedUserIds,
            groupTaskId: context.activeTaskId!,
            groupCard: groupCardFor(actor, context),
          }
        : reply;
      if (shouldUseTransientInteractionCard(bot, user)) {
        await upsertTransientInteractionCard(bot, actor, event.taskId, scopedReply);
      } else {
        await sendOutbound(bot, scopedReply);
      }
    }
  }

  async function watchTaskStream(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    user: BotConfig,
    automation: boolean | string = false,
  ): Promise<void> {
    const key = taskStreamKey(context, actor);
    const previous = watchStarts.get(key) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => startTaskStream(bot, actor, context, user, automation));
    watchStarts.set(key, pending);
    try {
      await pending;
    } finally {
      if (watchStarts.get(key) === pending) watchStarts.delete(key);
    }
  }

  async function startTaskStream(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    user: BotConfig,
    automation: boolean | string = false,
  ): Promise<void> {
    if (!context.activeTaskId) {
      return;
    }
    for (const [inputId, input] of Object.entries(context.group?.inputs ?? {})) {
      if (
        input.taskId !== context.activeTaskId ||
        !input.progress?.cardMessageId ||
        input.progress.cardStatus === input.progress.status
      )
        continue;
      await queueCards
        .update(
          JSON.stringify([
            bot.id,
            context.group!.chatId,
            context.activeTaskId,
            context.group!.authorizationId,
            inputId,
            context.group!.threadId,
          ]),
          input.progress.status,
        )
        .catch((error) => {
          botsLogger.warn(
            undefined,
            `restore queue card state failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    const streamSubscriptionKey = taskStreamKey(context, actor);
    const existingSubscription = streamSubscriptions.get(streamSubscriptionKey);
    if (existingSubscription) {
      if (automation)
        existingSubscription.automation(typeof automation === "string" ? automation : undefined);
      return;
    }
    const persistentPrivate = !context.group && !automation && privateSyncSupported(bot);
    const bindingId = context.privateBindingId;
    let automationPending = automation === true;
    let automationRun = Boolean(automation);
    const automationRuns = new Set<string>(typeof automation === "string" ? [automation] : []);
    let imInteractionRun = !persistentPrivate;
    let privateDeliveryFailed = false;
    let privateCardDeliveryUnknown = false;
    const isPrivateAuthorized = async (): Promise<boolean> => {
      if (!persistentPrivate) {
        if (context.group) return true;
        const currentBot = findBot(await repo.readConfig(), bot.id);
        return Boolean(
          currentBot?.enabled &&
          currentBot.provider === bot.provider &&
          currentBot.providerUserId === bot.providerUserId &&
          currentBot.credentialRef === bot.credentialRef,
        );
      }
      const currentBot = findBot(await repo.readConfig(), bot.id);
      const latest = (await repo.readState()).bots[bot.id];
      const recipient =
        currentBot?.provider === "weixin" ? latest?.privateRecipientId : currentBot?.providerUserId;
      return Boolean(
        currentBot?.enabled &&
        currentBot.provider === bot.provider &&
        recipient === actor.providerUserId &&
        latest &&
        latest.privateBindingId === bindingId &&
        isWorkspaceAllowed(
          latest.workspaceId ?? getWorkspaceKey(latest.workspacePath, latest.workspaceIdentity),
          currentBot.allowedWorkspaces,
        ) &&
        latest?.activeTaskId === context.activeTaskId &&
        getWorkspaceKey(latest.workspacePath, latest.workspaceIdentity) ===
          getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      );
    };
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    if (context.group) {
      // Bug: subscribing for results before the old session cold-restores exhaustes retries; read authoritative state first,
      // then listen for future events so a finished request always has a consumer. Historical inputs are not committed here.
      await zcodeTaskService.getBotGroupTaskBlockReason?.({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      });
      // Startup recovery and the first input can race; reuse the subscription if the other path already built one.
      if (streamSubscriptions.has(streamSubscriptionKey)) return;
    }
    const automationGroupKey =
      actor.chatType === "group" && !context.group ? getBotConversationKey(actor) : null;
    const automationAuthorizationId = automationGroupKey
      ? (await repo.readState()).bots[automationGroupKey]?.group?.authorizationId
      : undefined;
    let disposed = false;
    let resultRunId = "";
    let resultSourceCommandId: string | undefined;
    let resultInputOrigin: "desktop" | "mobile" = "desktop";
    let resultPart = 0;
    let resultMentionedUserIds: string[] | undefined;
    const terminalRuns = new Set<string>();
    const sendTaskOutbound = async (
      targetBot: BotConfig,
      message: BotOutboundMessage,
    ): Promise<void> => {
      if (disposed && (context.group || persistentPrivate)) return;
      if (!(await isPrivateAuthorized())) return;
      if (privateDeliveryFailed) return;
      if (
        persistentPrivate &&
        bot.provider === "weixin" &&
        !imInteractionRun &&
        !(await deps.credentialService.load(weixinContextKey(bot, actor.providerUserId)))
      ) {
        privateDeliveryFailed = true;
        const locale = await readMessageLocale();
        onDeliveryResult(
          bot,
          locale === "en-US"
            ? "Send a message to the bot in Weixin, then retry."
            : "请在微信给机器人发一条消息后重试。",
        );
        return;
      }
      if (automationGroupKey) {
        const current = (await repo.readState()).bots[automationGroupKey]?.group;
        const currentBot = findBot(await repo.readConfig(), bot.id);
        if (
          !current?.enabled ||
          !currentBot?.enabled ||
          current.ownerId !== currentBot.providerUserId ||
          current.authorizationId !== automationAuthorizationId
        )
          return;
      }
      try {
        await sendOutbound(
          targetBot,
          context.group
            ? {
                ...message,
                groupTaskId: context.activeTaskId!,
                threadId: actor.threadId ?? context.group.threadId,
                rootMessageId: actor.rootMessageId ?? context.group.rootMessageId,
                conversationThreadId: actor.conversationThreadId,
                groupSourceCommandId: resultSourceCommandId,
                groupCard: groupCardFor(actor, context),
                replyToMessageId: actor.providerMessageId,
                mentionedUserIds:
                  message.mentionedUserIds ??
                  (message.selection || resultPart === 0 ? resultMentionedUserIds : undefined),
                ...(!message.selection && resultRunId
                  ? {
                      deliveryId: createHash("sha256")
                        .update(
                          JSON.stringify([
                            bot.id,
                            context.group.chatId,
                            context.activeTaskId,
                            resultRunId,
                            resultPart++,
                          ]),
                        )
                        .digest("hex"),
                    }
                  : {}),
                // Source stays in relation metadata; inlining it would add stray Desktop/Mobile Web tags.
                text: message.text,
              }
            : message,
          automationGroupKey
            ? async () => {
                const current = (await repo.readState()).bots[automationGroupKey]?.group;
                const currentBot = findBot(await repo.readConfig(), bot.id);
                return Boolean(
                  current?.enabled &&
                  currentBot?.enabled &&
                  current.ownerId === currentBot.providerUserId &&
                  current.authorizationId === automationAuthorizationId,
                );
              }
            : undefined,
        );
      } catch (error) {
        if (!persistentPrivate) throw error;
        privateDeliveryFailed = true;
      }
    };
    let assistantParts: ZCodeAssistantMessagePart[] = [];
    let assistantReplyBuffer = "";
    let sentAnyAssistantReply = false;
    const assistantPartToolIds = new Set<string>();
    const toolCalls = new Map<string, BotReplyToolCallState>();
    const sentToolCallReplyIds = new Set<string>();
    const getMode = () =>
      context.group || automationRun
        ? "summary_changes"
        : normalizeBotReplyGranularity(bot.provider, user.replyMode);
    let streamingCardHandle: BotStreamingReplyCardHandle | null = null;
    let streamingCardSegmentIndex = 0;
    const streamingCardBlocks: StreamingCardTimelineBlock[] = [];
    let streamingCardStatus: "running" | "sealed" | "completed" | "error" = "running";
    let streamingCardLastUpdateAt = 0;
    let streamingCardConsecutiveFailures = 0;
    let streamingCardNextAttemptAt = 0;
    let streamingCardCircuitOpen = false;
    let streamingCardQueue: Promise<void> = Promise.resolve();
    const supportsStreamingCardReply = () => {
      const adapter = providers[bot.provider];
      return (
        getMode() === "streaming_card" &&
        isFeishuBotProvider(bot.provider) &&
        Boolean(adapter?.createStreamingReplyCard) &&
        Boolean(adapter?.updateStreamingReplyCard)
      );
    };
    const buildStreamingToolSummaryTitle = (locale: Locale | undefined): string =>
      msg(locale, "streamingToolSummaries");
    const appendStreamingCardMessageChunk = (content: string): void => {
      if (!content) {
        return;
      }
      const lastBlock = streamingCardBlocks.at(-1);
      if (lastBlock?.type === "message") {
        lastBlock.text += content;
        return;
      }
      streamingCardBlocks.push({ type: "message", text: content });
    };
    const appendStreamingCardMessages = (messages: readonly string[]): void => {
      for (const message of messages.map((item) => item.trim()).filter(Boolean)) {
        const lastBlock = streamingCardBlocks.at(-1);
        if (lastBlock?.type === "message" && lastBlock.text.trim()) {
          lastBlock.text = `${lastBlock.text.trim()}\n\n${message}`;
        } else {
          streamingCardBlocks.push({ type: "message", text: message });
        }
      }
    };
    const hasStreamingCardMessageText = (): boolean =>
      streamingCardBlocks.some((block) => block.type === "message" && block.text.trim().length > 0);
    const appendStreamingCardTool = (toolId: string): void => {
      const existingBlock = streamingCardBlocks.find(
        (block) => block.type === "tools" && block.toolIds.includes(toolId),
      );
      if (existingBlock) {
        return;
      }
      const lastBlock = streamingCardBlocks.at(-1);
      if (lastBlock?.type === "tools") {
        lastBlock.toolIds.push(toolId);
        return;
      }
      streamingCardBlocks.push({ type: "tools", toolIds: [toolId] });
    };
    const buildStreamingCardBlocks = (locale: Locale | undefined): BotStreamingReplyCardBlock[] => {
      const toolSummaryTitle = buildStreamingToolSummaryTitle(locale);
      const latestToolBlockIndex = streamingCardBlocks.reduce(
        (latestIndex, block, index) => (block.type === "tools" ? index : latestIndex),
        -1,
      );
      const blocks: BotStreamingReplyCardBlock[] = [];
      for (const [index, block] of streamingCardBlocks.entries()) {
        if (block.type === "message") {
          const text = block.text.trim();
          if (text) {
            blocks.push({ type: "message", text });
          }
          continue;
        }
        const summaries = block.toolIds
          .map((toolId) => toolCalls.get(toolId))
          .filter((toolCall): toolCall is BotReplyToolCallState => Boolean(toolCall))
          .map((toolCall) =>
            formatBotToolCallSummaryLine(toolCall, {
              workspacePath: context.workspacePath,
              locale,
            }),
          );
        if (summaries.length === 0) {
          continue;
        }
        blocks.push({
          type: "tools",
          title: toolSummaryTitle,
          summaries,
          expanded: streamingCardStatus === "running" && index === latestToolBlockIndex,
        });
      }
      if (blocks.length === 0) {
        blocks.push({
          type: "message",
          text: msg(locale, "streamingWorking"),
        });
      }
      return blocks;
    };
    const syncStreamingCardReply = async (trigger: string, force = false): Promise<void> => {
      if (!supportsStreamingCardReply() || (persistentPrivate && privateCardDeliveryUnknown)) {
        return;
      }
      const now = Date.now();
      // Bugfix: the old code moved the time baseline only on success, so every Feishu failure fired a real request per stream event;
      // force also bypasses normal throttling. Backoff and the breaker must come before the force check or one 400 becomes a storm.
      if (streamingCardCircuitOpen || now < streamingCardNextAttemptAt) {
        return;
      }
      if (
        streamingCardHandle &&
        !force &&
        now - streamingCardLastUpdateAt < FEISHU_STREAMING_CARD_MIN_UPDATE_INTERVAL_MS
      ) {
        return;
      }
      const adapter = providers[bot.provider];
      const locale = await readMessageLocale();
      const state = {
        providerUserId: actor.providerUserId,
        locale,
        blocks: buildStreamingCardBlocks(locale),
        status: streamingCardStatus,
      };
      const states = adapter?.splitStreamingReplyCardStates?.(state) ?? [state];
      streamingCardQueue = streamingCardQueue
        .catch(() => undefined)
        .then(async () => {
          if (disposed || !(await isPrivateAuthorized())) return;
          let operation = streamingCardHandle ? "update" : "create";
          const requestController = new AbortController();
          streamingCardRequestControllers.add(requestController);
          const timeoutId = setTimeout(() => {
            requestController.abort(new Error("Feishu streaming card request timed out."));
          }, FEISHU_STREAMING_CARD_REQUEST_TIMEOUT_MS);
          try {
            for (
              let index = Math.min(streamingCardSegmentIndex, states.length - 1);
              index < states.length;
              index += 1
            ) {
              if (disposed || !(await isPrivateAuthorized())) return;
              const segmentState = states[index]!;
              operation = streamingCardHandle ? "update" : "create";
              const request = !streamingCardHandle
                ? adapter?.createStreamingReplyCard?.(bot, segmentState, requestController.signal)
                : adapter?.updateStreamingReplyCard?.(
                    bot,
                    streamingCardHandle,
                    segmentState,
                    requestController.signal,
                  );
              const result = await Promise.race([
                request,
                new Promise<never>((_, reject) => {
                  requestController.signal.addEventListener(
                    "abort",
                    () => reject(requestController.signal.reason),
                    { once: true },
                  );
                }),
              ]);
              if (!streamingCardHandle) {
                streamingCardHandle = result ?? null;
                if (!streamingCardHandle) {
                  // Root cause: Feishu create can return code=0 with no message_id. Treating that silent failure
                  // a success and advance segmentIndex, permanently skipping undelivered segments; route everything through backoff-retry.
                  throw new Error("Feishu create streaming card returned no message_id.");
                }
              }
              if (index < states.length - 1) {
                // Fix: once a card hits the Feishu element budget it must be sealed as a history segment,
                // Later blocks write only to the new card; never resend shown content or keep PATCHing the old message_id.
                streamingCardSegmentIndex = index + 1;
                streamingCardHandle = null;
              }
            }
            if (persistentPrivate) privateDeliveryFailed = false;
            streamingCardLastUpdateAt = Date.now();
            streamingCardConsecutiveFailures = 0;
            streamingCardNextAttemptAt = 0;
          } catch (error) {
            // Bugfix: third-party cards are best-effort; timeouts/failures must not block task_complete,
            // task_error or typing-cleanup lifecycle events.
            if (persistentPrivate) {
              privateDeliveryFailed = true;
              privateCardDeliveryUnknown = !isRecord(error) || error.deliveryRejected !== true;
            }
            streamingCardConsecutiveFailures += 1;
            const errorMessage = error instanceof Error ? error.message : String(error);
            onDeliveryResult(bot, errorMessage);
            if (
              streamingCardConsecutiveFailures >= FEISHU_STREAMING_CARD_FAILURE_CIRCUIT_THRESHOLD
            ) {
              streamingCardCircuitOpen = true;
              botsLogger.warn(
                undefined,
                `Feishu streaming card circuit opened task=${context.activeTaskId} trigger=${trigger} operation=${operation} failures=${streamingCardConsecutiveFailures}: ${errorMessage}`,
              );
            } else {
              const retryDelayMs =
                FEISHU_STREAMING_CARD_FAILURE_BACKOFF_BASE_MS *
                2 ** (streamingCardConsecutiveFailures - 1);
              streamingCardNextAttemptAt = Date.now() + retryDelayMs;
              botsLogger.warn(
                undefined,
                `Feishu streaming card sync failed task=${context.activeTaskId} trigger=${trigger} operation=${operation} failures=${streamingCardConsecutiveFailures} retryDelayMs=${retryDelayMs}: ${errorMessage}`,
              );
            }
          } finally {
            clearTimeout(timeoutId);
            streamingCardRequestControllers.delete(requestController);
          }
        });
      await streamingCardQueue;
    };
    const sealStreamingCardReply = async (): Promise<void> => {
      if (!streamingCardHandle) {
        return;
      }
      // Fix: agent output before a blocking interaction and the continuation after are two readable segments.
      // The old impl reused one message_id, wedging question/plan cards mid-stream while later body went to the old card.
      streamingCardStatus = "sealed";
      await syncStreamingCardReply("seal", true);
      streamingCardHandle = null;
      streamingCardSegmentIndex = 0;
      streamingCardBlocks.length = 0;
      streamingCardStatus = "running";
      streamingCardLastUpdateAt = 0;
    };
    const flushAssistantReplyBuffer = async (force = false) => {
      if (
        getMode() === "summary_changes" ||
        supportsStreamingCardReply() ||
        !assistantReplyBuffer
      ) {
        return;
      }
      const extracted = extractBotAssistantResponseMessages(assistantReplyBuffer, force);
      assistantReplyBuffer = extracted.rest;
      for (const text of extracted.messages) {
        sentAnyAssistantReply = true;
        await sendTaskOutbound(bot, createOutbound(actor, text));
      }
    };
    const handleStreamEventImpl = async (
      event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
      shouldBroadcast = true,
    ): Promise<void> => {
      if (disposed) return;
      if (event.type === "task_stream_mirror_batch") {
        if (shouldBroadcast) {
          await broadcastTaskStreamEvent(context, event);
        }
        // Bugfix: under shared hosts/remote control the UI receives workspace-level mirror batches.
        // The old path only recognized bare stream events: the UI streamed fine while the bot channel had nothing to send.
        for (const op of event.ops) {
          if (op.kind === "stream_event") {
            await handleStreamEvent(op.event, false);
          }
        }
        return;
      }
      if (
        typeof automation === "string" &&
        !persistentPrivate &&
        event.traceId !== automation &&
        event.inputId !== automation
      )
        return;
      if (persistentPrivate) {
        if (!(await isPrivateAuthorized())) return;
        const runId = event.inputId ?? event.traceId;
        if (event.type === "task_run_started") {
          if (runId && (terminalRuns.has(runId) || resultRunId === runId)) return;
          resultRunId = runId ?? "";
          privateDeliveryFailed = false;
          privateCardDeliveryUnknown = false;
          user = findBot(await repo.readConfig(), bot.id) ?? user;
          resultSourceCommandId = event.inputId;
          automationRun =
            automationRuns.delete(runId ?? "") ||
            automationRuns.delete(event.traceId) ||
            automationPending;
          automationPending = false;
          // Desktop/phone turns sync output only; a resident subscription must not add IM approval surfaces.
          imInteractionRun = privateImTraces.has(
            JSON.stringify([streamSubscriptionKey, event.traceId]),
          );
          assistantParts = [];
          assistantReplyBuffer = "";
          sentAnyAssistantReply = false;
          assistantPartToolIds.clear();
          toolCalls.clear();
          sentToolCallReplyIds.clear();
          streamingCardHandle = null;
          streamingCardBlocks.length = 0;
          streamingCardSegmentIndex = 0;
          streamingCardStatus = "running";
          streamingCardLastUpdateAt = 0;
          streamingCardConsecutiveFailures = 0;
          streamingCardNextAttemptAt = 0;
          streamingCardCircuitOpen = false;
        } else {
          if (runId && terminalRuns.has(runId)) return;
          if (!resultRunId && runId) resultRunId = runId;
          if (resultSourceCommandId && event.inputId && resultSourceCommandId !== event.inputId)
            return;
        }
        if (event.type === "task_complete" || event.type === "task_error") {
          if (runId) terminalRuns.add(runId);
          // continuous never replays old turns; the bounded window guards against duplicate terminals.
          if (terminalRuns.size > 128) terminalRuns.delete(terminalRuns.values().next().value!);
        }
        if (
          !imInteractionRun &&
          (event.type === "permission_request" || event.type === "elicitation_request")
        )
          return;
      }
      if (context.group) {
        const latest = (await repo.readState()).bots[getBotStateKey(context)];
        const currentBot = findBot(await repo.readConfig(), bot.id);
        if (
          !latest?.group?.enabled ||
          latest.activeTaskId !== context.activeTaskId ||
          latest.group.ownerId !== currentBot?.providerUserId ||
          !currentBot.enabled
        )
          return;
        // Old inputs can land late after continuation stops; they must not overwrite the new turn's cache, reactions, or targets.
        if (
          latest.group.threadId &&
          resultSourceCommandId &&
          event.inputId &&
          event.type !== "task_run_started" &&
          event.inputId !== resultSourceCommandId
        )
          return;
        if (event.type === "task_complete" || event.type === "task_error") {
          const terminalKey = event.inputId ?? event.traceId ?? resultRunId;
          if (terminalKey && terminalRuns.has(terminalKey)) return;
          if (terminalKey) terminalRuns.add(terminalKey);
        }
        if (event.type === "turn_steer_status" && event.status !== "drained") {
          for (const id of event.pendingInputIds ?? []) {
            const input = latest.group.inputs?.[id];
            if (!input || input.taskId !== context.activeTaskId) continue;
            await updateGroupInputReaction(
              bot,
              context,
              input.source.messageId,
              event.reason === "session_resumed" ? "discarded" : "cancelled",
            );
            // Topics no longer offer queue/steer; discard events on old runs only touch the input state and reaction.
            if (latest.group.threadId) continue;
            const locale = await readMessageLocale();
            const text =
              event.reason === "session_resumed"
                ? locale === "en-US"
                  ? "Queued input was discarded after runtime restart; it was not executed."
                  : "排队输入已在运行时重启后丢弃，未执行。"
                : locale === "en-US"
                  ? "Queued input was removed or rejected; it will not execute."
                  : "排队输入已删除或被拒绝，不会执行。";
            const inputActor: BotActor = {
              ...actor,
              providerUserId: input.source.senderId,
              providerMessageId: input.source.messageId,
              mentionedBot: input.source.mentionedBot,
              threadId: input.source.threadId ?? context.group.threadId,
              rootMessageId: input.source.rootMessageId ?? context.group.rootMessageId,
              conversationThreadId: context.group.threadId ?? null,
            };
            await sendOutbound(bot, {
              ...createOutbound(inputActor, text),
              groupTaskId: context.activeTaskId!,
              groupCard: groupCardFor(inputActor, context),
              replyToMessageId: input.source.messageId,
              deliveryId: createHash("sha256")
                .update(`${id}:${event.status}:${event.reason}`)
                .digest("hex"),
            });
          }
          return;
        }
        if (event.type === "task_run_started") resultInputOrigin = event.inputOrigin ?? "desktop";
        if (event.type === "task_run_started" || event.inputId) {
          const source = event.inputId ? latest.group.inputs?.[event.inputId]?.source : undefined;
          // Resolve from this turn's trusted input; sourceless desktop results or retries are never attributed to the owner/last speaker.
          const isTopicReply = !!(source?.threadId ?? latest.group.threadId);
          resultMentionedUserIds = source
            ? [
                ...new Set(
                  (source.messages ?? [source])
                    .filter((item) => !isTopicReply || item.mentionedBot === true)
                    .map((item) => item.senderId),
                ),
              ]
            : undefined;
          if (!resultMentionedUserIds?.length) resultMentionedUserIds = undefined;
          actor = {
            ...actor,
            providerUserId: source?.senderId ?? latest.group.ownerId,
            displayName:
              source?.senderName ?? (resultInputOrigin === "mobile" ? "Mobile Web" : "Desktop"),
            providerMessageId: source?.messageId,
            mentionedBot: source?.mentionedBot,
            threadId: source?.threadId ?? latest.group.threadId,
            rootMessageId: source?.rootMessageId ?? latest.group.rootMessageId,
            conversationThreadId:
              source?.threadId && source.threadId !== latest.group.threadId
                ? (latest.group.threadId ?? null)
                : undefined,
          };
          context.group = { ...latest.group, initiatorId: source?.senderId };
        }
        if (event.type === "task_run_started") {
          await updateGroupInputReaction(bot, context, actor.providerMessageId, "working");
          resultRunId = event.inputId ?? event.traceId;
          resultSourceCommandId = event.inputId;
          resultPart = 0;
          assistantParts = [];
          assistantReplyBuffer = "";
          sentAnyAssistantReply = false;
          assistantPartToolIds.clear();
          toolCalls.clear();
          sentToolCallReplyIds.clear();
          await writeContext(context, false, context.activeTaskId);
        }
      }
      if (context.group && !resultRunId) {
        resultRunId = event.inputId ?? event.traceId;
        resultSourceCommandId = event.inputId;
      }
      if (shouldBroadcast) {
        await broadcastTaskStreamEvent(context, event);
      }
      // Bugfix: third-party default replies must stream out with AssistantMessageResponse;
      // but /status progress still needs its own cache, immune to delivery granularity.
      updateLiveStatusProgress(event);
      if (event.type === "agent_message_chunk") {
        assistantParts = appendAssistantMessagePart(assistantParts, {
          type: "content",
          content: event.content,
        });
        if (supportsStreamingCardReply()) {
          appendStreamingCardMessageChunk(event.content);
          await syncStreamingCardReply(event.type, false);
          return;
        }
        if (getMode() !== "summary_changes") {
          assistantReplyBuffer += event.content;
          // Third-party messages are discrete bubbles; the formatter splits the buffer into sendable messages by length limits.
          await flushAssistantReplyBuffer(false);
        }
        return;
      }
      if (event.type === "agent_thought_chunk") {
        assistantParts = appendAssistantMessagePart(assistantParts, {
          type: "thought",
          content: event.content,
        });
      }
      if (event.type === "tool_call" || event.type === "tool_call_update") {
        if (supportsStreamingCardReply()) {
          appendStreamingCardTool(event.toolId);
        }
        if (!supportsStreamingCardReply()) {
          await flushAssistantReplyBuffer(true);
        }
        // Bugfix: summary_changes completion messages need the UI latestPart for reference.
        // tool_call_update can arrive without its opening tool_call frame; synthesize the part boundary like the UI does.
        if (!assistantPartToolIds.has(event.toolId)) {
          assistantPartToolIds.add(event.toolId);
          assistantParts = appendAssistantMessagePart(assistantParts, {
            type: "tool-call",
            toolId: event.toolId,
          });
        }
      }
      updateBotReplyToolCalls(toolCalls, event);
      if (event.type === "tool_call" && supportsStreamingCardReply()) {
        await syncStreamingCardReply(event.type, true);
      }
      if (event.type === "tool_call_update" && supportsStreamingCardReply()) {
        await syncStreamingCardReply(event.type, isBotToolCallReplyTerminal(event.status));
      }
      if (
        event.type === "tool_call_update" &&
        getMode() === "assistant_toolcalls_changes" &&
        isBotToolCallReplyTerminal(event.status) &&
        !sentToolCallReplyIds.has(event.toolId)
      ) {
        const toolCall = toolCalls.get(event.toolId);
        if (toolCall) {
          sentToolCallReplyIds.add(event.toolId);
          sentAnyAssistantReply = true;
          await sendTaskOutbound(
            bot,
            createOutbound(
              actor,
              formatBotToolCallReply(toolCall, {
                workspacePath: context.workspacePath,
                locale: await readMessageLocale(),
              }),
            ),
          );
        }
      }
      if (event.type === "permission_request") {
        const locale = await readMessageLocale();
        stopTyping(event.taskId);
        await sealStreamingCardReply();
        await broadcastTaskListChange(context, event.taskId, "permission_request", {
          permissionRequest: event,
        });
        // Bugfix: the UI normalizes raw permission options into a fixed allow/always-allow/deny order and copy;
        // Bots used to show the provider's raw English name plus an extra cancel button, so the same request looked different in Feishu and the UI.
        const permissionOptions = sortBotPermissionOptions(event.options);
        const permissionSelection: SelectionPrompt = {
          id: `permission-${event.requestId}`,
          title: formatBotPermissionRequestSummary(event, {
            locale,
            workspacePath: context.workspacePath,
          }),
          action: "permission.respond",
          showCancel: false,
          options: permissionOptions.map((option) => {
            const isDenyOption = isBotPermissionRejectOption(option);
            return {
              id: isDenyOption
                ? `/deny ${event.requestId}`
                : `/approve ${event.requestId} ${option.optionId}`,
              label: formatBotPermissionOptionLabel(option, locale),
              description: formatBotPermissionOptionDescription(option, event, locale),
            };
          }),
        };
        // Bugfix: Telegram callback_data caps at 64 bytes while real toolCallId/requestId can be longer.
        // so buttons return a short index and the real ids wait in the bot context for resolution.
        const pendingPermissionOptions = permissionOptions.map((option) => {
          const isDenyCommand = isBotPermissionRejectOption(option);
          return {
            requestId: event.requestId,
            optionId: option.optionId,
            command: isDenyCommand ? ("deny" as const) : ("approve" as const),
            label: formatBotPermissionOptionLabel(option, locale),
            response: option.response,
          };
        });
        Object.assign(context, { pendingPermissionOptions });
        await writeContext({ ...context, pendingPermissionOptions }, false, context.activeTaskId);
        const [permissionReply] = await createSelectionReply(
          actor,
          permissionSelection,
          await readMessageLocale(),
        );
        if (permissionReply) {
          if (shouldUseTransientInteractionCard(bot, user)) {
            // Reason: normalized Feishu group configs also hit the transient-card branch and must not skip the group-card grant fields.
            await upsertTransientInteractionCard(
              bot,
              actor,
              event.taskId,
              context.group
                ? {
                    ...permissionReply,
                    mentionedUserIds: adminAttention.mention(
                      actor,
                      bot.providerUserId,
                      `permission:${event.taskId}:${event.requestId}`,
                    ),
                    groupTaskId: context.activeTaskId!,
                    groupCard: groupCardFor(actor, context),
                  }
                : permissionReply,
            );
          } else {
            await sendTaskOutbound(
              bot,
              context.group
                ? administratorReply(
                    actor,
                    bot,
                    `permission:${event.taskId}:${event.requestId}`,
                    permissionReply,
                  )
                : permissionReply,
            );
          }
        }
        return;
      }
      if (event.type === "elicitation_request") {
        await sealStreamingCardReply();
        await handleElicitationRequest(bot, user, actor, context, event, resultMentionedUserIds);
        return;
      }
      if (event.type === "elicitation_response") {
        await clearPendingElicitationForRequest(context, event.requestId);
        await broadcastTaskListChange(context, event.taskId, "elicitation_resolved", {
          requestId: event.requestId,
        });
        return;
      }
      if (event.type === "task_complete" || event.type === "task_error") {
        if (context.group) {
          await updateGroupInputReaction(
            bot,
            context,
            actor.providerMessageId,
            event.type === "task_error"
              ? "failed"
              : /stop|cancel|interrupt|abort/iu.test(event.stopReason)
                ? "stopped"
                : "done",
          );
        }
        privateImTraces.delete(JSON.stringify([streamSubscriptionKey, event.traceId]));
        runningTasks.delete(event.taskId);
        liveStatusProgressByTaskId.delete(event.taskId);
        stopTyping(event.taskId);
        if (context.pendingElicitation?.taskId === event.taskId) {
          clearPendingElicitationSelection(context.pendingElicitation);
          await writeContext(
            { ...context, pendingElicitation: undefined },
            false,
            context.activeTaskId,
          );
        }
        const transientCard = transientInteractionCards.get(getActorContextKey(actor));
        if (transientCard?.taskId === event.taskId) {
          const pendingElicitation = context.pendingElicitation;
          await finalizeTransientInteractionCard(
            actor,
            pendingElicitation
              ? createCompletedElicitationOutbound(
                  actor,
                  pendingElicitation,
                  await readMessageLocale(),
                  "cancel",
                )
              : createOutbound(
                  actor,
                  event.type === "task_error"
                    ? msg(await readMessageLocale(), "taskFailed", {
                        message: event.error,
                      })
                    : msg(await readMessageLocale(), "received"),
                ),
          );
        }
        // Bugfix: ZCode Agent terminal events can broadcast to bots before task index/meta persists.
        // Updating the sidebar from stale meta then refreshing to terminal meta makes the status/summary visibly jump.
        // so briefly re-read a stable meta before the terminal broadcast, folding the UI delta into one frame when possible.
        const completedTask = await readTerminalTaskMeta(context, event.taskId, event.type).catch(
          () => null,
        );
        await broadcastTaskListChange(
          context,
          event.taskId,
          event.type === "task_error" ? "error" : "completed",
          {
            ...(completedTask ? { task: completedTask } : {}),
            ...(event.type === "task_error" ? { error: event.error } : {}),
          },
        );
        if (!context.group && !persistentPrivate) {
          streamSubscriptions.get(streamSubscriptionKey)?.dispose();
          streamSubscriptions.delete(streamSubscriptionKey);
        }
        if (event.type === "task_error") {
          if (supportsStreamingCardReply()) {
            streamingCardStatus = "error";
            if (!hasStreamingCardMessageText()) {
              appendStreamingCardMessages([
                msg(await readMessageLocale(), "taskFailed", {
                  message: event.error,
                }),
              ]);
            }
            await syncStreamingCardReply(event.type, true);
            return;
          }
          await sendTaskOutbound(
            bot,
            createOutbound(
              actor,
              msg(await readMessageLocale(), "taskFailed", {
                message: event.error,
              }),
            ),
          );
          return;
        }

        if (context.group && /stop|cancel|interrupt|abort/iu.test(event.stopReason)) {
          // Stop notices make other bots reply; mute both main chat and topics while keeping the earlier state cleanup.
          return;
        }
        const mode = getMode();
        const locale = await readMessageLocale();
        const completedSnapshot = await zcodeTaskService
          .getTaskSnapshot({
            taskId: event.taskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          .catch(() => null);
        const latestTurnChangeSummary = readLatestAssistantTurnChangeSummary(completedSnapshot);
        if (supportsStreamingCardReply()) {
          const changeSummaryMessages = formatBotAssistantReplyBlocks(
            createAssistantReplyBlocks([], new Map(), mode, latestTurnChangeSummary),
            {
              workspacePath: context.workspacePath,
              locale,
            },
          );
          if (changeSummaryMessages.length > 0) {
            appendStreamingCardMessages(changeSummaryMessages);
          }
          streamingCardStatus = "completed";
          await syncStreamingCardReply(event.type, true);
          sentAnyAssistantReply = true;
          return;
        }
        let replyMessages: string[] = [];
        if (mode === "summary_changes") {
          const replyBlocks = createAssistantReplyBlocks(
            assistantParts,
            toolCalls,
            mode,
            latestTurnChangeSummary,
          );
          replyMessages = formatBotAssistantReplyBlocks(replyBlocks, {
            workspacePath: context.workspacePath,
            locale,
          });
        } else {
          await flushAssistantReplyBuffer(true);
          const changeSummaryBlocks = createAssistantReplyBlocks(
            [],
            new Map(),
            mode,
            latestTurnChangeSummary,
          );
          replyMessages = formatBotAssistantReplyBlocks(changeSummaryBlocks, {
            workspacePath: context.workspacePath,
            locale,
          });
        }
        if (replyMessages.length === 0 && !sentAnyAssistantReply) {
          const source = resultSourceCommandId
            ? context.group?.inputs?.[resultSourceCommandId]?.source
            : undefined;
          // No-@ follow-ups may exclude the model; empty output must not be laundered into an answer by the completed fallback.
          if (
            context.group?.threadId &&
            source?.botIdentity &&
            source.mentionedBot === false &&
            !source.messages?.some((message) => message.mentionedBot === true)
          )
            return;
          await sendTaskOutbound(
            bot,
            createOutbound(actor, locale === "en-US" ? "Task completed." : "任务已完成。"),
          );
          return;
        }
        for (const text of replyMessages) {
          sentAnyAssistantReply = true;
          await sendTaskOutbound(bot, createOutbound(actor, text));
        }
      }
    };
    const handleStreamEvent = async (
      event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
      shouldBroadcast = true,
    ): Promise<void> => {
      try {
        await handleStreamEventImpl(event, shouldBroadcast);
      } finally {
        if (
          persistentPrivate &&
          privateDeliveryFailed &&
          (event.type === "task_complete" || event.type === "task_error") &&
          (await isPrivateAuthorized())
        ) {
          const locale = await readMessageLocale();
          const texts = formatBotAssistantReplyBlocks(
            createAssistantReplyBlocks(assistantParts, toolCalls, "assistant_changes", undefined),
            { workspacePath: context.workspacePath, locale },
          );
          const text =
            texts.join("\n\n") ||
            (event.type === "task_error" ? event.error : msg(locale, "received"));
          const id = randomUUID();
          privateDeliveryFailed = false;
          failedPrivateDeliveries.set(bot.id, {
            id,
            bindingId,
            taskId: context.activeTaskId!,
            message: createOutbound(actor, text),
            sending: false,
          });
          const runtime = runtimeByBotId.get(bot.id);
          setRuntimeStatus({
            botId: bot.id,
            provider: bot.provider,
            status: runtime?.status ?? "idle",
            deliveryRetryId: id,
          });
        }
      }
    };
    let streamEventQueue: Promise<void> = Promise.resolve();
    const enqueueStreamEvent = (
      event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
    ): Promise<void> => {
      const shouldBroadcast = !forwardedTaskEvents.has(event);
      forwardedTaskEvents.add(event);
      const nextStreamEvent = streamEventQueue.then(() =>
        handleStreamEvent(event, shouldBroadcast),
      );
      // Bugfix: ZCode Agent event dispatch does not await async listeners. Discrete channels like WeCom sending concurrently
      // task_complete's change summary can reach the client before earlier body flushes, so consume per task serially.
      streamEventQueue = nextStreamEvent.catch((error: unknown) => {
        botsLogger.warn(
          event.traceId,
          `bot task stream event failed task=${event.taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      return streamEventQueue;
    };
    const dynamicTaskEvent = (
      zcodeTaskService as Partial<Pick<IZCodeTaskService, "onDynamicTaskEvent">>
    ).onDynamicTaskEvent;
    // Bugfix: remote-control/shared-host setups fan stream events out via workspace+task mirrors.
    // Prefer workspace-level events here; a local taskId relay alone misses channel replies.
    const streamDisposable = taskStreamHub.add(
      JSON.stringify([
        getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
        context.activeTaskId,
      ]),
      streamSubscriptionKey,
      (receive) =>
        dynamicTaskEvent
          ? dynamicTaskEvent({
              workspacePath: context.workspacePath,
              workspaceIdentity: context.workspaceIdentity,
              taskId: context.activeTaskId!,
              // Bugfix: the bot channel uses direct stream semantics.
              // Phone remote-control replayable mirror replay/snapshot gap recovery moves bot reply boundaries,
              // Use the bot-dedicated continuous subscription so remote-control recovery never touches Feishu/WeCom channels.
              deliveryKind: "bot-channel-continuous",
            })(receive)
          : zcodeTaskService.onDynamicStreamEvent(context.activeTaskId!)(receive),
      enqueueStreamEvent,
    );
    streamSubscriptions.set(streamSubscriptionKey, {
      imInput() {
        if (!resultRunId) imInteractionRun = true;
      },
      automation(runId) {
        if (runId) automationRuns.add(runId);
        else {
          automationPending = true;
          if (!resultRunId) automationRun = true;
        }
      },
      dispose() {
        disposed = true;
        streamDisposable.dispose();
      },
    });
    if (!context.group && !persistentPrivate) startTyping(bot, actor, context.activeTaskId);
  }

  async function createSelectionReply(
    actor: BotActor,
    selection: SelectionPrompt,
    locale?: Locale,
    extras: Pick<BotOutboundMessage, "elicitation" | "locale"> = {},
  ): Promise<BotOutboundMessage[]> {
    const markedSelection = markCurrentSelection(selection, locale);
    // Bugfix: WeCom has no native option cards, only numbered plain text.
    // The plain-text fallback used to show the current marker in both the title and the options,
    // WeCom replies read like duplicate status copy; the title explains state and the list keeps only answerable indexes.
    const supportsStructuredSelection = actor.provider !== "weixin";
    // Bugfix: WeCom /model picks the provider first; reusing description used to cram the model list into the same line,
    // two levels before any provider was picked. Text channels show the provider first and defer models a level.
    const textSelection = stripModelProviderDescriptionsForTextSelection(selection);
    const displaySelection = supportsStructuredSelection
      ? markedSelection
      : { ...textSelection, cancelLabel: markedSelection.cancelLabel };
    pendingSelectionsByContext.set(getActorContextKey(actor), displaySelection);
    // Other providers keep the selection so Telegram/Feishu/Lark render native options and Webhooks receive structured ones.
    const text = supportsStructuredSelection
      ? displaySelection.title
      : formatSelectionFallback(displaySelection, locale);
    return [
      createOutbound(actor, text, supportsStructuredSelection ? displaySelection : undefined, {
        ...extras,
        locale,
      }),
    ];
  }

  async function handleSelectionCancel(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const locale = await readMessageLocale();
    const actorContextKey = getActorContextKey(message.actor);
    const pendingSelection = pendingSelectionsByContext.get(actorContextKey);
    if (message.actor.chatType === "group") {
      const auth = await withAuthorizedContext(message, "message");
      if (!auth.ok) return auth.reply;
      clearPendingSelection(message.actor);
      return createStatusReply(message.actor, auth.context, locale);
    }
    if (pendingSelection?.action === "elicitation.respond") {
      const auth = await withAuthorizedContext(message, "message");
      if (!auth.ok) return auth.reply;
      const pending = auth.context.pendingElicitation;
      if (!pending) {
        clearPendingSelection(message.actor);
        return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
      }
      clearPendingSelection(message.actor);
      return submitPendingElicitation(auth, message.actor, pending, "cancel");
    }
    if (!pendingSelectionsByContext.has(actorContextKey)) {
      const auth = await withAuthorizedContext(message, "message");
      if (auth.ok && auth.context.pendingElicitation) {
        return submitPendingElicitation(
          auth,
          message.actor,
          auth.context.pendingElicitation,
          "cancel",
        );
      }
      return [createOutbound(message.actor, msg(locale, "unknownCommand", { command: "0" }))];
    }
    clearPendingSelection(message.actor);
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    return createStatusReply(message.actor, auth.context, auth.locale);
  }

  function buildRemoteReconnectCommandKey(
    actor: BotActor,
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity">,
  ): string {
    return [
      actor.botId,
      actor.provider,
      actor.chatId ?? actor.providerUserId,
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
    ].join("::");
  }

  function buildRemoteReconnectDeliveryKey(message: BotInboundMessage): string | null {
    const providerMessageId = message.actor.providerMessageId?.trim();
    if (!providerMessageId) {
      return null;
    }
    return [
      message.actor.botId,
      message.actor.provider,
      message.actor.chatId ?? message.actor.providerUserId,
      providerMessageId,
    ].join("::");
  }

  function pruneRecentRemoteReconnectDeliveryDedupe(now: number): void {
    for (const [key, at] of recentRemoteReconnectDeliveryAtByKey) {
      if (now - at >= REMOTE_RECONNECT_DELIVERY_DEDUPE_TTL_MS) {
        recentRemoteReconnectDeliveryAtByKey.delete(key);
      }
    }
  }

  async function performRemoteReconnect(
    message: BotInboundMessage,
    auth: Extract<Awaited<ReturnType<typeof withAuthorizedContext>>, { ok: true }>,
  ): Promise<BotOutboundMessage[]> {
    let result: BotRemoteWorkspaceReconnectResult;
    try {
      result = await reconnectRemoteWorkspaceForBot(auth.context);
    } catch (error) {
      result = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!result.ok) {
      return [
        administratorReply(
          message.actor,
          auth.bot,
          "remote",
          createOutbound(
            message.actor,
            msg(auth.locale, "remoteReconnectFailed", {
              workspacePath: auth.context.workspacePath,
              message: result.message ?? "unknown",
            }),
          ),
        ),
      ];
    }
    adminAttention.clear(message.actor, auth.bot.providerUserId, "remote");
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      const draftOptions = await buildInitializedDraftOptions(auth.context);
      await writeContext({ ...auth.context, draftOptions });
    }
    await reconcilePrivateSynchronization(auth.context.botId);
    // After a successful reconnect, return the full state so the completion copy and /status never diverge.
    return createStatusReply(message.actor, auth.context, auth.locale);
  }

  async function handleReconnect(
    message: BotInboundMessage,
    options: {
      onReconnectStart?: (
        auth: Extract<Awaited<ReturnType<typeof withAuthorizedContext>>, { ok: true }>,
      ) => Promise<void>;
    } = {},
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "workspace");
    if (!auth.ok) return auth.reply;
    if (!auth.context.workspaceIdentity) {
      return [createOutbound(message.actor, msg(auth.locale, "remoteReconnectLocal"))];
    }
    if (!deps.remoteWorkspaceService) {
      return [
        createOutbound(
          message.actor,
          msg(auth.locale, "remoteReconnectUnavailable", {
            workspacePath: auth.context.workspacePath,
          }),
        ),
      ];
    }

    const now = Date.now();
    pruneRecentRemoteReconnectDeliveryDedupe(now);
    const deliveryKey = buildRemoteReconnectDeliveryKey(message);
    if (deliveryKey && recentRemoteReconnectDeliveryAtByKey.has(deliveryKey)) {
      return [];
    }
    if (deliveryKey) {
      // Bugfix: Feishu/WeCom/Telegram can all redeliver the same provider message.
      // /reconnect has side effects and must be idempotent by provider message id before execution,
      // or redelivery hits the connected branch again and the user sees duplicate success toasts.
      recentRemoteReconnectDeliveryAtByKey.set(deliveryKey, now);
    }

    const reconnectKey = buildRemoteReconnectCommandKey(message.actor, auth.context);
    const pendingReconnect = pendingRemoteReconnectsByKey.get(reconnectKey);
    if (pendingReconnect) {
      await pendingReconnect.catch(() => []);
      return [];
    }
    const recentReconnectAt = recentRemoteReconnectAtByKey.get(reconnectKey);
    if (
      recentReconnectAt !== undefined &&
      now - recentReconnectAt < REMOTE_RECONNECT_DEDUPE_TTL_MS
    ) {
      return [];
    }
    if (await isRemoteWorkspaceConnected(auth.context)) {
      return createStatusReply(message.actor, auth.context, auth.locale);
    }

    // Bugfix: providers like Feishu/Lark/Webhook can redeliver the same /reconnect within seconds.
    // /reconnect has side effects and must be idempotent per bot+user+workspace or "connected" and "reconnecting" states will fight.
    const reconnectPromise = (async () => {
      if (options.onReconnectStart) {
        try {
          await options.onReconnectStart(auth);
        } catch (error) {
          // Bugfix: "reconnecting" is a transient notice; its send failure must not abort the real reconnect.
          botsLogger.warn(
            undefined,
            `send reconnect starting failed provider=${message.actor.provider} bot=${message.botId} user=${message.actor.providerUserId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return performRemoteReconnect(message, auth);
    })();
    pendingRemoteReconnectsByKey.set(reconnectKey, reconnectPromise);
    try {
      const replies = await reconnectPromise;
      recentRemoteReconnectAtByKey.set(reconnectKey, Date.now());
      return replies;
    } finally {
      pendingRemoteReconnectsByKey.delete(reconnectKey);
    }
  }

  async function withAuthorizedContext(
    message: BotInboundMessage,
    requestedCommand: BotAuthorizedCommand,
  ): Promise<
    | {
        ok: true;
        config: BotsConfigFile;
        bot: BotConfig;
        user: BotConfig;
        context: BotContextState;
        locale: Locale | undefined;
      }
    | { ok: false; reply: BotOutboundMessage[] }
  > {
    const locale = await readMessageLocale();
    const config = await repo.readConfig();
    const bot = findAuthorizedBot(config, message.actor);
    if (!bot || bot.id !== message.botId) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "botDisabled"))],
      };
    }
    if (message.actor.chatType !== "private" && !isFeishuBotProvider(bot.provider)) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "privateChatOnly"))],
      };
    }
    const groupContext =
      message.actor.chatType === "group" ? await readContext(message.actor, bot) : null;
    if (message.actor.chatType === "group") {
      if (!groupContext?.group?.enabled || groupContext.group.ownerId !== bot.providerUserId) {
        return {
          ok: false,
          reply: [
            {
              ...administratorReply(
                message.actor,
                bot,
                "group-disabled",
                createOutbound(message.actor, msg(locale, "groupNotEnabled")),
              ),
              callbackToastOnly: true,
            },
          ],
        };
      }
      if (message.groupCard || message.groupCardAction) {
        const card = message.groupCard;
        if (
          !card ||
          card.chatId !== groupContext.group.chatId ||
          card.threadId !== message.actor.threadId ||
          getBotConversationKey({ botId: bot.id, chatType: "group", ...card }) !==
            getBotStateKey(groupContext) ||
          card.taskId !== groupContext.activeTaskId ||
          card.authorizationId !== groupContext.group.authorizationId
        ) {
          return {
            ok: false,
            reply: [
              {
                ...createOutbound(message.actor, msg(locale, "elicitationExpired")),
                callbackToastOnly: true,
              },
            ],
          };
        }
      }
      adminAttention.clear(message.actor, bot.providerUserId, "group-disabled");
      if (
        requestedCommand === "reply" ||
        (isGroupOwnerCommand(requestedCommand) &&
          message.actor.providerUserId !== bot.providerUserId)
      ) {
        return {
          ok: false,
          reply: [
            {
              ...(requestedCommand === "reply"
                ? createOutbound(message.actor, msg(locale, "groupOwnerOnly"))
                : administratorReply(
                    message.actor,
                    bot,
                    requestedCommand === "approve" && groupContext.pendingPermissionOptions?.[0]
                      ? `permission:${groupContext.activeTaskId}:${groupContext.pendingPermissionOptions[0].requestId}`
                      : "owner-command",
                    createOutbound(message.actor, msg(locale, "groupOwnerOnly")),
                  )),
              callbackToastOnly: true,
            },
          ],
        };
      }
    }
    if (
      groupContext &&
      message.actor.providerUserId === bot.providerUserId &&
      isGroupOwnerCommand(requestedCommand)
    ) {
      adminAttention.clear(message.actor, bot.providerUserId, "owner-command");
    }
    const user = groupContext
      ? {
          ...bot,
          currentOptions: groupContext.group!.currentOptions,
          replyMode: "summary_changes" as const,
        }
      : findBoundUser(bot, message.actor);
    if (!user) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "userNotBound"))],
      };
    }
    if (!isUserCommandAllowed(user, requestedCommand)) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "commandNotAllowed"))],
      };
    }
    if (groupContext?.group) {
      const parsed = parseBotCommand(message.commandText ?? message.text);
      const isAnswer =
        message.senderType !== "app" &&
        (Boolean(message.elicitationResponse) ||
          parsed.type === "elicitation.respond" ||
          parsed.type === "elicitation.submit");
      if (
        isAnswer &&
        !canAnswerGroupQuestion(
          message.actor.providerUserId,
          groupContext.group.ownerId,
          groupContext.group.initiatorId,
          groupContext.pendingElicitation?.renderContext?.kind === "plan_approval",
        )
      ) {
        return {
          ok: false,
          reply: [
            {
              ...(groupContext.pendingElicitation?.renderContext?.kind === "plan_approval"
                ? administratorReply(
                    message.actor,
                    bot,
                    `plan:${groupContext.activeTaskId}:${groupContext.pendingElicitation.requestId}`,
                    createOutbound(message.actor, msg(locale, "groupOwnerOnly")),
                  )
                : createOutbound(message.actor, msg(locale, "groupOwnerOnly"))),
              callbackToastOnly: true,
            },
          ],
        };
      }
    }
    const context = groupContext ?? (await readContext(message.actor, bot));
    if (!context) {
      return {
        ok: false,
        reply: [
          administratorReply(
            message.actor,
            bot,
            "workspace",
            createOutbound(message.actor, msg(locale, "noWorkspaceAllowed")),
          ),
        ],
      };
    }
    const synced = context.group
      ? { config, bot, user }
      : await normalizeBotWorkspaceConfig(config, bot, {
          id:
            context.workspaceId ??
            getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
          label: getWorkspaceLabel(context.workspacePath),
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
        });
    if (
      context.workspaceId &&
      !isWorkspaceAllowed(context.workspaceId, synced.user.allowedWorkspaces)
    ) {
      return {
        ok: false,
        reply: [
          administratorReply(
            message.actor,
            bot,
            "workspace",
            createOutbound(message.actor, msg(locale, "workspaceOutOfScope")),
          ),
        ],
      };
    }
    const remoteDisconnectedReply = await blockDisconnectedRemoteWorkspace({
      message,
      context,
      locale,
      requestedCommand,
    });
    if (remoteDisconnectedReply) {
      return { ok: false, reply: remoteDisconnectedReply };
    }
    if (isFeishuBotProvider(bot.provider) && !context.group) {
      // Bugfix: short-command typing on Feishu is now removed explicitly once the sync reply lands.
      // Wait for the reaction to exist or stopInboundTyping may run first, stranding an unremovable Typing reaction.
      await sendTyping(bot, message.actor);
    } else if (!context.group) {
      void sendTyping(bot, message.actor);
    }
    return {
      ok: true,
      config: synced.config,
      bot: synced.bot,
      user: groupContext ? user : synced.user,
      context,
      locale,
    };
  }

  async function handleBind(
    message: BotInboundMessage,
    code: string,
  ): Promise<BotOutboundMessage[]> {
    const locale = await readMessageLocale();
    if (message.actor.chatType !== "private") {
      return [createOutbound(message.actor, msg(locale, "bindPrivateOnly"))];
    }
    const record = bindCodes.get(code.trim().toUpperCase());
    if (!record || record.expiresAt <= Date.now() || record.botId !== message.botId) {
      return [createOutbound(message.actor, msg(locale, "bindCodeInvalid"))];
    }
    const config = await repo.readConfig();
    const bot = findBot(config, record.botId);
    if (!bot) {
      return [createOutbound(message.actor, msg(locale, "bindBotMissing"))];
    }
    // Since bot configs, /bind binds only the current bot and no longer appends allowedUsers.
    // Rebinding overwrites the old providerUserId so a bot has exactly one counterpart at a time.
    const nextBot: BotConfig = {
      ...bot,
      providerUserId: message.actor.providerUserId,
      displayName: message.actor.displayName,
      allowedWorkspaces: normalizeAllowedWorkspaces(record.allowedWorkspaces),
      allowedCommands: normalizeBotCommandPolicy(bot.allowedCommands),
      replyMode: normalizeBotReplyGranularity(bot.provider, bot.replyMode),
    };
    validateBotConfig(config, nextBot);
    await writeBotConfig({
      ...config,
      bots: config.bots.map((item) => (item.id === nextBot.id ? nextBot : item)),
    });
    bindCodes.delete(record.code);
    return [
      createOutbound(
        message.actor,
        [msg(locale, "bindSuccess"), buildHelpText(locale, nextBot)].join("\n\n"),
      ),
    ];
  }

  async function handleStatus(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "status");
    if (!auth.ok) {
      return auth.reply;
    }
    // In-group /status shares the sanitized path with post-config status replies, keeping absolute paths out of a separate branch.
    return createStatusReply(message.actor, auth.context, auth.locale);
  }

  async function createStatusReply(
    actor: BotActor,
    context: BotContextState,
    locale: Locale | undefined,
  ): Promise<BotOutboundMessage[]> {
    return [
      createOutbound(
        actor,
        context.group
          ? (await buildStatusText(context, locale))
              .split(context.workspacePath)
              .join(getWorkspaceLabel(context.workspacePath))
          : await buildStatusText(context, locale),
        undefined,
        {
          locale,
        },
      ),
    ];
  }

  function formatStatusLine(
    locale: Locale | undefined,
    labelId: BotMessageId,
    value: string,
  ): string {
    // Bugfix: /status copy is assembled in the service layer; labels and values follow the bot's locale.
    return `${msg(locale, labelId)}: ${value}`;
  }

  function formatStatusStateValue(locale: Locale | undefined, state: string): string {
    if (locale === "en-US") {
      return state;
    }
    switch (state) {
      case "draft":
        return msg(locale, "statusDraft");
      case "remote disconnected":
        return msg(locale, "statusRemoteDisconnected");
      case "running":
        return msg(locale, "streamingStatusRunning");
      case "completed":
        return msg(locale, "streamingStatusCompleted");
      case "error":
      case "failed":
        return msg(locale, "streamingStatusFailed");
      case "cancelled":
        return msg(locale, "statusCancelled");
      case "stopped":
        return msg(locale, "statusStopped");
      default:
        return state;
    }
  }

  async function buildStatusText(
    context: BotContextState,
    locale: Locale | undefined,
  ): Promise<string> {
    const workspace = (await listWorkspaceRefs()).find((item) => item.id === context.workspaceId);
    if (!(await isRemoteWorkspaceConnected(context))) {
      const draftOptions = context.draftOptions;
      return [
        formatStatusLine(locale, "statusWorkspace", workspace?.label ?? context.workspacePath),
        formatStatusLine(
          locale,
          "statusModel",
          await formatStatusModelLabel(
            formatBotModelSelectionValue(draftOptions?.modelSelection),
            context,
          ),
        ),
        "------",
        formatStatusLine(locale, "statusTask", context.activeTaskId ?? msg(locale, "statusDraft")),
        formatStatusLine(
          locale,
          "statusState",
          formatStatusStateValue(locale, "remote disconnected"),
        ),
        msg(locale, "remoteDisconnectedStatus", {
          workspacePath: context.workspacePath,
        }),
      ].join("\n");
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    const tasks = await zcodeTaskService.listTasks({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    const activeTask = context.activeTaskId
      ? tasks.find((task) => task.taskId === context.activeTaskId)
      : null;
    const activeTaskSnapshot = context.activeTaskId
      ? await zcodeTaskService
          .getTaskSnapshot({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          .catch(() => null)
      : null;
    // Bugfix: activeTaskId comes from bot context and must not assume listTasks returns that task.
    // Under some filter/index timings listTasks misses the active task and snapshot was skipped, leaving Progress permanently blank.
    const statusTask = activeTask ?? activeTaskSnapshot?.meta ?? null;
    // Bugfix: after completion /status keeps only the final state so the last tool/thought tick is not read as still running.
    const latestProgress =
      context.activeTaskId && (!statusTask || taskStatus(statusTask) === "running")
        ? (liveStatusProgressByTaskId.get(context.activeTaskId)?.text ??
          readLatestTaskProgress(activeTaskSnapshot))
        : null;
    const workedDurationMs = statusTask
      ? readTaskWorkedDurationMs(activeTaskSnapshot, statusTask)
      : null;
    const activeTaskConfigOptions = context.activeTaskId
      ? await listActiveTaskConfigOptions(context, context.activeTaskId)
      : [];
    const isDraftStatus = context.mode === "draft" || !context.activeTaskId;
    const draftOptions = !statusTask && isDraftStatus ? await ensureDraftOptions(context) : null;
    // The bot draft is Select-only: without a pinned model, show the target host's current preferred model and never write defaults back.
    const draftView = draftOptions
      ? await readModelSelectionView(context, draftOptions.modelSelection)
      : null;
    const draftEffectiveSelection = draftOptions?.modelSelection
      ? draftView?.effectiveSelection
      : draftView?.preferredSelection;
    const statusModel =
      readConfigSelectCurrentValue(activeTaskConfigOptions, "model") ??
      statusTask?.model ??
      formatBotModelSelectionValue(draftEffectiveSelection ?? undefined) ??
      "-";
    const statusModelLabel = await formatStatusModelLabel(statusModel, context);
    return (
      [
        formatStatusLine(locale, "statusWorkspace", workspace?.label ?? context.workspacePath),
        // Bugfix: active tasks show real task state; draft state shows draftOptions.
        // After /new the draft inherits the current task; keeping "-" would look like a failed inheritance.
        formatStatusLine(locale, "statusModel", statusModelLabel),
        "------",
        statusTask
          ? formatStatusTaskLine(statusTask, msg(locale, "statusTask"))
          : formatStatusLine(locale, "statusTask", msg(locale, "statusDraft")),
        formatStatusLine(
          locale,
          "statusState",
          formatStatusStateValue(locale, statusTask ? taskStatus(statusTask) : "draft"),
        ),
        workedDurationMs !== null
          ? formatStatusLine(locale, "statusWorked", formatTaskRunningDuration(workedDurationMs))
          : null,
        latestProgress ? formatStatusLine(locale, "statusProgress", latestProgress) : null,
      ].filter(Boolean) as string[]
    ).join("\n");
  }

  async function handleHelp(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "help");
    if (!auth.ok) {
      return auth.reply;
    }
    return [
      createOutbound(
        message.actor,
        buildHelpText(
          auth.locale,
          auth.bot,
          auth.context.group
            ? message.actor.providerUserId === auth.context.group.ownerId
              ? "owner"
              : "member"
            : undefined,
        ),
      ),
    ];
  }

  function buildHelpText(
    locale: Locale | undefined,
    bot: Pick<BotConfig, "allowedCommands">,
    groupRole?: "owner" | "member",
  ): string {
    const lines = [msg(locale, "helpTitle")];
    if (groupRole) {
      lines.push(
        locale === "en-US"
          ? "Mention this bot to submit a request. /answer answers your active question."
          : "@当前机器人提交需求；/answer 回答自己发起请求中的问题。",
      );
      if (groupRole === "owner") {
        lines.push("/enable · /disable · /task · /stop · /approve · /deny · /reconnect");
        if (bot.allowedCommands.workspace !== false) lines.push("/history on|off");
      }
    }
    for (const command of BOT_MENU_COMMAND_ORDER) {
      if (
        groupRole &&
        (command === "bind" ||
          command === "reply" ||
          (groupRole === "member" && command !== "help" && command !== "status"))
      )
        continue;
      if (command === "help" || command === "bind") {
        lines.push(msg(locale, helpMessageByCommand[command]));
        continue;
      }
      if (bot.allowedCommands[command] === false) {
        continue;
      }
      lines.push(msg(locale, helpMessageByCommand[command]));
    }
    return lines.join("\n");
  }

  function historyGeneration(context: BotContextState): string {
    const groupKey = JSON.stringify([context.botId, context.group?.chatId]);
    return `${botHistoryEpoch.get(context.botId) ?? 0}:${groupHistoryEpoch.get(groupKey) ?? 0}:${context.group?.backgroundHistory?.revision ?? ""}`;
  }

  async function prepareGroupTopicHistory(
    bot: BotConfig,
    message: BotInboundMessage,
    context: BotContextState,
  ) {
    const messageId = message.actor.providerMessageId!;
    if (!context.group) return {};
    let topicContext: import("@zcode/shared").BotTopicHistoryBatch | undefined;
    let historyError: unknown;

    const generation = historyGeneration(context);
    // Pin the revision before the async history read; context arriving during the wait is not yet-read material.
    const backgroundRevision = context.group.backgroundHistory?.revision;
    let historyDisabled = false;
    const inputThreadId = message.actor.threadId ?? context.group.threadId;
    const inputRootMessageId = message.actor.rootMessageId ?? context.group.rootMessageId;
    if (inputThreadId) {
      const parent = (await repo.readState()).bots[
        getBotConversationKey({
          botId: bot.id,
          chatType: "group",
          chatId: context.group.chatId,
        })
      ];
      historyDisabled = parent?.group?.historyEnabled === false;
      if (!historyDisabled && topicHistoryReady.get(getBotStateKey(context)) !== generation) {
        const accepted = Object.values(context.group.inputs ?? {}).filter(
          (input) => input.admission === "accepted" && input.source.threadId === inputThreadId,
        );
        const checkpoint = context.group.backgroundHistory
          ? context.group.backgroundHistory.checkpoint
          : accepted.at(-1)?.source.messageId;
        try {
          const reader = providers[bot.provider]?.readTopicHistory;
          if (!reader || !inputRootMessageId) throw new Error("Topic history reader unavailable");
          topicContext = await reader(bot, {
            chatId: context.group.chatId,
            threadId: inputThreadId,
            rootMessageId: inputRootMessageId,
            messageId,
            checkpoint,
          });
          const ingested = new Set(
            accepted.flatMap(
              (input) =>
                input.source.messages?.map((original) => original.messageId) ?? [
                  input.source.messageId,
                ],
            ),
          );
          topicContext.messages = topicContext.messages.filter(
            (item) => !ingested.has(item.id) && item.id !== message.referencedMessage?.messageId,
          );
        } catch (error) {
          botsLogger.warn(
            undefined,
            `topic history preparation failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Read failures block submission; never start a task with gap-filled attachments standing in for required history.
          topicContext = undefined;
          historyError = error || new Error("Topic history unavailable");
        }
      }
    }
    return {
      topicContext,
      historyError,
      historyDisabled,
      generation,
      backgroundRevision,
    };
  }

  async function submitGroupMessage(
    bot: BotConfig,
    message: BotInboundMessage,
    context: BotContextState,
    prepared: PreparedBotMessageContent,
    locale: Locale | undefined,
    history: Awaited<ReturnType<typeof prepareGroupTopicHistory>>,
    topicBatch?: PreparedTopicMessage[],
    isCurrent = () => true,
  ): Promise<BotOutboundMessage[]> {
    if (!context.group || !context.activeTaskId || !isFeishuBotProvider(bot.provider))
      throw new Error("Group context is missing");
    const service = await resolveZCodeTaskServiceForContext(context);
    if (!service.submitBotGroupInput)
      throw new Error("Runtime does not support group input admission");
    const messageId = message.actor.providerMessageId;
    if (!messageId) throw new Error("Group message ID is required");
    const commandId = botGroupCommandId(bot.id, context.group.chatId, messageId);
    const { topicContext } = history;
    const inputThreadId = message.actor.threadId ?? context.group.threadId;
    const inputRootMessageId = message.actor.rootMessageId ?? context.group.rootMessageId;
    // Control channels may disable the group during history/attachment prep; the pre-prep grant must not keep submitting.
    const admissionContext = (await repo.readState()).bots[getBotStateKey(context)];
    const admissionBot = findBot(await repo.readConfig(), bot.id);
    if (
      !admissionContext?.group?.enabled ||
      !admissionBot?.enabled ||
      admissionContext.group.ownerId !== admissionBot.providerUserId ||
      admissionContext.group.authorizationId !== context.group.authorizationId ||
      admissionContext.activeTaskId !== context.activeTaskId
    )
      throw new Error("Group authorization changed before input admission");
    let attachmentOffset = 0;
    const admittedAttachments: ZCodePromptAttachment[] = [];
    // Several callbacks may each prepare the root quote before first receipt; dedupe against the authoritative record on commit.
    let rootIncluded = Object.values(admissionContext.group.inputs ?? {}).some(
      (input) => input.admission === "accepted",
    );
    const messages = topicBatch?.map(({ message: original, prepared: material }) => {
      const quote = original.referencedMessage;
      const isRoot = !!inputRootMessageId && quote?.messageId === inputRootMessageId;
      const includeQuote = quote && !(isRoot && rootIncluded);
      const attachmentIndexes: number[] = [];
      let hasRootAttachment = false;
      material.zcodeAttachments.forEach((attachment, index) => {
        const resourceMessageId =
          original.attachments?.[index]?.providerMetadata?.resourceMessageId;
        const rootAttachment = !!inputRootMessageId && resourceMessageId === inputRootMessageId;
        hasRootAttachment ||= rootAttachment;
        // The root quote may have downloaded before the previous receipt; dedupe the resource on commit, not just hide the quote body.
        if (rootAttachment && rootIncluded) return;
        attachmentIndexes.push(admittedAttachments.length);
        admittedAttachments.push(attachment);
      });
      attachmentOffset += material.zcodeAttachments.length;
      if ((isRoot && includeQuote) || hasRootAttachment) rootIncluded = true;
      return {
        messageId: original.actor.providerMessageId!,
        senderId: original.actor.providerUserId,
        mentionedBot: original.mentionedBot === true,
        contentParts: original.contentParts,
        senderName: original.actor.displayName ?? original.actor.providerUserId,
        text: original.text,
        ...(includeQuote ? { conversationQuotes: [quote] } : {}),
        attachmentIndexes,
      };
    });
    // The history text attachment is appended after the originals, kept with this message and never charged to later ones.
    if (topicBatch) admittedAttachments.push(...prepared.zcodeAttachments.slice(attachmentOffset));
    const source = {
      authorizationId: context.group.authorizationId,
      botIdentity: { name: bot.name, ...(message.botOpenId ? { openId: message.botOpenId } : {}) },
      provider: bot.provider,
      botId: bot.id,
      chatId: context.group.chatId,
      threadId: inputThreadId,
      rootMessageId: inputRootMessageId,
      appId: bot.feishuAppId,
      contentParts: message.contentParts,
      senderId: message.actor.providerUserId,
      mentionedBot: message.mentionedBot === true,
      senderName: message.actor.displayName ?? message.actor.providerUserId,
      messageId,
      ...(messages ? { messages } : {}),
      ...(topicContext ? { topicContext } : {}),
    };
    const isFirstTaskInput = !Object.values(context.group.inputs ?? {}).some(
      (input) => input.taskId === context.activeTaskId,
    );
    context.group = {
      ...context.group,
      inputs: {
        ...context.group.inputs,
        [commandId]: { taskId: context.activeTaskId, source, admission: "pending" },
      },
    };
    await writeContext(context);
    await watchTaskStream(bot, message.actor, context, { ...bot, replyMode: "summary_changes" });
    // The original already lives as a text attachment; source metadata must not stuff the whole history into the command frame.
    const { topicContext: archive, ...runtimeSource } = source;
    if (!isCurrent()) return [];
    const ack = await service.submitBotGroupInput({
      taskId: context.activeTaskId,
      commandId,
      content: prepared.content,
      ...(topicBatch
        ? {
            conversationQuotes: messages?.flatMap((entry) => entry.conversationQuotes ?? []) ?? [],
          }
        : message.referencedMessage
          ? { conversationQuotes: [message.referencedMessage] }
          : {}),
      attachments: topicBatch ? admittedAttachments : prepared.zcodeAttachments,
      source: {
        ...runtimeSource,
        ...(archive
          ? {
              topicHistory: {
                checkpoint: archive.checkpoint,
                hasGap: archive.hasGap,
                messageCount: archive.messages.length,
                resourceMessages: archive.messages
                  .filter((record) => record.attachments?.length)
                  .map((record) => ({ messageId: record.id, count: record.attachments!.length })),
              },
            }
          : {}),
      },
    });
    if (ack.status !== "accepted" && ack.status !== "duplicate") {
      context.group.inputs![commandId]!.admission = "rejected";
      await writeContext(context, false, context.activeTaskId);
      throw new Error(ack.message ?? ack.reasonCode ?? "Input rejected");
    }
    if (ack.result?.type !== "inputAccepted") throw new Error("Input admission outcome is unknown");
    adminAttention.clear(message.actor, bot.providerUserId);
    context.group.inputs![commandId]!.admission = "accepted";
    if (context.group.threadId) context.group.topicActive = true;
    await writeContext(context, false, context.activeTaskId);
    if (context.group.threadId && isCurrent() && history.generation) {
      topicHistoryReady.set(getBotStateKey(context), history.generation);
    }
    if (context.group.threadId && isCurrent()) {
      await serializeStateWrite(async () => {
        const state = await repo.readState();
        const current = state.bots[getBotStateKey(context)];
        if (current?.group && isCurrent()) {
          current.group.topicActive = true;
          // Clear only checkpoints backfilled this turn and not replaced by newer context; context arriving mid-prep waits for the next turn.
          if (
            history.topicContext &&
            history.backgroundRevision &&
            current.group.backgroundHistory?.revision === history.backgroundRevision
          ) {
            delete current.group.backgroundHistory;
            topicHistoryReady.set(getBotStateKey(current), historyGeneration(current));
          }
        }
        for (const candidate of Object.values(state.bots)) {
          if (candidate.botId === bot.id && candidate.group?.chatId === context.group!.chatId) {
            delete candidate.group.topicAliases?.[context.group!.threadId!];
          }
        }
        await repo.writeState(state);
      });
    }
    if (isFirstTaskInput && service.renameTask) {
      await service
        .renameTask({
          taskId: context.activeTaskId,
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          title: `${bot.provider === "lark" ? "Lark" : "飞书"} · ${context.group.name}${context.group.threadId ? ` · ${context.group.topicTitle || context.group.threadId}` : ""}`,
        })
        .catch((error: unknown) => {
          // The CLI already accepted the input; a failed title write must not drop the dedupe and re-run it.
          botsLogger.warn(
            undefined,
            `persist group task title failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    await updateGroupInputReaction(
      bot,
      context,
      messageId,
      ack.result.delivery === "queue" ? "waiting" : "working",
    );
    const replies =
      ack.result.delivery === "queue" && !context.group?.threadId
        ? [
            createOutbound(
              message.actor,
              locale === "en-US" ? "Waiting to run" : "等待执行",
              {
                id: `queue-${commandId}`,
                title: locale === "en-US" ? "Queued" : "已排队",
                action: "queue.cancel",
                showCancel: false,
                options: [
                  {
                    id: `/queue-cancel ${commandId}`,
                    label: locale === "en-US" ? "Cancel" : "取消",
                  },
                ],
              },
              { locale, groupSourceCommandId: commandId, groupTaskId: context.activeTaskId },
            ),
          ]
        : [];
    return replies;
  }

  async function updateGroupInputReaction(
    bot: BotConfig,
    context: BotContextState,
    messageId: string | undefined,
    state: BotGroupInputStatus,
  ): Promise<void> {
    if (!messageId) return;
    try {
      const entry = Object.entries(context.group?.inputs ?? {}).find(
        ([, input]) => input.source.messageId === messageId,
      );
      const inputId = entry?.[0];
      if (inputId && context.group) {
        await queueCards
          .update(
            JSON.stringify([
              bot.id,
              context.group.chatId,
              context.activeTaskId,
              context.group.authorizationId,
              inputId,
              context.group.threadId,
            ]),
            state,
          )
          .catch((error) => {
            botsLogger.warn(
              undefined,
              `queue card update failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      // The CLI can finish before the admission ACK; reactions must use the persisted one-way state.
      if (inputId) {
        const latest = (await repo.readState()).bots[getBotStateKey(context)];
        state = latest?.group?.inputs?.[inputId]?.progress?.status ?? state;
      }
      // Batching merges execution only; reactions belong to each original message, not just the last.
      const messageIds = entry?.[1].source.messages?.map((message) => message.messageId) ?? [
        messageId,
      ];
      await Promise.all(
        messageIds.map((originalId) =>
          providers[bot.provider]?.updateInputReaction?.(
            bot,
            originalId,
            state === "stopped" || state === "discarded" ? "cancelled" : state,
          ),
        ),
      );
    } catch (error) {
      // Reactions merely project state; a platform failure must not fail accepted input or trigger a rerun.
      botsLogger.warn(
        undefined,
        `group input reaction update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function cancelGroupInput(
    message: BotInboundMessage,
    sourceCommandId: string,
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    const group = auth.context.group;
    const input = group?.inputs?.[sourceCommandId];
    // Stale topic queue cards can linger in Feishu; they must not drive the new topic's stop/continuation input.
    if (group?.threadId) {
      return [
        {
          ...createOutbound(
            message.actor,
            auth.locale === "en-US"
              ? "This topic queue card has expired. Use /stop to stop the topic."
              : "该话题排队卡已失效，请使用 /stop 停止话题。",
          ),
          callbackToastOnly: true,
        },
      ];
    }
    if (
      !group ||
      !input ||
      input.taskId !== auth.context.activeTaskId ||
      (message.actor.providerUserId !== group.ownerId &&
        input.source.senderId !== message.actor.providerUserId)
    ) {
      return [
        {
          ...(group && input && input.taskId === auth.context.activeTaskId
            ? administratorReply(
                message.actor,
                auth.bot,
                `queue-cancel:${sourceCommandId}`,
                createOutbound(message.actor, msg(auth.locale, "groupOwnerOnly")),
              )
            : createOutbound(message.actor, msg(auth.locale, "groupOwnerOnly"))),
          callbackToastOnly: true,
        },
      ];
    }
    const taskService = await resolveZCodeTaskServiceForContext(auth.context);
    if (!taskService.cancelBotGroupInput) throw new Error("Runtime cannot cancel queued input");
    const ack = await taskService.cancelBotGroupInput({
      taskId: input.taskId,
      commandId: `cancel-${sourceCommandId}-${message.actor.providerMessageId}`,
      sourceCommandId,
      actorId: message.actor.providerUserId,
      ownerId: group.ownerId,
      botId: auth.bot.id,
      chatId: group.chatId,
    });
    const accepted = ack.status === "accepted" || ack.status === "duplicate";
    if (accepted)
      await updateGroupInputReaction(auth.bot, auth.context, input.source.messageId, "cancelled");
    return [
      createOutbound(
        message.actor,
        accepted
          ? auth.locale === "en-US"
            ? "Queued input cancelled."
            : "已取消该排队输入。"
          : auth.locale === "en-US"
            ? "Input changed or started; cancellation was not applied."
            : "输入已变化或开始执行，未取消。",
      ),
    ];
  }

  function sendPromptInBackground(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    taskId: string,
    traceId: string,
    content: string,
    attachments: ZCodePromptAttachment[],
    botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget,
    modelSelection?: ModelSelection,
  ): void {
    privateImTraces.add(JSON.stringify([taskStreamKey(context, actor), traceId]));
    streamSubscriptions.get(taskStreamKey(context, actor))?.imInput();
    // DM resident subscriptions are no longer per-turn; Typing must be taken over before this input dispatches,
    // or callback finalization deletes it as a short-command reaction. Terminal/awaiting-interaction states keep the original cleanup path.
    if (!context.group) startTyping(bot, actor, taskId);
    // Bugfix: Telegram polling handles updates in one sequential loop. Awaiting session/prompt here
    // Permission callbacks queued until the whole task finished, leaving inline-keyboard taps dead.
    // so the prompt must run in the background and keep the polling loop free for /permission callbacks.
    void resolveZCodeTaskServiceForContext(context)
      .then((zcodeTaskService) =>
        zcodeTaskService.sendPrompt({
          taskId,
          traceId,
          content,
          attachments: attachments.length > 0 ? attachments : undefined,
          botDeliveryTarget,
          modelSelection,
        }),
      )
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const locale = await readMessageLocale();
        const userFacingMessage = formatUserFacingBotError(error, locale);
        runningTasks.delete(taskId);
        stopTyping(taskId);
        await broadcastTaskListChange(context, taskId, "error", {
          error: message,
        });
        await sendOutbound(
          bot,
          createOutbound(
            actor,
            isSessionExpiredError(error)
              ? userFacingMessage
              : msg(locale, "taskFailed", { message: userFacingMessage }),
          ),
        ).catch(() => undefined);
      });
  }

  async function stopTopicRun(
    context: BotContextState,
    executionId: string,
    sourceCommandId?: string,
  ): Promise<void> {
    const taskId = context.activeTaskId;
    if (!taskId) return;
    const key = JSON.stringify([
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      taskId,
      executionId,
    ]);
    const existing = topicStops.get(key);
    if (existing) return existing;
    const stopping = resolveZCodeTaskServiceForContext(context).then(async (service) => {
      if (!service.stopBotTopicExecution) throw new Error("Topic stop is unavailable");
      await service.stopBotTopicExecution({
        taskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
        executionId,
      });
      if (sourceCommandId)
        await serializeStateWrite(async () => {
          const state = await repo.readState();
          const latest = state.bots[getBotStateKey(context)];
          const input = latest?.group?.inputs?.[sourceCommandId];
          if (
            !input ||
            input.taskId !== taskId ||
            input.progress?.status === "done" ||
            input.progress?.status === "failed"
          )
            return;
          input.progress = {
            ...input.progress,
            status: "stopped",
            interruptionReason: "newMessage",
          };
          await repo.writeState(state);
        });
      if (sourceCommandId)
        await deps.broadcastService?.send({ channel: "bots:group-state", payload: {} });
    });
    topicStops.set(key, stopping);
    const release = () => {
      if (topicStops.get(key) === stopping) topicStops.delete(key);
    };
    void stopping.then(release, release);
    return stopping;
  }

  async function cancelGroupTopicInputs(actor: BotActor): Promise<void> {
    // Group-level revocation covers every topic, including inputs still preparing history with no task yet.
    const states = (await repo.readState()).bots;
    const keys = new Set([...Object.keys(states), ...topicContinuations.keys()]);
    await Promise.all(
      [...keys].flatMap((key) => {
        if (!key.startsWith("[")) return [];
        const [botId, chatId, threadId] = JSON.parse(key) as string[];
        return botId === actor.botId && chatId === actor.chatId && threadId
          ? [cancelTopicInputs({ ...actor, threadId, conversationThreadId: undefined })]
          : [];
      }),
    );
  }

  async function cancelTopicInputs(actor: BotActor): Promise<void> {
    const key = getBotConversationKey(actor);
    topicPreparation.clear(key);
    topicGenerations.set(key, (topicGenerations.get(key) ?? 0) + 1);
    topicHistoryReady.delete(key);
    topicContinuations.get(key)?.cancel();
    const cancelledIds = [...(topicReplies.get(key)?.keys() ?? [])];
    for (const resolve of topicReplies.get(key)?.values() ?? []) resolve([]);
    topicReplies.get(key)?.clear();
    const context = (await repo.readState()).bots[key];
    const bot = findBot(await repo.readConfig(), actor.botId);
    if (context && bot) {
      await Promise.all(
        cancelledIds.map((id) => updateGroupInputReaction(bot, context, id, "cancelled")),
      );
    }
    if (context?.activeTaskId) {
      const service = await resolveZCodeTaskServiceForContext(context);
      if (!service.invalidateBotTopicInputs)
        throw new Error("Topic preparation cancellation is unavailable");
      await service.invalidateBotTopicInputs({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      });
    }
    await publishTopicPreparation();
  }

  async function admitAutoReplyTurn(message: BotInboundMessage): Promise<boolean> {
    if (
      message.actor.chatType !== "group" ||
      message.groupCardAction ||
      message.elicitationResponse
    )
      return true;
    const id = message.actor.providerMessageId;
    if (!id) return message.senderType !== "app";
    let admitted = false;
    // Message-id dedupe cannot stop two bots answering each other. Atomically claim the count before stop/prep,
    // Persist alongside the dedupe record; a failed prep still consumes one slot so redelivery, races, and restarts cannot bypass the cap.
    await serializeStateWrite(async () => {
      const state = await repo.readState();
      const context = state.bots[getBotConversationKey(message.actor)];
      const group = context?.group;
      if (!group?.enabled) {
        admitted = message.senderType !== "app";
        return;
      }
      const bot = findBot(await repo.readConfig(), message.botId);
      if (!bot?.enabled || bot.providerUserId !== group.ownerId) return;
      if (
        !group.autoReplyGuard &&
        message.senderType !== "app" &&
        parseBotCommand(message.commandText ?? message.text).type !== "message"
      ) {
        admitted = true;
        return;
      }
      const guard = group.autoReplyGuard ?? { consecutive: 0, messageIds: [] };
      if (
        guard.messageIds.includes(id) ||
        Object.values(group.inputs ?? {}).some(
          (input) =>
            input.source.messageId === id ||
            input.source.messages?.some((original) => original.messageId === id),
        )
      ) {
        // Human retries keep the normal prep/command idempotency but must not re-grant bot budget.
        admitted = message.senderType !== "app";
        return;
      }
      if (
        message.senderType === "app" &&
        (guard.consecutive >= 5 ||
          (message.actor.threadId ? group.topicActive !== true : message.mentionedBot !== true))
      )
        return;
      group.autoReplyGuard = {
        consecutive: message.senderType === "app" ? guard.consecutive + 1 : 0,
        messageIds: [...guard.messageIds, id],
      };
      await repo.writeState(state);
      admitted = true;
    });
    return admitted;
  }

  async function receiveTopicMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const key = getBotConversationKey(message.actor);
    const id = message.actor.providerMessageId;
    if (!id) throw new Error("Topic message identity is missing");
    // Dedupe precedes stop side effects; a redelivered receipt must not interrupt a running turn.
    const stored = (await repo.readState()).bots[key];
    if (
      Object.values(stored?.group?.inputs ?? {}).some(
        (input) =>
          input.source.messageId === id ||
          input.source.messages?.some((original) => original.messageId === id),
      )
    )
      return [];

    let replies = topicReplies.get(key);
    if (!replies) {
      replies = new Map();
      topicReplies.set(key, replies);
    }
    // Persisted-receipt dedupe lives in handleMessage; this only collapses the same event arriving together.
    if (replies.has(id)) return [];
    const pendingReplies = replies;
    const result = new Promise<BotOutboundMessage[]>((resolve) => pendingReplies.set(id, resolve));
    let continuation = topicContinuations.get(key);
    if (!continuation) {
      const continuationGeneration = topicGenerations.get(key) ?? 0;
      const current = async () => (await repo.readState()).bots[key];
      let observedSourceCommandId: string | undefined;
      continuation = createTopicContinuation<PreparedTopicMessage>({
        readRunningRun: async () => {
          const context = await current();
          if (!context?.activeTaskId) return undefined;
          const service = await resolveZCodeTaskServiceForContext(context);
          if (!service.readBotTopicExecution)
            throw new Error("Topic runtime control is unavailable");
          const execution = await service.readBotTopicExecution({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          });
          observedSourceCommandId = execution?.sourceCommandId;
          return execution?.executionId;
        },
        stopAndWait: async (executionId) => {
          const context = await current();
          if (!context?.activeTaskId) throw new Error("Topic task disappeared during stop");
          topicPreparation.setWaitingStop(key, true);
          await publishTopicPreparation();
          try {
            await stopTopicRun(context, executionId, observedSourceCommandId);
          } finally {
            if (continuationGeneration === (topicGenerations.get(key) ?? 0)) {
              topicPreparation.setWaitingStop(key, false);
              await publishTopicPreparation();
            }
          }
        },
        submit: async (batch) => {
          topicPreparation.update(
            key,
            batch.map((entry) => entry.message.actor.providerMessageId!),
            "preparing",
          );
          await publishTopicPreparation();
          const last = batch.at(-1)!;
          const combined = {
            ...last.message,
            text:
              batch.length === 1
                ? last.message.text
                : batch
                    .map(
                      ({ message: original }) =>
                        `${original.actor.displayName || original.actor.providerUserId}: ${original.text}`,
                    )
                    .join("\n\n"),
          };
          const isCurrent = () =>
            batch.every((entry) => entry.generation === (topicGenerations.get(key) ?? 0));
          const outgoing = await handleMessage(combined, batch, isCurrent);
          const context = await current();
          const accepted = Object.values(context?.group?.inputs ?? {}).some(
            (input) =>
              input.admission === "accepted" &&
              input.source.messageId === last.message.actor.providerMessageId,
          );
          if (isCurrent() && !accepted && context) {
            const bot = findBot(await repo.readConfig(), message.botId);
            if (bot)
              await Promise.all(
                batch.map((entry) =>
                  updateGroupInputReaction(
                    bot,
                    context,
                    entry.message.actor.providerMessageId,
                    "failed",
                  ),
                ),
              );
          }
          const ids = batch.map((entry) => entry.message.actor.providerMessageId!);
          if (isCurrent()) {
            if (accepted) topicPreparation.remove(key, ids);
            else
              topicPreparation.update(
                key,
                ids,
                "failed",
                outgoing.map((reply) => reply.text).join("\n"),
              );
            await publishTopicPreparation();
          }
          for (const entry of batch) {
            const messageId = entry.message.actor.providerMessageId!;
            pendingReplies.get(messageId)?.(entry === last ? outgoing : []);
            pendingReplies.delete(messageId);
          }
        },
        failed: async (ids, error) => {
          // Cancelled downloads/stop errors from an old generation must not touch the new one's state or reactions.
          if (continuationGeneration !== (topicGenerations.get(key) ?? 0)) return;
          topicPreparation.update(
            key,
            ids,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
          await publishTopicPreparation();
          const context = await current();
          const bot = findBot(await repo.readConfig(), message.botId);
          if (context && bot)
            await Promise.all(
              ids.map((id) => updateGroupInputReaction(bot, context, id, "failed")),
            );
          for (const messageId of ids) {
            pendingReplies.get(messageId)?.(
              error instanceof BotReplyError
                ? error.replies
                : [
                    administratorErrorReply(
                      message.actor,
                      bot,
                      error,
                      createOutbound(
                        message.actor,
                        error instanceof Error ? error.message : String(error),
                      ),
                    ),
                  ],
            );
            pendingReplies.delete(messageId);
          }
        },
      });
      topicContinuations.set(key, continuation);
    }
    const generation = topicGenerations.get(key) ?? 0;
    const received = continuation.receive(id, async () => {
      const auth = await withAuthorizedContext(message, "message");
      if (!auth.ok) throw new BotReplyError(auth.reply);
      if (generation !== (topicGenerations.get(key) ?? 0)) throw new Error("Topic input cancelled");
      topicPreparation.add(key, message);
      await publishTopicPreparation();
      await updateGroupInputReaction(auth.bot, auth.context, id, "waiting");
      return {
        message,
        generation,
        prepared: await prepareBotMessageContent(auth.bot, message, auth.locale),
      };
    });
    if (!received) {
      pendingReplies.get(id)?.([]);
      pendingReplies.delete(id);
    }
    const active = continuation;
    void active.settled().finally(() => {
      if (pendingReplies.size === 0 && topicContinuations.get(key) === active) {
        topicContinuations.delete(key);
        topicReplies.delete(key);
      }
    });
    return result;
  }

  async function handleMessage(
    message: BotInboundMessage,
    topicBatch?: PreparedTopicMessage[],
    isCurrent = () => true,
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) {
      return auth.reply;
    }
    const priorInput =
      auth.context.group && message.actor.providerMessageId
        ? Object.values(auth.context.group.inputs ?? {}).find(
            (input) =>
              input.source.messageId === message.actor.providerMessageId ||
              input.source.messages?.some(
                (item) => item.messageId === message.actor.providerMessageId,
              ),
          )
        : undefined;
    if (priorInput && priorInput.taskId !== auth.context.activeTaskId) {
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US"
            ? "This message belongs to an earlier task and will not be executed again."
            : "这条消息已关联到此前任务，不会在新任务中重复执行。",
        ),
      ];
    }
    // Idempotency windows shift across CLI restarts; persisted receipts cannot rely on in-memory dedupe alone.
    if (priorInput) {
      if (priorInput.admission === "accepted") return [];
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US"
            ? "This message already has an admission record. Check the task before submitting another request."
            : "这条消息已有接收记录，请先在任务中核对执行状态，不会自动重复提交。",
        ),
      ];
    }
    const history = auth.context.group
      ? await prepareGroupTopicHistory(auth.bot, message, auth.context)
      : {};
    if (history.topicContext && topicBatch) {
      const ids = new Set(topicBatch.map((entry) => entry.message.actor.providerMessageId));
      history.topicContext.messages = history.topicContext.messages.filter(
        (entry) => !ids.has(entry.id),
      );
    }
    if (history.historyDisabled || history.historyError) {
      const en = auth.locale === "en-US";
      const permissionDenied = history.historyError instanceof TopicHistoryPermissionError;
      const platformUrl =
        auth.bot.provider === "lark"
          ? "https://open.larksuite.com/app"
          : "https://open.feishu.cn/app";
      const text = history.historyDisabled
        ? en
          ? "Topic history is disabled. Ask the bound user to enable /history on before using topics."
          : "话题历史已关闭，暂时无法处理话题消息。请绑定用户发送 /history on 后重新 @。"
        : permissionDenied
          ? en
            ? `Topic history permission is missing. No task was submitted. Ask the app administrator to open ${platformUrl}, select this bot app, enable the required application-identity message permissions (including im:message.group_msg), and publish the change. Then mention the bot again.`
            : `机器人缺少话题历史读取权限，未提交任务。请应用管理员打开 ${platformUrl}，选择当前机器人应用，在权限管理中开通应用身份的消息读取权限（包括 im:message.group_msg，获取群组中所有消息），并发布生效后重新 @。无需安装或授权 lark-cli。`
          : en
            ? "Topic history could not be read. No task was submitted. Please retry by mentioning the bot again later."
            : "暂时无法读取话题历史，未提交任务。请稍后重新 @ 重试。";
      return [
        history.historyDisabled
          ? administratorReply(
              message.actor,
              auth.bot,
              "history",
              createOutbound(message.actor, text),
            )
          : createOutbound(message.actor, text),
      ];
    }
    adminAttention.clear(message.actor, auth.bot.providerUserId, "history");
    // commandText is per-message; a trailing bare @ must not erase other members' valid asks from the stopped batch.
    const hasRequest = (topicBatch?.map((entry) => entry.message) ?? [message]).some((original) =>
      Boolean(
        (original.commandText ?? original.text).trim() ||
        original.attachments?.length ||
        original.referencedMessage,
      ),
    );
    if (auth.context.group && !hasRequest) {
      const hasBackground = (history.topicContext?.messages.length ?? 0) > 0;
      if (!message.referencedMessage && !hasBackground) {
        return [
          createOutbound(
            message.actor,
            auth.locale === "en-US"
              ? "Please add a request, or reply to the message you want me to handle and mention me."
              : "请补充需求，或回复要处理的消息并 @我。",
          ),
        ];
      }
      // Mention-only inputs already carry quotes/history attachments; injecting instructions would disguise system copy as user text.
      // Keep the original @; quotes/attachments carry the material and commands inside it are not re-parsed.
    }
    if (message.referencedMessage) {
      // Inlining message ids tempted the model to query Feishu again; standard quotes carry only the real text and reuse the UI rendering.
      const quote = message.referencedMessage.text;
      if (quote.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH) {
        return [
          createOutbound(
            message.actor,
            auth.locale === "en-US"
              ? "The quoted text is too long. Please quote a shorter passage or attach it as a file."
              : "引用文字过长，请缩小引用范围或作为文件提交。",
          ),
        ];
      }
    }
    let deletedTaskId: string | undefined;
    if (auth.context.mode === "task" && auth.context.activeTaskId) {
      const taskService = await resolveZCodeTaskServiceForContext(auth.context);
      const deletedTaskIds = await taskService.listDeletedTaskIds({
        workspacePath: auth.context.workspacePath,
        workspaceIdentity: auth.context.workspaceIdentity,
      });
      if (deletedTaskIds.includes(auth.context.activeTaskId)) {
        // Desktop soft-deletes leave a tombstone; the CLI can still restore the old session.
        // Never resume hidden tasks from activeTaskId alone; clear stale interactions first, then reuse valid draft selections and the V4 first-send.
        // Trust only the deletion record; filtered lists, archives, or query failures are not deletions.
        deletedTaskId = auth.context.activeTaskId;
        auth.context = await writeDraftContext(auth.context);
      }
    }
    const elicitationReply = auth.context.group
      ? null
      : await handlePendingElicitationText(auth, message.actor, message.text);
    if (elicitationReply) {
      return elicitationReply;
    }
    if (
      !auth.context.group &&
      auth.context.mode === "task" &&
      auth.context.activeTaskId &&
      (await getContextTaskBlockReason(auth.context))
    ) {
      return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
    }
    let preparedMessage: PreparedBotMessageContent;
    try {
      preparedMessage = topicBatch
        ? {
            content: message.text,
            zcodeAttachments: topicBatch.flatMap((entry) => entry.prepared.zcodeAttachments),
          }
        : await prepareBotMessageContent(auth.bot, message, auth.locale);
      const historyMaterial = history.topicContext;
      if (auth.context.group && historyMaterial) {
        const attachment = createTopicHistoryAttachment(
          historyMaterial,
          botGroupCommandId(
            auth.bot.id,
            auth.context.group.chatId,
            message.actor.providerMessageId!,
          ),
          auth.context.group.topicTitle || auth.context.group.name,
        );
        if (attachment) preparedMessage.zcodeAttachments.push(attachment);
      }
    } catch (error) {
      return [
        createOutbound(
          message.actor,
          msg(auth.locale, "attachmentRejected", {
            message: formatAttachmentRejectedReason(error, auth.locale),
          }),
        ),
      ];
    }
    if (!isCurrent()) return [];
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      const draftOptions =
        auth.context.draftOptions ?? (await buildInitializedDraftOptions(auth.context));
      // Reason: submitting the legacy account identity directly bypasses unified resolution. Resolve the original intent pre-creation only;
      // Later creation, config, and first-send pin this result; after binding, the session's original choice resolves the next input.
      const selectionView = await readModelSelectionView(auth.context, draftOptions.modelSelection);
      const submissionModelSelection = draftOptions.modelSelection
        ? selectionView?.effectiveSelection
        : selectionView?.preferredSelection;
      if (
        !submissionModelSelection ||
        (draftOptions.modelSelection && selectionView?.selectionIssue)
      ) {
        throw new BotAdminRequiredError(
          "model",
          "Failed to resolve the submission model on the target host",
        );
      }
      const submissionDraftOptions: BotDraftOptions = {
        ...draftOptions,
        modelSelection: {
          providerId: submissionModelSelection.providerId,
          modelId: submissionModelSelection.modelId,
          ...(submissionModelSelection.options
            ? { options: { ...submissionModelSelection.options } }
            : {}),
        },
      };
      const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
      const task = await zcodeTaskService.createTask({
        workspacePath: auth.context.workspacePath,
        workspaceIdentity: auth.context.workspaceIdentity,
        provider: draftOptions.provider,
        modelSelection: submissionDraftOptions.modelSelection,
        // Fix: the legacy bot createTask used session/create then immediately v4 sendText,
        // The in-memory flag and the v4 draft persistence boundary disagree, and session_input trips an FK. Create first,
        // v4 draft, validate the app config through the existing capability path, then first-send via v4 sendText.
        v4Create: true,
        ...(auth.context.group ? { permissionScope: "session" as const } : {}),
      });
      const taskTitle = auth.context.group
        ? [
            auth.bot.provider === "lark" ? "Lark" : "飞书",
            auth.context.group.name,
            ...(auth.context.group.threadId
              ? [auth.context.group.topicTitle || auth.context.group.threadId]
              : []),
          ].join(" · ")
        : deriveTaskTitle(preparedMessage.content, preparedMessage.zcodeAttachments);
      const broadcastTask = taskTitle ? { ...task, title: taskTitle } : task;
      const traceId = generateTraceId(task.taskId);
      try {
        await applyDraftConfigOptions(
          { ...auth.context, draftOptions: submissionDraftOptions },
          task.taskId,
          traceId,
        );
      } catch (error) {
        // Bugfix: on initial-config failure the old flow had already switched context to the task, stranding an empty unusable one.
        // Finish configuration before persisting bot task state and delete the temp task so a fixed config retries cleanly.
        await zcodeTaskService
          .deleteTask({
            taskId: task.taskId,
            workspacePath: auth.context.workspacePath,
            workspaceIdentity: auth.context.workspaceIdentity,
          })
          .catch(() => undefined);
        throw error;
      }
      const context = {
        ...auth.context,
        mode: "task" as const,
        activeTaskId: task.taskId,
        draftOptions: undefined,
      };
      await writeContext(context);
      // Bugfix: the bot first-send bypasses the UI-local deriveTaskTitle/optimistic cache.
      // If the created broadcast keeps createTask's empty title, the sidebar shows New task until a full refresh.
      await broadcastTaskListChange(context, task.taskId, "created", {
        task: broadcastTask,
      });
      if (deletedTaskId) {
        botsLogger.info(
          undefined,
          `replaced deleted Bot task bot=${auth.bot.id} oldTask=${deletedTaskId} newTask=${task.taskId} workspace=${getWorkspaceKey(context.workspacePath, context.workspaceIdentity)}`,
        );
        // The switch is already persisted; a failed notice must not let the callback drop the dedupe record and rerun the message.
        await sendOutbound(
          auth.bot,
          createOutbound(message.actor, msg(auth.locale, "deletedTaskReplaced")),
        ).catch((error: unknown) => {
          botsLogger.warn(
            undefined,
            `deleted task replacement notice failed bot=${auth.bot.id} task=${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      if (context.group)
        return submitGroupMessage(
          auth.bot,
          message,
          context,
          preparedMessage,
          auth.locale,
          history,
          topicBatch,
          isCurrent,
        );
      runningTasks.add(task.taskId);
      await watchTaskStream(auth.bot, message.actor, context, auth.user);
      await broadcastTaskListChange(context, task.taskId, "prompt_sent", {
        task: broadcastTask,
        prompt: {
          content: preparedMessage.content,
          attachments:
            preparedMessage.zcodeAttachments.length > 0
              ? preparedMessage.zcodeAttachments
              : undefined,
          messageId: `bot-${traceId}`,
          sentAt: Date.now(),
        },
      });
      sendPromptInBackground(
        auth.bot,
        message.actor,
        context,
        task.taskId,
        traceId,
        preparedMessage.content,
        preparedMessage.zcodeAttachments,
        resolveAutomationBotDeliveryTarget(message.actor),
        submissionDraftOptions.modelSelection,
      );
      return [];
    }
    if (auth.context.group)
      return submitGroupMessage(
        auth.bot,
        message,
        auth.context,
        preparedMessage,
        auth.locale,
        history,
        topicBatch,
        isCurrent,
      );
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
    await zcodeTaskService.resumeTask({
      taskId: auth.context.activeTaskId,
      workspacePath: auth.context.workspacePath,
      workspaceIdentity: auth.context.workspaceIdentity,
    });
    // The bot is just another input surface of the same session. Menus may filter values, so never infer the original choice from them,
    // nor re-apply bot creation defaults. Resolution pins this input only and never rewrites the Session here.
    const originalSelection = await zcodeTaskService.getTaskModelSelection({
      taskId: auth.context.activeTaskId,
    });
    const selectionView = originalSelection
      ? await readModelSelectionView(auth.context, originalSelection)
      : null;
    const effectiveSelection = selectionView?.effectiveSelection;
    if (!effectiveSelection || selectionView?.selectionIssue) {
      throw new Error(msg(auth.locale, "sessionModelUnavailable"));
    }
    await broadcastTaskListChange(auth.context, auth.context.activeTaskId, "resumed");
    runningTasks.add(auth.context.activeTaskId);
    await watchTaskStream(auth.bot, message.actor, auth.context, auth.user);
    const traceId = generateTraceId(auth.context.activeTaskId);
    await broadcastTaskListChange(auth.context, auth.context.activeTaskId, "prompt_sent", {
      prompt: {
        content: preparedMessage.content,
        attachments:
          preparedMessage.zcodeAttachments.length > 0
            ? preparedMessage.zcodeAttachments
            : undefined,
        messageId: `bot-${traceId}`,
        sentAt: Date.now(),
      },
    });
    sendPromptInBackground(
      auth.bot,
      message.actor,
      auth.context,
      auth.context.activeTaskId,
      traceId,
      preparedMessage.content,
      preparedMessage.zcodeAttachments,
      resolveAutomationBotDeliveryTarget(message.actor),
      effectiveSelection,
    );
    return [];
  }

  async function handleTaskList(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "task");
    if (!auth.ok) {
      return auth.reply;
    }
    if (message.actor.threadId) return createStatusReply(message.actor, auth.context, auth.locale);
    const blockReason = await getContextTaskBlockReason(auth.context);
    if (blockReason) {
      // Bugfix: showing /task while running invites clicks on other tasks,
      // or a later rejected switch strands a misleading pending selection.
      return [createOutbound(message.actor, msg(auth.locale, blockReason))];
    }
    const taskEntries = (await listContextTaskSelectionEntries(auth.context, auth.user)).slice(
      0,
      10,
    );
    const tasks = taskEntries.map((entry) => entry.task);
    const activeTask = auth.context.activeTaskId
      ? tasks.find((task) => task.taskId === auth.context.activeTaskId)
      : null;
    const selection: SelectionPrompt = {
      id: `task-${Date.now()}`,
      title: msg(auth.locale, "taskSelectTitle", {
        task: activeTask ? `${activeTask.title} (${activeTask.taskId})` : "draft",
      }),
      currentId: auth.context.activeTaskId ?? undefined,
      action: "task.set",
      options: taskEntries.map((entry) => ({
        id: entry.task.taskId,
        label: entry.task.title,
        description: taskStatus(entry.task),
      })),
    };
    if (taskEntries.length > 0) {
      // Bugfix: caching a remote task for display must include its workspaceIdentity.
      // or a /task index click leaves only the taskId and later lookups degrade to path-only semantics with Task not found.
      pendingTaskSelectionsByContext.set(
        getActorContextKey(message.actor),
        new Map(taskEntries.map((entry) => [entry.task.taskId, entry])),
      );
    } else {
      pendingTaskSelectionsByContext.delete(getActorContextKey(message.actor));
    }
    return tasks.length > 0
      ? createSelectionReply(message.actor, selection, auth.locale)
      : [createOutbound(message.actor, msg(auth.locale, "noHistoryTasks"))];
  }

  async function resolveTaskSelectionEntry(
    message: BotInboundMessage,
    context: BotContextState,
    user: BotConfig,
    value: string,
  ): Promise<BotTaskSelectionEntry | null> {
    const pendingEntry = resolvePendingTaskSelectionEntry(message.actor, value);
    if (context.group && pendingEntry && !context.group.taskIds.includes(pendingEntry.task.taskId))
      return null;
    if (pendingEntry) {
      return pendingEntry;
    }
    const entries = await listContextTaskSelectionEntries(context, user);
    const selected = resolveOptionByValue(
      entries.map((entry) => ({
        id: entry.task.taskId,
        label: entry.task.title,
        entry,
      })),
      value,
    );
    if (selected) {
      return selected.entry;
    }
    // Group history is closed: no reading other sessions via arbitrary taskIds outside the candidate list.
    if (context.group) return null;
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    const snapshot = await zcodeTaskService
      .getTaskSnapshot({
        taskId: value.trim(),
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      })
      .catch(() => null);
    return snapshot
      ? {
          task: snapshot.meta,
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
        }
      : null;
  }

  async function getContextTaskBlockReason(
    context: BotContextState,
  ): Promise<
    "taskRunning" | "groupTaskQueued" | "groupTaskInteraction" | "groupTaskDisconnected" | null
  > {
    if (!context.activeTaskId) {
      return null;
    }
    if (context.group) {
      if (context.workspaceIdentity && !(await isRemoteWorkspaceConnected(context)))
        return "groupTaskDisconnected";
      const taskService = await resolveZCodeTaskServiceForContext(context);
      if (!taskService.getBotGroupTaskBlockReason)
        throw new Error("Runtime cannot verify group queue state");
      const reason = await taskService.getBotGroupTaskBlockReason({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      });
      botsLogger.debug(
        undefined,
        `group task switch check task=${context.activeTaskId} reason=${reason ?? "idle"}`,
      );
      if (reason)
        return reason === "queued"
          ? "groupTaskQueued"
          : reason === "interaction"
            ? "groupTaskInteraction"
            : "taskRunning";
      // After a stop or a desktop-side approval, stale bot card caches can linger; they must not veto the CLI idle state.
      if (context.pendingElicitation || context.pendingPermissionOptions?.length) {
        if (context.pendingElicitation)
          clearPendingElicitationSelection(context.pendingElicitation);
        context.pendingElicitation = undefined;
        context.pendingPermissionOptions = undefined;
        await writeContext(context, false, context.activeTaskId);
        botsLogger.info(
          undefined,
          `cleared stale group interaction cache task=${context.activeTaskId}`,
        );
      }
      return null;
    }
    if (!runningTasks.has(context.activeTaskId)) {
      return null;
    }
    if (context.workspaceIdentity && !(await isRemoteWorkspaceConnected(context))) {
      // Bugfix: local commands like /workspace only switch context and must not spawn a remote runtime to check the old task.
      // While disconnected, treat in-memory running as unconfirmed and resume queries only after an explicit /reconnect.
      return null;
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    const activeTaskSnapshot = await zcodeTaskService
      .getTaskSnapshot({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      })
      .catch(() => null);
    if (
      activeTaskSnapshot?.meta.status === "completed" ||
      activeTaskSnapshot?.meta.status === "error"
    ) {
      // Bugfix: in-process runningTasks can drift from persisted state after restarts or lost terminal stream events.
      // A legacy task's empty status may just be old data, not a running UI; only when this process actually initiated
      // and only tasks with no observed terminal state block context switches like /task or /new.
      runningTasks.delete(context.activeTaskId);
      stopTyping(context.activeTaskId);
      return null;
    }
    return "taskRunning";
  }

  function warnAutomationDeliveryOnce(params: {
    target: ZCodeAutomationBotDeliveryTarget;
    reason: string;
  }): void {
    const key = `${params.target.provider}:${params.target.botId}:${params.reason}`;
    const now = Date.now();
    const previousAt = automationDeliveryWarningAtByKey.get(key) ?? 0;
    if (now - previousAt < BOT_AUTOMATION_DELIVERY_WARNING_TTL_MS) return;
    automationDeliveryWarningAtByKey.set(key, now);
    botsLogger.warn(
      undefined,
      `automation Bot delivery skipped provider=${params.target.provider} bot=${params.target.botId} reason=${params.reason}`,
    );
  }

  async function watchAutomationRun(params: BotAutomationRunWatchParams): Promise<void> {
    const config = await repo.readConfig();
    const bot = findBot(config, params.target.botId);
    if (!bot) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "bot_missing" });
      return;
    }
    if (!bot.enabled) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "bot_disabled" });
      return;
    }
    if (bot.provider !== params.target.provider) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "provider_mismatch" });
      return;
    }
    if (params.target.chatType === "private") await reconcilePrivateSynchronization(bot.id);
    let conversationThreadId: string | null | undefined;
    if (params.target.chatType === "group") {
      const states = (await repo.readState()).bots;
      const state =
        states[
          getBotConversationKey({
            botId: bot.id,
            chatType: "group",
            chatId: params.target.providerUserId,
            threadId: params.target.threadId,
          })
        ];
      if (!state?.group?.enabled || state.group.ownerId !== bot.providerUserId) {
        warnAutomationDeliveryOnce({ target: params.target, reason: "group_not_authorized" });
        return;
      }
      // Legacy aliases never fall back to the default task; topic delivery requires its own granted session.
      conversationThreadId = state.group.threadId ?? null;
    }
    const actor: BotActor = {
      provider: params.target.provider,
      botId: params.target.botId,
      providerUserId: params.target.providerUserId,
      chatType: params.target.chatType,
      threadId: params.target.threadId,
      conversationThreadId,
      rootMessageId: params.target.rootMessageId,
      ...(params.target.chatType === "group" ? { chatId: params.target.providerUserId } : {}),
    };
    const context: BotContextState = {
      botId: bot.id,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      mode: "task",
      activeTaskId: params.taskId,
      updatedAt: Date.now(),
    };
    // Automation pushes are pinned to terminal summaries; reusing the user's replyMode would let streaming/card
    // would stream intermediate progress into the original chat while the background task runs.
    await watchTaskStream(
      bot,
      actor,
      context,
      {
        ...bot,
        replyMode: "summary_changes",
      },
      params.runId ?? true,
    );
  }

  service = {
    async syncAppRuntimePreferences(preferences) {
      await deps.remoteWorkspaceService?.syncAppRuntimePreferences?.(preferences);
    },
    async getStatus() {
      const config = await repo.readConfig();
      const state = await repo.readState();
      return {
        botsCount: config.bots.length,
        enabledBotsCount: config.bots.filter((bot) => bot.enabled).length,
        contextsCount: Object.keys(state.bots).length,
        botRuntime: config.bots.map((bot) => {
          const runtime = runtimeByBotId.get(bot.id);
          return (
            runtime ?? {
              botId: bot.id,
              provider: bot.provider,
              status: bot.enabled ? "idle" : "disabled",
              message: bot.enabled ? "Bot is configured." : "Bot is disabled.",
              offset: state.bots[bot.id]?.telegramOffset,
            }
          );
        }),
      };
    },
    getConfig: () => repo.readConfig(),
    listWorkspaceRefs,
    getUserConfigOptions: listUserConfigOptions,
    beginFeishuRegistration(params) {
      return beginFeishuAppRegistration(params?.domain);
    },
    pollFeishuRegistration(params) {
      return pollFeishuAppRegistration(params);
    },
    beginWeixinRegistration() {
      return beginWeixinQrRegistration();
    },
    pollWeixinRegistration(params) {
      return pollWeixinQrRegistration(params);
    },
    async saveConfig(config) {
      const savedConfig = await writeBotConfig(normalizeConfigBots(config));
      clearCandidateCaches();
      telegramRuntime.scheduleRefresh(savedConfig);
      weixinRuntime.scheduleRefresh(savedConfig);
      feishuRuntime.scheduleRefresh(savedConfig);
      return savedConfig;
    },
    async listBots() {
      return (await repo.readConfig()).bots;
    },
    async saveBot(params: BotSaveBotParams) {
      const config = await repo.readConfig();
      let bot: BotConfig = {
        ...params.bot,
        id: params.bot.id.trim(),
        name: params.bot.name.trim(),
        allowedWorkspaces: normalizeAllowedWorkspaces(params.bot.allowedWorkspaces),
        allowedCommands: normalizeBotCommandPolicy(params.bot.allowedCommands),
        currentOptions: normalizeBotCurrentOptions(params.bot.currentOptions),
        replyMode: normalizeBotReplyGranularity(params.bot.provider, params.bot.replyMode),
      };
      if (params.credentialValue?.trim()) {
        const key = buildBotCredentialKey(bot.id);
        await deps.credentialService.save(key, params.credentialValue.trim());
        bot = { ...bot, credentialRef: key };
      }
      if (params.webhookSecretValue?.trim()) {
        const key = buildBotWebhookSecretKey(bot.id);
        await deps.credentialService.save(key, params.webhookSecretValue.trim());
        bot = { ...bot, webhookSecretRef: key };
      }
      if (params.credentialValue?.trim() || !bot.name.trim()) {
        const adapter = providers[bot.provider];
        const resolveRetryDelaysMs = isFeishuBotProvider(bot.provider) ? [0, 800, 1_800] : [0];
        let resolvedName: string | null | undefined = null;
        let lastResolveNameError: unknown;
        for (const retryDelayMs of resolveRetryDelaysMs) {
          if (retryDelayMs > 0) {
            // Bugfix: right after QR-setup the app info endpoint can be briefly unreadable; retry, then fill in the bot name.
            await delay(retryDelayMs);
          }
          try {
            resolvedName = await adapter?.resolveName?.(bot);
            if (resolvedName?.trim()) {
              break;
            }
          } catch (error) {
            lastResolveNameError = error;
          }
        }
        if (resolvedName?.trim()) {
          bot = { ...bot, name: resolvedName.trim() };
        } else if (lastResolveNameError) {
          botsLogger.warn(
            undefined,
            `resolve bot name failed bot=${bot.id}: ${lastResolveNameError instanceof Error ? lastResolveNameError.message : String(lastResolveNameError)}`,
          );
        }
      }
      bot = normalizeBotConfig(bot);
      validateBotConfig(config, bot);
      const bots = config.bots.filter((item) => item.id !== bot.id);
      bots.push(bot);
      const savedConfig = await writeBotConfig({ ...config, bots });
      clearCandidateCaches();
      telegramRuntime.scheduleRefresh(savedConfig);
      weixinRuntime.scheduleRefresh(savedConfig);
      feishuRuntime.scheduleRefresh(savedConfig);
      return bot;
    },
    async removeBotSecret(botId: string) {
      const config = await repo.readConfig();
      const bot = findBot(config, botId);
      if (!bot) {
        throw new Error(`Bot not found: ${botId}`);
      }
      if (bot.provider === "telegram") {
        void telegramRuntime.syncCommands({ ...bot, enabled: false });
      }
      if (isFeishuBotProvider(bot.provider)) {
        feishuRuntime.stopWebSocket(bot.id);
      }
      if (bot.provider === "weixin") {
        weixinRuntime.stopPolling(bot.id);
      }
      // Bugfix: dropping the key while keeping the old binding shows "connected" in the UI with no usable token at runtime.
      // Clear the binding state synchronously so the bot token row is addable again.
      const nextBot = normalizeBotConfig({
        ...bot,
        credentialRef: undefined,
        webhookSecretRef: undefined,
        providerUserId: undefined,
        displayName: undefined,
        feishuAppId: isFeishuBotProvider(bot.provider) ? undefined : bot.feishuAppId,
      });
      const savedConfig = await writeBotConfig({
        ...config,
        bots: config.bots.map((item) => (item.id === bot.id ? nextBot : item)),
      });
      await serializeStateWrite(async () => {
        const state = await repo.readState();
        delete state.bots[bot.id];
        await repo.writeState(state);
      });
      clearCandidateCaches();
      telegramRuntime.scheduleRefresh(savedConfig);
      weixinRuntime.scheduleRefresh(savedConfig);
      feishuRuntime.scheduleRefresh(savedConfig);
      if (bot.credentialRef) {
        await deps.credentialService.delete(bot.credentialRef);
      }
      if (bot.webhookSecretRef) {
        await deps.credentialService.delete(bot.webhookSecretRef);
      }
      return nextBot;
    },
    async deleteBot(botId: string) {
      const config = await repo.readConfig();
      const bot = findBot(config, botId);
      if (bot?.provider === "telegram") {
        void telegramRuntime.syncCommands({ ...bot, enabled: false });
      }
      if (bot && isFeishuBotProvider(bot.provider)) {
        feishuRuntime.stopWebSocket(bot.id);
      }
      if (bot?.provider === "weixin") {
        weixinRuntime.stopPolling(bot.id);
      }
      await writeBotConfig({
        ...config,
        bots: config.bots.filter((item) => item.id !== botId),
      });
      clearCandidateCaches();
      telegramRuntime.scheduleRefresh();
      weixinRuntime.scheduleRefresh();
      await serializeStateWrite(async () => {
        const state = await repo.readState();
        delete state.bots[botId];
        await repo.writeState(state);
      });
      if (bot?.credentialRef) {
        await deps.credentialService.delete(bot.credentialRef);
      }
      if (bot?.webhookSecretRef) {
        await deps.credentialService.delete(bot.webhookSecretRef);
      }
    },
    async testBot(botId: string): Promise<BotTestResult> {
      const config = await repo.readConfig();
      const bot = findBot(config, botId);
      if (!bot) {
        return { ok: false, message: "Bot not found." };
      }
      const adapter = providers[bot.provider];
      if (!adapter) {
        return {
          ok: false,
          message: `${bot.provider} is reserved for a future version.`,
          provider: bot.provider,
        };
      }
      return { ...(await adapter.test(bot)), provider: bot.provider };
    },
    async createBindCode(params: BotCreateBindCodeParams): Promise<BotBindCodeResult> {
      const config = await repo.readConfig();
      const botId = params.botId ?? params.botId;
      if (!botId) {
        throw new Error("Bot id is required.");
      }
      const bot = findBot(config, botId);
      if (!bot) {
        throw new Error(`Bot not found: ${botId}`);
      }
      const code = createCode();
      const expiresAt = Date.now() + (params.ttlMs ?? BOT_BIND_CODE_TTL_MS);
      const allowedWorkspaces = normalizeAllowedWorkspaces(
        params.allowedWorkspaces ?? [ALL_BOT_WORKSPACES],
      );
      bindCodes.set(code, {
        botId: botId,
        code,
        allowedWorkspaces,
        expiresAt,
      });
      return { code, expiresAt };
    },
    async getGroupMemberNames(params: { botId: string; chatId: string }) {
      const key = getBotConversationKey({ ...params, chatType: "group" });
      const authorize = async () => {
        const bot = findBot(await repo.readConfig(), params.botId);
        const group = (await repo.readState()).bots[key]?.group;
        if (
          !bot?.enabled ||
          !bot.providerUserId ||
          !group?.enabled ||
          group.ownerId !== bot.providerUserId
        )
          throw new Error("Group member names are unavailable for this group");
        return { bot, group };
      };
      const before = await authorize();
      const names =
        (await providers[before.bot.provider]?.getGroupMemberNames?.(before.bot, params.chatId)) ??
        {};
      const after = await authorize();
      // After a disable, re-grant, or credential swap mid-lookup, the old request must not carry names into the new session.
      if (
        before.group.authorizationId !== after.group.authorizationId ||
        before.bot.providerUserId !== after.bot.providerUserId ||
        before.bot.credentialRef !== after.bot.credentialRef ||
        before.bot.feishuAppId !== after.bot.feishuAppId ||
        before.bot.provider !== after.bot.provider
      )
        throw new Error("Group authorization changed while resolving names");
      return names;
    },
    async validateTopicResource(params) {
      await authorizeTopicResource(params, {
        readState: () => repo.readState(),
        readConfig: () => repo.readConfig(),
      });
    },
    async readTopicResource(params) {
      botsLogger.debug(
        `topic resource read task=${params.taskId} message=${params.messageId} trace=${params.trace?.traceId ?? "none"}`,
      );
      const result = await readAuthorizedTopicResource(params, {
        readState: () => repo.readState(),
        readConfig: () => repo.readConfig(),
        readMessage: async (bot, target, signal) => {
          const reader = providers[bot.provider]?.readTopicResourceMessage;
          if (!reader) throw new Error("Topic resource provider unavailable");
          return reader(bot, target, signal);
        },
        download: async (bot, attachment, target, signal) => {
          const result = await providers[bot.provider]?.downloadAttachment?.(
            bot,
            attachment,
            {
              botId: bot.id,
              provider: bot.provider,
              chatType: "group",
              chatId: target.chatId,
              threadId: target.threadId,
              providerUserId: bot.providerUserId!,
              providerMessageId: target.messageId,
            },
            signal,
          );
          if (!result) throw new Error("Topic resource download unavailable");
          return result;
        },
      });
      if (result.attachment.kind !== "file" && result.attachment.kind !== "image")
        throw new Error("Topic resource format unsupported");
      return {
        kind: result.attachment.kind,
        filename: result.attachment.filename,
        mimeType: result.attachment.mimeType || "application/octet-stream",
        sizeBytes: result.data.byteLength,
        dataBase64: Buffer.from(result.data).toString("base64"),
      };
    },
    async getTopicDetails(params) {
      const state = await repo.readState();
      const context =
        state.bots[
          getBotConversationKey({
            botId: params.botId,
            chatId: params.chatId,
            chatType: "group",
            threadId: params.threadId,
          })
        ];
      const workspace = context?.group?.taskWorkspaces?.[params.taskId] ?? context;
      if (
        !context?.group?.taskIds.includes(params.taskId) ||
        !workspace ||
        (workspace.workspaceIdentity?.trim() || workspace.workspacePath) !==
          (params.workspaceIdentity?.trim() || params.workspacePath)
      )
        throw new Error("Topic task scope mismatch");
      const bot = findBot(await repo.readConfig(), params.botId);
      if (!bot || context.group.ownerId !== bot.providerUserId)
        throw new Error("Topic owner scope mismatch");
      const batches = Object.values(context.group.inputs ?? {})
        .filter((input) => input.taskId === params.taskId && input.admission === "accepted")
        .flatMap((input) => (input.source.topicContext ? [input.source.topicContext] : []));
      const parent =
        state.bots[
          getBotConversationKey({ botId: params.botId, chatId: params.chatId, chatType: "group" })
        ];
      const service = await resolveZCodeTaskServiceForContext({ ...context, ...workspace });
      const summaries =
        (await service.readBotTopicSummaries?.({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        })) ?? [];
      return {
        messageCount: new Set(batches.flatMap((batch) => batch.messages.map((record) => record.id)))
          .size,
        hasGap: batches.some((batch) => batch.hasGap),
        historyEnabled: parent?.group?.historyEnabled !== false,
        summaries,
      };
    },
    async retryTopicPreparation(params) {
      const key = getBotConversationKey({ ...params, chatType: "group" });
      const context = (await repo.readState()).bots[key];
      const bot = findBot(await repo.readConfig(), params.botId);
      if (!bot?.enabled || !context?.group?.enabled || context.group.ownerId !== bot.providerUserId)
        throw new Error("Topic preparation target is no longer authorized");
      if (context.activeTaskId !== params.taskId) throw new Error("Topic preparation task changed");
      if (
        getWorkspaceKey(context.workspacePath, context.workspaceIdentity) !==
        getWorkspaceKey(params.workspacePath, params.workspaceIdentity)
      )
        throw new Error("Topic preparation workspace changed");
      await topicContinuations.get(key)?.settled();
      // Submitted commands only query the original receipt; material retries respect dedupe and never strand a permanent preparing state.
      const latest = (await repo.readState()).bots[key];
      if (
        Object.values(latest?.group?.inputs ?? {}).some(
          (input) =>
            input.source.messageId === params.messageId ||
            input.source.messages?.some((original) => original.messageId === params.messageId),
        )
      )
        throw new Error("Topic input was already submitted; preparation cannot be retried");
      const message = topicPreparation.retry(key, params.messageId);
      if (!message) throw new Error("Topic preparation is no longer retryable");
      topicPreparation.update(key, [params.messageId], "preparing");
      await publishTopicPreparation();
      const replies = await service.handleInboundMessage(message);
      for (const reply of replies) await sendOutbound(bot, reply);
    },
    async replyToChannel(request) {
      return replyToBotChannel(request, {
        readState: () => repo.readState(),
        readConfig: () => repo.readConfig(),
        listMembers: async (bot, chatId) => {
          const read = providers[bot.provider]?.getGroupMemberNames;
          if (!read) throw new Error("Channel member lookup unavailable");
          return read(bot, chatId);
        },
        deliver: (bot, chatId, threadId, result) =>
          getGroupDeliverySender(bot, chatId, threadId)(result),
      });
    },
    async getBotStates() {
      return Object.entries((await repo.readState()).bots).map(([key, context]) => {
        if (context.group)
          context = {
            ...context,
            group: { ...context.group, preparation: topicPreparation.snapshot(key) },
          };
        const sender = groupDeliverySenders.get(key);
        if (!context.group || !sender) return context;
        return {
          ...context,
          group: {
            ...context.group,
            deliveries: Object.fromEntries(
              Object.entries(context.group.deliveries ?? {}).map(([id, result]) => [
                id,
                sender.project(result),
              ]),
            ),
          },
        };
      });
    },
    async reconcileGroupResult(params: {
      botId: string;
      chatId: string;
      deliveryId: string;
      threadId?: string;
      received: boolean;
    }) {
      const key = getBotConversationKey({
        botId: params.botId,
        chatType: "group",
        chatId: params.chatId,
        threadId: params.threadId,
      });
      let reconciled: BotGroupDelivery | undefined;
      await serializeStateWrite(async () => {
        const bot = findBot(await repo.readConfig(), params.botId);
        const state = await repo.readState();
        const context = state.bots[key];
        const result = context?.group?.deliveries?.[params.deliveryId];
        if (
          !bot?.enabled ||
          !context?.group?.enabled ||
          context.group.ownerId !== bot.providerUserId ||
          !result ||
          result.taskId !== context.activeTaskId ||
          result.status !== "unknown" ||
          groupDeliverySenders.get(key)?.isInFlight(params.deliveryId)
        ) {
          throw new Error("Saved group result cannot be reconciled in the current state");
        }
        reconciled = {
          ...result,
          status: params.received ? "sent" : "failed",
          lastError: undefined,
          updatedAt: Date.now(),
        };
        context.group.deliveries = { ...context.group.deliveries, [result.id]: reconciled };
        await repo.writeState(state);
      });
      await deps.broadcastService
        ?.send({
          channel: "bots:group-state",
          payload: { botId: params.botId, chatId: params.chatId },
        })
        .catch(() => undefined);
      return reconciled!;
    },
    async resendGroupResult(params: {
      botId: string;
      chatId: string;
      threadId?: string;
      deliveryId: string;
    }) {
      const bot = findBot(await repo.readConfig(), params.botId);
      if (!bot || !isFeishuBotProvider(bot.provider)) throw new Error("Group bot unavailable");
      const key = getBotConversationKey({
        botId: params.botId,
        chatType: "group",
        chatId: params.chatId,
        threadId: params.threadId,
      });
      const result = (await repo.readState()).bots[key]?.group?.deliveries?.[params.deliveryId];
      if (!result) throw new Error("Saved group result unavailable");
      await getGroupDeliverySender(bot, params.chatId, params.threadId)(result, true);
      return (await repo.readState()).bots[key]?.group?.deliveries?.[params.deliveryId] ?? result;
    },
    async setGroupEnabled(params: { botId: string; chatId: string; enabled: boolean }) {
      const bot = findBot(await repo.readConfig(), params.botId);
      if (!bot?.providerUserId) throw new Error("Bot owner unavailable");
      await handleGroupActivation(
        {
          botId: bot.id,
          actor: {
            provider: bot.provider,
            botId: bot.id,
            chatType: "group",
            chatId: params.chatId,
            providerUserId: bot.providerUserId,
          },
          text: params.enabled ? "/enable" : "/disable",
        },
        params.enabled,
      );
    },
    async retryPrivateDelivery({ botId, deliveryId }) {
      const failed = failedPrivateDeliveries.get(botId);
      const bot = findBot(await repo.readConfig(), botId);
      const context = (await repo.readState()).bots[botId];
      const recipient =
        bot?.provider === "weixin" ? context?.privateRecipientId : bot?.providerUserId;
      if (
        !failed ||
        failed.id !== deliveryId ||
        failed.sending ||
        !bot?.enabled ||
        context?.privateBindingId !== failed.bindingId ||
        context?.activeTaskId !== failed.taskId ||
        recipient !== failed.message.providerUserId
      )
        throw new Error("Private delivery is no longer available");
      failed.sending = true;
      try {
        await sendOutbound(bot, failed.message);
        if (failedPrivateDeliveries.get(botId) === failed) {
          failedPrivateDeliveries.delete(botId);
          const runtime = runtimeByBotId.get(botId);
          if (runtime)
            setRuntimeStatus({ ...runtime, deliveryRetryId: undefined, deliveryError: undefined });
        }
      } finally {
        failed.sending = false;
      }
    },
    async resetBotState(contextKey: string) {
      await serializeStateWrite(async () => {
        const state = await repo.readState();
        delete state.bots[contextKey];
        await repo.writeState(state);
      });
      await reconcilePrivateSynchronization(contextKey);
    },
    watchAutomationRun,
    async handleInboundMessage(message: BotInboundMessage) {
      if (shutdownPromise) return [];
      if (message.senderType === "app") {
        // Bots only use groups/topics a human enabled; a native @ may trigger normal input but grants no control.
        if (
          message.actor.chatType !== "group" ||
          message.groupCardAction ||
          message.elicitationResponse
        )
          return [];
        const topic = (await repo.readState()).bots[
          getBotConversationKey({ ...message.actor, conversationThreadId: undefined })
        ];
        if (!topic?.group?.enabled) return [];
        if (message.actor.threadId) {
          if (topic.group.topicActive !== true) return [];
        } else if (message.mentionedBot !== true || topic.group.chatMode === "topic") {
          return [];
        }
      }
      message = {
        ...message,
        actor: { ...message.actor, mentionedBot: message.mentionedBot === true },
      };
      if (
        message.actor.chatType === "group" &&
        message.mentionedBot === false &&
        !message.groupCardAction
      ) {
        const topic = (await repo.readState()).bots[
          getBotConversationKey({ ...message.actor, conversationThreadId: undefined })
        ];
        if (
          !message.actor.threadId ||
          topic?.group?.topicActive === false ||
          (!topic?.group?.topicActive &&
            message.topicRootIsCurrentBot !== true &&
            !topicContinuations.has(getBotConversationKey(message.actor)))
        )
          return [];
      }

      if (message.actor.chatType === "group" && message.actor.threadId) {
        const actor: BotActor = { ...message.actor, conversationThreadId: undefined };
        const state = await repo.readState();
        if (!state.bots[getBotConversationKey(actor)]) {
          // The alias exists only for a one-time safe migration check and must not route topics to the default task again.
          for (const candidate of Object.values(state.bots)) {
            const group = candidate.group;
            if (!group || candidate.botId !== actor.botId || group.chatId !== actor.chatId)
              continue;
            const alias = group.topicAliases?.[actor.threadId!];
            if (!alias) continue;
            // The default session may have switched workspaces; migration checks must use the old task's full workspace identity.
            const workspace = group.taskWorkspaces?.[alias.taskId] ?? candidate;
            const service = await resolveZCodeTaskServiceForContext({ ...candidate, ...workspace });
            if (
              !service.getBotGroupTaskBlockReason ||
              (await service.getBotGroupTaskBlockReason({
                taskId: alias.taskId,
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
              }))
            ) {
              return [
                createOutbound(
                  actor,
                  "The original topic task is still running. Re-attach to the topic once it finishes.",
                ),
              ];
            }
          }
        }
        message = { ...message, actor };
      }
      if (message.actor.chatType === "group" && !message.groupCardAction) {
        const parent = (await repo.readState()).bots[
          getBotConversationKey({
            ...message.actor,
            threadId: undefined,
            conversationThreadId: undefined,
          })
        ];
        // Dedicated-topic groups may omit thread_id on root events; resolve via the native message, never the default task.
        if (
          parent?.group?.enabled &&
          parent.group.chatMode === "topic" &&
          !message.actor.threadId
        ) {
          const bot = findBot(await repo.readConfig(), message.botId);
          const resolve = bot && providers[bot.provider]?.resolveTopic;
          if (!bot || !resolve) throw new Error("Topic routing is unavailable");
          message = {
            ...message,
            actor: { ...message.actor, ...(await resolve(bot, message.actor)) },
          };
        }
      }
      if (
        message.actor.chatType === "group" &&
        !message.groupCardAction &&
        !message.elicitationResponse &&
        message.mentionedBot === false &&
        message.contentParts?.some((part) => part.type === "channelMention")
      ) {
        // Bound topics used to treat tasks aimed elsewhere as new instructions; record the backfill boundary only, no stops or CLI admission.
        if (message.actor.threadId)
          await serializeStateWrite(async () => {
            const state = await repo.readState();
            const current = state.bots[getBotConversationKey(message.actor)];
            if (!current?.group?.enabled || current.group.topicActive !== true) return;
            const accepted = Object.values(current.group.inputs ?? {}).filter(
              (input) => input.admission === "accepted",
            );
            current.group.backgroundHistory = {
              revision: randomUUID(),
              checkpoint: current.group.backgroundHistory
                ? current.group.backgroundHistory.checkpoint
                : accepted.at(-1)?.source.messageId,
            };
            await repo.writeState(state);
          });
        return [];
      }
      // Bot-generated slash/approval text is input material only and never enters control branches.
      const commandType =
        message.senderType === "app"
          ? "message"
          : parseBotCommand(message.commandText ?? message.text).type;
      const isGroupControl =
        message.actor.chatType === "group" &&
        (Boolean(message.elicitationResponse) ||
          [
            "queue.cancel",
            "stop",
            "topic.leave",
            "permission.respond",
            "approve",
            "deny",
            "elicitation.respond",
            "elicitation.submit",
          ].includes(commandType));
      const processInbound = async () => {
        await capturePrivateContextToken(message);
        if (message.elicitationResponse) {
          return handleStructuredElicitationResponse(message, message.elicitationResponse);
        }
        const parsedCommand = parseBotCommand(message.commandText ?? message.text);
        // Owner chats flow through this dispatcher too; changing only the outer commandType cannot stop bots triggering control/numeric choices.
        const command =
          message.senderType === "app"
            ? ({ type: "message", text: message.text } as const)
            : parsedCommand.type === "message"
              ? (resolvePendingSelectionCommand(message.actor, parsedCommand.text) ?? parsedCommand)
              : parsedCommand.type === "selection.cancel" &&
                  message.actor.provider !== "weixin" &&
                  (message.commandText ?? message.text).trim() === "0"
                ? (clearPendingSelection(message.actor),
                  { type: "message", text: message.text } as const)
                : parsedCommand;
        const weixinActivationReply = await handleWeixinFirstActivation(message, command);
        if (weixinActivationReply) {
          await capturePrivateContextToken(message);
          return weixinActivationReply;
        }
        switch (command.type) {
          case "queue.cancel":
            return cancelGroupInput(message, command.commandId);
          case "group.enable":
            return handleGroupActivation(message, true);
          case "group.disable":
            return handleGroupActivation(message, false);
          case "group.history":
            return handleGroupHistory(message, command.enabled);
          case "selection.cancel":
            return handleSelectionCancel(message);
          case "bind":
            return handleBind(message, command.code);
          case "help":
            return handleHelp(message);
          case "status":
            return handleStatus(message);
          case "reconnect":
            return handleReconnect(message);
          case "new": {
            const auth = await withAuthorizedContext(message, "new");
            if (!auth.ok) return auth.reply;
            if (message.actor.threadId)
              return [
                createOutbound(
                  message.actor,
                  auth.locale === "en-US"
                    ? "Open another topic to start a new task."
                    : "请另开一个话题开始新任务。",
                ),
              ];
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            const context = await writeDraftContext(
              auth.context,
              await buildActiveTaskDraftOptions(auth.context),
            );
            return createStatusReply(message.actor, context, auth.locale);
          }
          case "workspace.list": {
            const auth = await withAuthorizedContext(message, "workspace");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              // Bugfix: hide the workspace picker while a task runs so users do not expect a context switch.
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            const synced = await normalizeBotWorkspaceConfig(
              auth.config,
              auth.bot,
              createCurrentWorkspaceRef(auth.context),
            );
            const visibleWorkspaces = filterAllowedWorkspaces(
              synced.workspaces,
              synced.user.allowedWorkspaces,
            );
            const options = visibleWorkspaces.map((workspace) => ({
              id: workspace.id,
              // Bugfix: button channels like Telegram/Feishu show labels only, never descriptions.
              // Fold the remote mark into the label or the /workspace list hides which entries are remote.
              label: formatWorkspaceOptionLabel(workspace, auth.locale),
            }));
            if (options.length === 0) {
              pendingWorkspaceSelectionsByContext.delete(getActorContextKey(message.actor));
              return [createOutbound(message.actor, msg(auth.locale, "workspaceMissing"))];
            }
            // Bugfix: remote workspace options must preserve workspaceIdentity at display time.
            // Telegram/Feishu buttons turn clicks into /workspace indexes; re-resolving from settings mid-switch
            // The current remote context may be missing from candidates, surfacing as /workspace not supporting remote.
            pendingWorkspaceSelectionsByContext.set(
              getActorContextKey(message.actor),
              new Map(visibleWorkspaces.map((workspace) => [workspace.id, { workspace }])),
            );
            return createSelectionReply(
              message.actor,
              {
                id: `workspace-${Date.now()}`,
                title: msg(auth.locale, "workspaceSelectTitle", {
                  workspace:
                    visibleWorkspaces.find((workspace) => workspace.id === auth.context.workspaceId)
                      ?.label ?? auth.context.workspacePath,
                }),
                currentId: auth.context.workspaceId,
                action: "workspace.set",
                options,
              },
              auth.locale,
            );
          }
          case "workspace.set": {
            const auth = await withAuthorizedContext(message, "workspace");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            const synced = await normalizeBotWorkspaceConfig(
              auth.config,
              auth.bot,
              createCurrentWorkspaceRef(auth.context),
            );
            const workspace =
              resolvePendingWorkspaceSelectionEntry(message.actor, command.value)?.workspace ??
              resolveWorkspaceByValue(
                synced.workspaces,
                command.value,
                synced.user.allowedWorkspaces,
              );
            if (!workspace)
              return [createOutbound(message.actor, msg(auth.locale, "workspaceMissing"))];
            const context = {
              ...auth.context,
              workspacePath: workspace.workspacePath,
              workspaceIdentity: workspace.workspaceIdentity,
              workspaceId: workspace.id,
            };
            const draftContext = await writeDraftContext(
              context,
              await buildInitializedDraftOptions(context),
            );
            pendingWorkspaceSelectionsByContext.delete(getActorContextKey(message.actor));
            return createStatusReply(message.actor, draftContext, auth.locale);
          }
          case "model.list": {
            const auth = await withAuthorizedContext(message, "model");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              // Bugfix: hide the model picker while a task runs to avoid an unusable pending selection.
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await resolveDraftOptionsForDisplay(auth.context);
              const providers = await listModelProviderOptionsForActiveTask(
                {
                  model: formatBotModelSelectionValue(draftOptions.modelSelection),
                  workspacePath: auth.context.workspacePath,
                  workspaceIdentity: auth.context.workspaceIdentity,
                },
                draftOptions.provider,
              );
              if (providers.length === 0) {
                return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
              }
              const currentProviderId = await readCurrentModelProviderId(
                {
                  model: formatBotModelSelectionValue(draftOptions.modelSelection),
                  workspacePath: auth.context.workspacePath,
                  workspaceIdentity: auth.context.workspaceIdentity,
                },
                [],
                draftOptions.provider,
              );
              return createSelectionReply(
                message.actor,
                {
                  id: `model-${Date.now()}`,
                  title: msg(auth.locale, "modelProviderSelectTitle", {
                    model: await formatStatusModelLabel(
                      formatBotModelSelectionValue(draftOptions.modelSelection),
                      auth.context,
                    ),
                  }),
                  currentId: currentProviderId,
                  action: "model.provider.set",
                  options: providers,
                },
                auth.locale,
              );
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
            if (!activeProvider) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const providers = await listModelProviderOptionsForActiveTask(
              active.task,
              activeProvider,
            );
            if (providers.length === 0) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const currentValue = readCurrentActiveTaskModel(active.task, active.configOptions);
            const currentProviderId = await readCurrentModelProviderId(
              active.task,
              active.configOptions,
              activeProvider,
            );
            return createSelectionReply(
              message.actor,
              {
                id: `model-${Date.now()}`,
                title: msg(auth.locale, "modelProviderSelectTitle", {
                  model: await formatStatusModelLabel(currentValue, active.task),
                }),
                currentId: currentProviderId,
                action: "model.provider.set",
                options: providers,
              },
              auth.locale,
            );
          }
          case "model.provider.set": {
            const auth = await withAuthorizedContext(message, "model");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await resolveDraftOptionsForDisplay(auth.context);
              const draftTask = {
                model: formatBotModelSelectionValue(draftOptions.modelSelection),
                workspacePath: auth.context.workspacePath,
                workspaceIdentity: auth.context.workspaceIdentity,
              };
              const providers = await listModelProviderOptionsForActiveTask(
                draftTask,
                draftOptions.provider,
              );
              const provider =
                resolvePendingSelectionOption(message.actor, "model.provider.set", command.value) ??
                resolveOptionByValue(providers, command.value);
              const providerId = provider?.id;
              if (!providerId) {
                return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
              }
              const providerModels = readModelProviderSelectionModels(provider);
              const options =
                providerModels.length > 0
                  ? providerModels
                  : await listModelOptionsForProviderFromActiveTask(
                      draftTask,
                      draftOptions.provider,
                      providerId,
                    );
              if (options.length === 0) {
                return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
              }
              return createSelectionReply(
                message.actor,
                {
                  id: `model-${Date.now()}`,
                  title: msg(auth.locale, "modelModelSelectTitle", {
                    model: formatBotModelSelectionValue(draftOptions.modelSelection) ?? "-",
                  }),
                  currentId: options.some(
                    (option) =>
                      option.id === formatBotModelSelectionValue(draftOptions.modelSelection),
                  )
                    ? formatBotModelSelectionValue(draftOptions.modelSelection)
                    : undefined,
                  action: "model.set",
                  options,
                },
                auth.locale,
              );
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
            if (!activeProvider) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const providers = await listModelProviderOptionsForActiveTask(
              active.task,
              activeProvider,
            );
            const provider =
              resolvePendingSelectionOption(message.actor, "model.provider.set", command.value) ??
              resolveOptionByValue(providers, command.value);
            const providerId = provider?.id;
            if (!providerId) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const providerModels = readModelProviderSelectionModels(provider);
            const options =
              providerModels.length > 0
                ? providerModels
                : await listModelOptionsForProviderFromActiveTask(
                    active.task,
                    activeProvider,
                    providerId,
                  );
            if (options.length === 0) {
              return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            }
            const currentValue = readCurrentActiveTaskModel(active.task, active.configOptions);
            return createSelectionReply(
              message.actor,
              {
                id: `model-${Date.now()}`,
                title: msg(auth.locale, "modelModelSelectTitle", {
                  model: currentValue ?? "-",
                }),
                currentId: options.some((option) => option.id === currentValue)
                  ? currentValue
                  : undefined,
                action: "model.set",
                options,
              },
              auth.locale,
            );
          }
          case "model.set": {
            const auth = await withAuthorizedContext(message, "model");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await ensureDraftOptions(auth.context);
              const model =
                resolvePendingSelectionOption(message.actor, "model.set", command.value) ??
                resolveOptionByValue(
                  await listAllModelOptionsForActiveTask(
                    {
                      model: formatBotModelSelectionValue(draftOptions.modelSelection),
                      workspacePath: auth.context.workspacePath,
                      workspaceIdentity: auth.context.workspaceIdentity,
                    },
                    draftOptions.provider,
                  ),
                  command.value,
                );
              if (!model) {
                return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
              }
              const identity = parseBotModelOptionValue(model.id);
              const view = await readModelSelectionView(auth.context);
              const selection =
                view && identity ? completeNewModelSelection(view, identity) : undefined;
              // Bot-initiated model picks must also take the target's top tier; a stale menu or read failure must not clear the saved choice.
              if (!selection)
                return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
              const nextContext = await writeDraftOptions(auth.context, {
                ...draftOptions,
                // A model-identity switch builds a fresh Selection; never carry over the old model's explicit options.
                modelSelection: selection,
              });
              return createStatusReply(message.actor, nextContext, auth.locale);
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
            if (!activeProvider) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const model =
              resolvePendingSelectionOption(message.actor, "model.set", command.value) ??
              resolveOptionByValue(
                await listAllModelOptionsForActiveTask(active.task, activeProvider),
                command.value,
              );
            if (!model) return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            const nextModel = model.id;
            const customModel = decodeCustomModelValue(nextModel);
            const targetModel = customModel
              ? resolveCustomModelRuntimeModelId(activeProvider, customModel)
              : nextModel;
            if (!targetModel) {
              return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            }
            const targetIdentity = customModel?.modelName
              ? {
                  // Bugfix: with custom providers, bot /model selection degrades targetModel to a bare model name.
                  // The legacy task facade also needs the original provider identity or same-named models fall back to glm/native.
                  providerId: customModel.providerId,
                  modelId: customModel.modelName,
                }
              : { providerId: activeProvider, modelId: targetModel };
            const view = await readModelSelectionView(active.task);
            const targetModelSelection = view
              ? completeNewModelSelection(view, targetIdentity)
              : undefined;
            if (!targetModelSelection)
              return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            const traceId = generateTraceId(active.taskId);
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(active.task);
            const configOptions = await zcodeTaskService.setModel({
              taskId: active.taskId,
              traceId,
              modelSelection: targetModelSelection,
            });
            await broadcastTaskConfigSync({
              context: auth.context,
              taskId: active.taskId,
              task: await readContextActiveTaskMeta(auth.context),
              provider: activeProvider,
              configOptions,
            });
            return createStatusReply(message.actor, auth.context, auth.locale);
          }
          case "mode.list":
          case "thoughtLevel.list": {
            const commandName = command.type === "mode.list" ? "mode" : "thoughtLevel";
            const auth = await withAuthorizedContext(message, commandName);
            if (!auth.ok) return auth.reply;
            if (command.type === "mode.list" && !auth.context.group) {
              // Hard-locked to yolo: no mode picker.
              return [createOutbound(message.actor, msg(auth.locale, "modeLocked"))];
            }
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              // Bugfix: hide mode/thinking-level pickers while a task runs to avoid confusing the in-flight configuration.
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await ensureDraftOptions(auth.context);
              const optionSource = await listDraftConfigOptions(auth.context, draftOptions);
              const rawCurrentValue =
                commandName === "mode"
                  ? draftOptions.mode
                  : findSelectConfigOption(optionSource, commandName)?.currentValue;
              const currentValue =
                typeof rawCurrentValue === "string" ? rawCurrentValue : undefined;
              const currentLabel = readConfigSelectLabelForValue(
                optionSource,
                commandName,
                currentValue,
                { locale: auth.locale, provider: draftOptions.provider },
              );
              const selectOption = findSelectConfigOption(optionSource, commandName);
              const options = listConfigSelectOptions(optionSource, commandName, {
                locale: auth.locale,
                provider: draftOptions.provider,
              });
              if (options.length === 0) {
                return [
                  createOutbound(
                    message.actor,
                    msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                  ),
                ];
              }
              return createSelectionReply(
                message.actor,
                {
                  id: `${selectOption?.id ?? commandName}-${Date.now()}`,
                  title:
                    commandName === "mode"
                      ? msg(auth.locale, "modeSelectTitle", {
                          mode: currentLabel ?? "-",
                        })
                      : msg(auth.locale, "thoughtLevelSelectTitle", {
                          level: currentLabel ?? "-",
                        }),
                  currentId: currentValue,
                  action: `${commandName}.set` as SelectionPrompt["action"],
                  options,
                },
                auth.locale,
              );
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const optionSource =
              commandName === "mode" && active.task.provider
                ? await listProviderConfigOptionsForActiveTask(
                    active.task,
                    normalizeAgentProviderToZCodeAgent(active.task.provider),
                  )
                : active.configOptions;
            const currentValue =
              commandName === "mode"
                ? readCurrentActiveTaskMode(active.task, active.configOptions)
                : readConfigSelectCurrentValue(active.configOptions, commandName);
            const currentLabel =
              commandName === "mode"
                ? readConfigSelectLabelForValue(optionSource, commandName, currentValue, {
                    locale: auth.locale,
                    provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
                  })
                : readConfigSelectCurrentLabel(active.configOptions, commandName, {
                    locale: auth.locale,
                    provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
                  });
            const selectOption = findSelectConfigOption(optionSource, commandName);
            const options = listConfigSelectOptions(optionSource, commandName, {
              locale: auth.locale,
              provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
            });
            if (options.length === 0) {
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                ),
              ];
            }
            return createSelectionReply(
              message.actor,
              {
                id: `${selectOption?.id ?? commandName}-${Date.now()}`,
                title:
                  commandName === "mode"
                    ? msg(auth.locale, "modeSelectTitle", {
                        mode: currentLabel ?? "-",
                      })
                    : msg(auth.locale, "thoughtLevelSelectTitle", {
                        level: currentLabel ?? "-",
                      }),
                currentId: currentValue,
                action: `${commandName}.set` as SelectionPrompt["action"],
                options,
              },
              auth.locale,
            );
          }
          case "mode.set":
          case "thoughtLevel.set": {
            const commandName = command.type === "mode.set" ? "mode" : "thoughtLevel";
            const auth = await withAuthorizedContext(message, commandName);
            if (!auth.ok) return auth.reply;
            if (command.type === "mode.set" && !auth.context.group) {
              // Hard-locked to yolo: reject every mode switch.
              return [createOutbound(message.actor, msg(auth.locale, "modeLocked"))];
            }
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const originalOptions = await ensureDraftOptions(auth.context);
              const view = await readModelSelectionView(
                auth.context,
                originalOptions.modelSelection,
              );
              const optionSource = await listDraftConfigOptions(
                auth.context,
                originalOptions,
                view,
              );
              // One snapshot carries candidates and the current model; a stale intent must not fall back to preferred on an empty copy.
              const draftOptions = {
                ...originalOptions,
                modelSelection:
                  (originalOptions.modelSelection
                    ? view?.effectiveSelection
                    : view?.preferredSelection) ?? undefined,
              };
              const displayOptions = listConfigSelectOptions(optionSource, commandName, {
                locale: auth.locale,
                provider: draftOptions.provider,
              });
              const option =
                resolvePendingSelectionOption(
                  message.actor,
                  `${commandName}.set` as SelectionPrompt["action"],
                  command.value,
                ) ?? resolveOptionByValue(displayOptions, command.value);
              if (option && !displayOptions.some((candidate) => candidate.id === option.id)) {
                return [
                  createOutbound(
                    message.actor,
                    msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                  ),
                ];
              }
              if (!option) {
                return [
                  createOutbound(
                    message.actor,
                    msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                  ),
                ];
              }
              const nextContext = await writeDraftOptions(auth.context, {
                ...draftOptions,
                ...(commandName === "mode"
                  ? { mode: option.id }
                  : draftOptions.modelSelection
                    ? {
                        modelSelection: {
                          ...draftOptions.modelSelection,
                          options: {
                            ...draftOptions.modelSelection.options,
                            reasoningLevel: option.id,
                          },
                        },
                      }
                    : {}),
              });
              return createStatusReply(message.actor, nextContext, auth.locale);
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const optionSource =
              commandName === "mode" && active.task.provider
                ? await listProviderConfigOptionsForActiveTask(active.task, active.task.provider)
                : active.configOptions;
            const selectOption = findSelectConfigOption(optionSource, commandName);
            const displayOptions = listConfigSelectOptions(optionSource, commandName, {
              locale: auth.locale,
              provider: active.task.provider,
            });
            const option =
              resolvePendingSelectionOption(
                message.actor,
                `${commandName}.set` as SelectionPrompt["action"],
                command.value,
              ) ?? resolveOptionByValue(displayOptions, command.value);
            if (!option) {
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                ),
              ];
            }
            if (!selectOption?.id) {
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                ),
              ];
            }
            const traceId = generateTraceId(active.taskId);
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const configOptions = await zcodeTaskService.setConfigOption({
              taskId: active.taskId,
              traceId,
              configId: selectOption.id,
              value: option.id,
            });
            await broadcastTaskConfigSync({
              context: auth.context,
              taskId: active.taskId,
              task: await readContextActiveTaskMeta(auth.context),
              provider: active.task.provider,
              configOptions,
            });
            return createStatusReply(message.actor, auth.context, auth.locale);
          }
          case "task.list":
            return handleTaskList(message);
          case "task.set": {
            const auth = await withAuthorizedContext(message, "task");
            if (!auth.ok) return auth.reply;
            if (message.actor.threadId)
              return createStatusReply(message.actor, auth.context, auth.locale);
            const taskEntry = await resolveTaskSelectionEntry(
              message,
              auth.context,
              auth.user,
              command.value,
            );
            if (!taskEntry) return [createOutbound(message.actor, msg(auth.locale, "taskMissing"))];
            const { task } = taskEntry;
            const blockReason =
              auth.context.activeTaskId !== task.taskId
                ? await getContextTaskBlockReason(auth.context)
                : null;
            if (blockReason) {
              // Bugfix: the running task already holds a third-party stream subscription.
              // Letting /task rewrite activeTaskId now would land later inputs on the new task,
              // but the old task's output keeps landing in the same chat, reading like crossed wires.
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            const nextContext = {
              ...auth.context,
              workspacePath: taskEntry.workspacePath,
              workspaceIdentity: taskEntry.workspaceIdentity,
              workspaceId: getWorkspaceKey(taskEntry.workspacePath, taskEntry.workspaceIdentity),
              mode: "task",
              activeTaskId: task.taskId,
            } satisfies BotContextState;
            await writeContext(nextContext);
            if (auth.context.activeTaskId !== nextContext.activeTaskId)
              stopGroupSynchronization(auth.context);
            await restoreGroupSynchronization(nextContext);
            pendingTaskSelectionsByContext.delete(getActorContextKey(message.actor));
            return createStatusReply(message.actor, nextContext, auth.locale);
          }
          case "reply.list": {
            const auth = await withAuthorizedContext(message, "reply");
            if (!auth.ok) return auth.reply;
            return createSelectionReply(
              message.actor,
              {
                id: `reply-${Date.now()}`,
                title: msg(auth.locale, "replySelectTitle", {
                  mode: formatReplyGranularityLabel(
                    auth.bot.replyMode,
                    auth.locale,
                    auth.bot.provider,
                  ),
                }),
                currentId: normalizeBotReplyGranularity(auth.bot.provider, auth.bot.replyMode),
                action: "reply.set",
                options: getReplyGranularityOptions(auth.locale, auth.bot.provider),
              },
              auth.locale,
            );
          }
          case "reply.set": {
            const auth = await withAuthorizedContext(message, "reply");
            if (!auth.ok) return auth.reply;
            const replyGranularity = resolveReplyGranularityByValue(
              command.value,
              auth.locale,
              auth.bot.provider,
            );
            if (!replyGranularity)
              return [createOutbound(message.actor, msg(auth.locale, "replyMissing"))];
            await service.saveBot({
              bot: {
                ...auth.bot,
                replyMode: replyGranularity.id,
              },
            });
            return createStatusReply(message.actor, auth.context, auth.locale);
          }
          case "topic.leave": {
            const auth = await withAuthorizedContext(message, "workspace");
            if (!auth.ok) return auth.reply;
            if (!auth.context.group?.threadId)
              return [
                createOutbound(
                  message.actor,
                  auth.locale === "en-US"
                    ? "Use /leave inside a topic."
                    : "请在话题中使用 /leave。",
                ),
              ];
            await cancelTopicInputs(message.actor);
            await serializeStateWrite(async () => {
              const state = await repo.readState();
              const current = state.bots[getBotStateKey(auth.context)];
              if (current?.group) current.group.topicActive = false;
              await repo.writeState(state);
            });
            if (auth.context.activeTaskId) {
              const service = await resolveZCodeTaskServiceForContext(auth.context);
              const target = {
                taskId: auth.context.activeTaskId,
                workspacePath: auth.context.workspacePath,
                workspaceIdentity: auth.context.workspaceIdentity,
              };
              if (!service.readBotTopicExecution || !service.stopBotTopicExecution)
                throw new Error("Topic runtime control is unavailable");
              const executionId = await service.readBotTopicExecution(target);
              if (executionId) await stopTopicRun(auth.context, executionId.executionId);
            }
            return [
              createOutbound(
                message.actor,
                auth.locale === "en-US"
                  ? "Left this topic. Mention me to resume the same task."
                  : "已退出话题。再次 @我可继续原任务。",
              ),
            ];
          }
          case "stop": {
            const auth = await withAuthorizedContext(message, "stop");
            if (!auth.ok) return auth.reply;
            if (auth.context.group?.threadId) await cancelTopicInputs(message.actor);
            if (!auth.context.activeTaskId) {
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            }
            try {
              const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
              if (auth.context.group?.threadId) {
                if (!zcodeTaskService.readBotTopicExecution)
                  throw new Error("Topic runtime control is unavailable");
                const executionId = await zcodeTaskService.readBotTopicExecution({
                  taskId: auth.context.activeTaskId,
                  workspacePath: auth.context.workspacePath,
                  workspaceIdentity: auth.context.workspaceIdentity,
                });
                if (executionId) await stopTopicRun(auth.context, executionId.executionId);
              } else await zcodeTaskService.stopGeneration({ taskId: auth.context.activeTaskId });
            } catch (error) {
              const messageText = error instanceof Error ? error.message : String(error);
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, "taskFailed", { message: messageText }),
                ),
              ];
            }
            runningTasks.delete(auth.context.activeTaskId);
            stopTyping(auth.context.activeTaskId);
            await broadcastTaskListChange(auth.context, auth.context.activeTaskId, "updated");
            // A successful group stop only updates state, so the status card cannot restart the bot ping-pong.
            return auth.context.group
              ? []
              : createStatusReply(message.actor, auth.context, auth.locale);
          }
          case "permission.respond": {
            const auth = await withAuthorizedContext(message, "approve");
            if (!auth.ok) return auth.reply;
            if (!auth.context.activeTaskId)
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            const optionIndex = Number.parseInt(command.value, 10) - 1;
            const option = Number.isFinite(optionIndex)
              ? auth.context.pendingPermissionOptions?.[optionIndex]
              : undefined;
            botsLogger.info(
              undefined,
              `permission callback task=${auth.context.activeTaskId} user=${message.actor.providerUserId} optionIndex=${optionIndex + 1} pending=${auth.context.pendingPermissionOptions?.length ?? 0} option=${option ? `${option.command}:${option.optionId}` : "missing"} handled=${option?.handledAt ? "yes" : "no"}`,
            );
            if (!option)
              return [createOutbound(message.actor, msg(auth.locale, "permissionExpired"))];
            if (option.handledAt)
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const submitted = await zcodeTaskService.respondPermission({
              taskId: auth.context.activeTaskId,
              requestId: option.requestId,
              optionId: option.optionId,
              response: option.response,
            });
            // Fix: permissions and elicitations commit on the same v4 ACK. Nothing persists before it succeeds,
            // handledAt, or Telegram/text-index buttons cannot retry and the runtime keeps waiting on permission.
            const handledAt = Date.now();
            const nextPermissionOptions = auth.context.pendingPermissionOptions?.map((item) =>
              item.requestId === option.requestId ? { ...item, handledAt } : item,
            );
            botsLogger.info(
              undefined,
              `permission callback respond task=${auth.context.activeTaskId} requestId=${option.requestId} optionId=${option.optionId} submitted=${submitted}`,
            );
            if (!submitted) {
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            }
            await writeContext({
              ...auth.context,
              pendingPermissionOptions: nextPermissionOptions,
            });
            await broadcastTaskListChange(
              auth.context,
              auth.context.activeTaskId,
              "permission_resolved",
              {
                requestId: option.requestId,
              },
            );
            startTyping(auth.bot, message.actor, auth.context.activeTaskId);
            return [
              createOutbound(
                message.actor,
                msg(
                  auth.locale,
                  option.command === "deny" ? "permissionDenied" : "permissionSubmitted",
                ),
              ),
            ];
          }
          case "elicitation.respond": {
            const auth = await withAuthorizedContext(message, "message");
            if (!auth.ok) return auth.reply;
            return handlePendingElicitationValue(auth, message.actor, command.value);
          }
          case "elicitation.submit": {
            const auth = await withAuthorizedContext(message, "message");
            if (!auth.ok) return auth.reply;
            const pending = auth.context.pendingElicitation;
            if (!pending) {
              return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
            }
            if (message.actor.provider !== "weixin") {
              // Bugfix: on non-WeCom channels, "done" enters elicitation.respond from the token-bearing button.
              // A bare /elicitation submit carries no turn id and can submit the previous AskUserQuestion by mistake.
              return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
            }
            return submitPendingElicitation(
              auth,
              message.actor,
              pending,
              "accept",
              buildBotElicitationContent(pending),
            );
          }
          case "approve": {
            const auth = await withAuthorizedContext(message, "approve");
            if (!auth.ok) return auth.reply;
            if (!auth.context.activeTaskId)
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            const pendingOption = auth.context.pendingPermissionOptions?.find(
              (option) =>
                option.requestId === command.requestId && option.optionId === command.optionId,
            );
            if (!pendingOption) {
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            }
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const submitted = await zcodeTaskService.respondPermission({
              taskId: auth.context.activeTaskId,
              requestId: command.requestId,
              optionId: command.optionId,
              response: pendingOption.response,
            });
            if (!submitted)
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            await broadcastTaskListChange(
              auth.context,
              auth.context.activeTaskId,
              "permission_resolved",
              {
                requestId: command.requestId,
              },
            );
            startTyping(auth.bot, message.actor, auth.context.activeTaskId);
            return [createOutbound(message.actor, msg(auth.locale, "permissionSubmitted"))];
          }
          case "deny": {
            const auth = await withAuthorizedContext(message, "approve");
            if (!auth.ok) return auth.reply;
            if (!auth.context.activeTaskId)
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            const pendingOption = auth.context.pendingPermissionOptions?.find(
              (option) => option.requestId === command.requestId && option.command === "deny",
            );
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const submitted = await zcodeTaskService.respondPermission({
              taskId: auth.context.activeTaskId,
              requestId: command.requestId,
              optionId: "deny",
              response: pendingOption?.response ?? {
                decision: "deny",
                reason: "Denied by bot command",
              },
            });
            if (!submitted)
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            await broadcastTaskListChange(
              auth.context,
              auth.context.activeTaskId,
              "permission_resolved",
              {
                requestId: command.requestId,
              },
            );
            startTyping(auth.bot, message.actor, auth.context.activeTaskId);
            return [createOutbound(message.actor, msg(auth.locale, "permissionDenied"))];
          }
          case "unknown":
            return [
              createOutbound(
                message.actor,
                msg(await readMessageLocale(), "unknownCommand", {
                  command: command.name,
                }),
              ),
            ];
          case "message":
            return handleMessage(message);
        }
      };
      if (!(await admitAutoReplyTurn(message))) return [];
      const replies =
        message.actor.chatType === "group" && message.actor.threadId && commandType === "message"
          ? await receiveTopicMessage(message)
          : await enqueueInboundProcessing(message.actor, processInbound, isGroupControl);
      if (message.actor.chatType !== "group") return replies;
      const current = (await repo.readState()).bots[getBotConversationKey(message.actor)];
      return replies.map((reply) =>
        reply.selection && current?.group?.authorizationId
          ? {
              ...reply,
              threadId: message.actor.threadId ?? current.group.threadId,
              rootMessageId: message.actor.rootMessageId ?? current.group.rootMessageId,
              groupCard: groupCardFor(message.actor, current),
            }
          : reply,
      );
    },
    async handleProviderCallback(provider: BotProvider, payload: unknown) {
      return (await processProviderCallback(provider, payload)).replies;
    },
    async handleProviderCallbackResponse(provider: BotProvider, payload: unknown) {
      return processProviderCallback(provider, payload);
    },
    disposeAll() {
      void service.disposeAllAndWait().catch((error: unknown) => {
        botsLogger.warn(
          undefined,
          `dispose Bot runtimes failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    disposeAllAndWait() {
      if (shutdownPromise) {
        return shutdownPromise;
      }
      memoryDiagnostics.dispose();
      // Material downloads can outlive host shutdown; invalidate synchronously first, then reclaim the upload-side cancel generation.
      topicPreparation.clear();
      const pendingTopicKeys = [...topicContinuations.keys()];
      for (const key of pendingTopicKeys) {
        topicGenerations.set(key, (topicGenerations.get(key) ?? 0) + 1);
        topicContinuations.get(key)?.cancel();
        for (const resolve of topicReplies.get(key)?.values() ?? []) resolve([]);
        topicReplies.get(key)?.clear();
      }
      const cancelUploads = (async () => {
        const states = (await repo.readState()).bots;
        await Promise.all(
          pendingTopicKeys.map(async (key) => {
            const context = states[key];
            if (!context?.activeTaskId) return;
            const taskService = await resolveZCodeTaskServiceForContext(context);
            await taskService.invalidateBotTopicInputs?.({
              taskId: context.activeTaskId,
              workspacePath: context.workspacePath,
              workspaceIdentity: context.workspaceIdentity,
            });
          }),
        );
      })();
      for (const controller of streamingCardRequestControllers) {
        controller.abort(new Error("Bot service disposed."));
      }
      streamingCardRequestControllers.clear();
      for (const subscription of streamSubscriptions.values()) {
        subscription.dispose();
      }
      streamSubscriptions.clear();
      taskStreamHub.dispose();
      if (privateRecoveryTimer) clearInterval(privateRecoveryTimer);
      privateImTraces.clear();
      privateWatches.clear();
      failedPrivateDeliveries.clear();
      transientInteractionCards.clear();
      adminAttention.clear();
      for (const intervalId of typingIntervals.values()) {
        clearInterval(intervalId);
      }
      typingIntervals.clear();
      for (const [taskId] of typingTargets) {
        stopTyping(taskId);
      }
      runningTasks.clear();
      liveStatusProgressByTaskId.clear();
      pendingRemoteReconnectsByKey.clear();
      recentRemoteReconnectAtByKey.clear();
      recentRemoteReconnectDeliveryAtByKey.clear();
      recentInboundDeliveryAtByKey.clear();
      automationDeliveryWarningAtByKey.clear();
      inboundProcessingQueuesByContext.clear();
      // Bugfix: host teardown calls disposeAllAndWait first. Keeping one shared Promise ensures concurrent shutdown
      // run once, and before returning wait for all three provider runtime request, WebSocket, and cross-process locks to settle.
      shutdownPromise = Promise.allSettled([
        cancelUploads,
        telegramRuntime.dispose(),
        weixinRuntime.dispose(),
        feishuRuntime.dispose(),
      ]).then(() => undefined);
      return shutdownPromise;
    },
  };
  if (runStartupBackgroundTasks) {
    // Remote connections have no bot event source; check existing connections only, dial nothing, replay nothing.
    privateRecoveryTimer = setInterval(() => {
      if (shutdownPromise || privateRecoveryPending) return;
      privateRecoveryPending = true;
      void repo
        .readState()
        .then(async (state) => {
          for (const context of Object.values(state.bots))
            if (!context.group) await reconcilePrivateSynchronization(context.botId);
        })
        .catch(() => botsLogger.warn(undefined, "Private Bot recovery state unavailable"))
        .finally(() => {
          privateRecoveryPending = false;
        });
    }, 10_000);
    privateRecoveryTimer.unref();
    void telegramRuntime.refresh();
    void weixinRuntime.refresh();
    void feishuRuntime.refresh();
    void ensureBotStorageMigrated()
      .then(async () => {
        for (const context of Object.values((await repo.readState()).bots)) {
          await restoreGroupSynchronization(context);
          if (!context.group) await reconcilePrivateSynchronization(context.botId);
        }
      })
      .catch((error: unknown) => {
        // A first-read failure must stay visible without an unhandled rejection; the interaction entry still receives it directly.
        botsLogger.error(
          undefined,
          `Bot storage initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
  return service;
}
