/* oxlint-disable eslint(max-lines) -- Claude-native log parsing keeps user turns, assistant healing, and system-warning attribution in one place; splitting scatters the log semantics. */
import { stat } from "node:fs/promises";
import type { JsonLineRecord } from "#src/session/claude-native/jsonLineRecord.js";
import { readJsonLinesFile } from "#src/session/claude-native/sessionHistoryJsonl.js";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import { isObjectRecord, readTrimmedString } from "#src/session/claude-native/jsonLineRecord.js";
import type { ClaudeNativeImportedSessionSource } from "#src/session/claude-native/claudeNativeImportedSessionTypes.js";

const IDE_OPENED_FILE_TAG_RE = /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi;
const COMMAND_TAG_BLOCK_RE =
  /<(?:local-command|command)-[^>]+>[\s\S]*?<\/(?:local-command|command)-[^>]+>/gi;
const COMMAND_DIAGNOSTIC_TAG_RE = /<\/?(?:local-command|command)-[^>]+>/gi;

function toTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return Math.trunc(value);
    }
    if (value > 1_000_000_000) {
      return Math.trunc(value * 1000);
    }
    return undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  const numericValue = Number(normalized);
  if (Number.isFinite(numericValue)) {
    return toTimestampMs(numericValue);
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readEntryTimestamp(entry: JsonLineRecord): number | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
  const candidates = [
    entry.timestamp,
    entry.createdAt,
    entry.updatedAt,
    entry.created_at,
    entry.updated_at,
    entry.time,
    message?.timestamp,
    message?.createdAt,
    message?.updatedAt,
    request?.timestamp,
  ];

  for (const candidate of candidates) {
    const timestamp = toTimestampMs(candidate);
    if (timestamp !== undefined) {
      return timestamp;
    }
  }

  return undefined;
}

function readEntryWorkspacePath(entry: JsonLineRecord): string | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
  return (
    readTrimmedString(entry.cwd) ??
    readTrimmedString(message?.cwd) ??
    readTrimmedString(request?.cwd)
  );
}

function readEntryModel(entry: JsonLineRecord): string | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  return readTrimmedString(entry.model) ?? readTrimmedString(message?.model);
}

function isClaudeNativeSidechainEntry(entry: JsonLineRecord): boolean {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
  return (
    entry.isSidechain === true || message?.isSidechain === true || request?.isSidechain === true
  );
}

export function hasClaudeNativeSidechainMarker(entries: readonly JsonLineRecord[]): boolean {
  return entries.some(isClaudeNativeSidechainEntry);
}

function readAssistantStopReason(entry: JsonLineRecord): string | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  return (
    readTrimmedString(message?.stop_reason) ??
    readTrimmedString(message?.stopReason) ??
    readTrimmedString(entry.stop_reason) ??
    readTrimmedString(entry.stopReason)
  );
}

function isTerminalAssistantStopReason(stopReason: string | undefined): boolean {
  return Boolean(stopReason && stopReason !== "tool_use");
}

function sanitizeClaudeVisibleText(text: string): string {
  return text
    .replace(IDE_OPENED_FILE_TAG_RE, " ")
    .replace(COMMAND_TAG_BLOCK_RE, " ")
    .replace(/\r\n/g, "\n")
    .trim();
}

function sanitizeClaudeDiagnosticText(text: string): string {
  return text.replace(COMMAND_DIAGNOSTIC_TAG_RE, " ").replace(/\r\n/g, "\n").trim();
}

export function stripClaudeNativeSyntheticNoResponsePlaceholderText(text: string): string {
  return text
    .trimEnd()
    .replace(/(?:\n+\s*)?No response requested\.$/u, "")
    .trimEnd();
}

function isClaudeNativeSyntheticPlaceholderEntry(entry: JsonLineRecord): boolean {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  // Claude Code writes SDK-generated control placeholders as assistant entries,
  // e.g. model=<synthetic> 'No response requested.'. They carry no user value,
  // but API/login errors are assistant bubbles users saw in Claude and must survive import.
  return (
    readEntryModel(entry) === "<synthetic>" &&
    entry.isApiErrorMessage !== true &&
    message?.isApiErrorMessage !== true
  );
}

function extractTextField(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!isObjectRecord(value)) {
    return "";
  }

  return readTrimmedString(value.text) ?? readTrimmedString(value.content) ?? "";
}

function extractClaudeUserText(entry: JsonLineRecord): string | null {
  if (entry.type !== "user") {
    return null;
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  if (entry.isMeta === true || message?.isMeta === true) {
    return null;
  }

  // Core rule: extract only problem text the user actually saw.
  // tool_result/local-command/ide_opened_file entries also appear in native logs,
  // but they are protocol noise or IDE injections; importing them verbatim distorts history.
  const content =
    message?.content ?? (isObjectRecord(entry.request) ? entry.request.prompt : undefined);
  if (typeof content === "string") {
    const normalized = sanitizeClaudeVisibleText(content);
    return normalized.length > 0 ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .flatMap((item) => {
      if (typeof item === "string") {
        const normalized = sanitizeClaudeVisibleText(item);
        return normalized.length > 0 ? [normalized] : [];
      }
      if (!isObjectRecord(item) || item.type === "tool_result") {
        return [];
      }
      const normalized = sanitizeClaudeVisibleText(extractTextField(item));
      return normalized.length > 0 ? [normalized] : [];
    })
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts.join("\n\n") : null;
}

function extractClaudeAssistantText(entry: JsonLineRecord): string | null {
  if (entry.type !== "assistant") {
    return null;
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  if (isClaudeNativeSyntheticPlaceholderEntry(entry)) {
    return null;
  }

  const content = message?.content;
  if (typeof content === "string") {
    const normalized = sanitizeClaudeVisibleText(content);
    return normalized.length > 0 ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .flatMap((item) => {
      if (typeof item === "string") {
        const normalized = sanitizeClaudeVisibleText(item);
        return normalized.length > 0 ? [normalized] : [];
      }
      if (!isObjectRecord(item) || item.type !== "text") {
        return [];
      }
      const normalized = sanitizeClaudeVisibleText(extractTextField(item));
      return normalized.length > 0 ? [normalized] : [];
    })
    .filter((part) => part.length > 0);

  const text = parts.length > 0 ? parts.join("") : "";
  if (!text) {
    return null;
  }
  const visibleText = stripClaudeNativeSyntheticNoResponsePlaceholderText(text);
  return visibleText.length > 0 ? visibleText : null;
}

export function extractClaudeNativeSessionHeadInfo(entries: readonly JsonLineRecord[]): {
  workspacePath?: string;
  previewTitle?: string;
  createdAt?: number;
} {
  let workspacePath: string | undefined;

  for (const entry of entries) {
    const userText = extractClaudeUserText(entry);
    const assistantText = extractClaudeAssistantText(entry);
    // Never infer the workspace from an arbitrary early event's cwd:
    // queue/progress records may carry deeper temp cwds.
    // Adopt the cwd of the first truly visible message as the session's home.
    if (!workspacePath && (userText || assistantText)) {
      workspacePath = readEntryWorkspacePath(entry);
    }
    if (!userText) {
      continue;
    }

    return {
      workspacePath,
      previewTitle: deriveSessionTitle(userText, []),
      createdAt: readEntryTimestamp(entry),
    };
  }

  return { workspacePath };
}

export function parseClaudeNativeSessionRecords(params: {
  records: readonly JsonLineRecord[];
  workspacePath: string;
  sessionId: string;
  sourcePath: string;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
}): ClaudeNativeImportedSessionSource {
  const messages: ClaudeNativeImportedSessionSource["messages"] = [];
  let detectedWorkspacePath: string | undefined;
  let firstVisibleUserTimestamp: number | undefined;
  let updatedAt = params.fallbackUpdatedAt;
  let currentTurnIndex = -1;
  let model: string | undefined;
  let pendingAssistantContent = "";
  let pendingAssistantTimestamp: number | undefined;

  const flushPendingAssistant = () => {
    if (!pendingAssistantContent || currentTurnIndex < 0) {
      pendingAssistantContent = "";
      pendingAssistantTimestamp = undefined;
      return;
    }

    // Core rule: one Claude-native assistant turn can span several events.
    // Aggregate until the next visible user turn or EOF so imported history stays
    // the minimal user-turn + assistant-turn renderable shape.
    messages.push({
      role: "assistant",
      content: pendingAssistantContent,
      timestamp: pendingAssistantTimestamp ?? updatedAt ?? Date.now(),
      ...(model ? { model } : {}),
      turnIndex: currentTurnIndex,
    });
    updatedAt = pendingAssistantTimestamp ?? updatedAt;
    pendingAssistantContent = "";
    pendingAssistantTimestamp = undefined;
  };

  for (const entry of params.records) {
    const userText = extractClaudeUserText(entry);
    if (!detectedWorkspacePath && userText) {
      detectedWorkspacePath = readEntryWorkspacePath(entry);
    }
    if (userText) {
      flushPendingAssistant();
      currentTurnIndex += 1;
      const timestamp = readEntryTimestamp(entry) ?? updatedAt ?? Date.now();
      // createdAt prefers the first visible user message, never the file birthtime:
      // jsonl birthtime is a disk artifact, not when the user actually started.
      firstVisibleUserTimestamp ??= timestamp;
      updatedAt = timestamp;
      messages.push({
        role: "user",
        content: userText,
        timestamp,
        turnIndex: currentTurnIndex,
      });
      continue;
    }

    const assistantText = extractClaudeAssistantText(entry);
    if (!detectedWorkspacePath && assistantText) {
      detectedWorkspacePath = readEntryWorkspacePath(entry);
    }
    if (!assistantText || currentTurnIndex < 0) {
      continue;
    }

    // Body filtering drops synthetic/API-error assistants, but they can still carry
    // model=<synthetic>. Snapshot models come from visible replies only, or continuation would
    // feed placeholder models into session/load and set_model decisions.
    model ??= readEntryModel(entry);
    pendingAssistantContent += assistantText;
    pendingAssistantTimestamp = readEntryTimestamp(entry) ?? pendingAssistantTimestamp ?? updatedAt;
    updatedAt = pendingAssistantTimestamp ?? updatedAt;
  }

  flushPendingAssistant();

  if (messages.length === 0) {
    throw new Error(
      `[claude-native] Claude-native session ${params.sessionId} has no importable visible messages`,
    );
  }

  return {
    provider: "claude",
    sessionId: params.sessionId,
    workspacePath: detectedWorkspacePath ?? params.workspacePath,
    sourcePath: params.sourcePath,
    createdAt: firstVisibleUserTimestamp ?? params.fallbackCreatedAt ?? updatedAt ?? Date.now(),
    updatedAt: updatedAt ?? firstVisibleUserTimestamp ?? params.fallbackCreatedAt ?? Date.now(),
    title: deriveSessionTitle(messages.find((item) => item.role === "user")?.content ?? "", []),
    // Core rule: provider=claude only proves Claude continued the task;
    // it cannot tell a native zcode Claude task from a Claude Code import.
    // Record migrationSource so lists/stats can identify the origin reliably.
    migrationSource: "claudeCode",
    ...(model ? { model } : {}),
    messages,
  };
}

export interface ClaudeNativeVisibleAssistantTurn {
  turnIndex: number;
  content: string;
  terminal: boolean;
  userTimestamp?: number;
  timestamp?: number;
}

export interface ClaudeNativeUnknownCommandWarning {
  command: string;
  args?: string;
  timestamp?: number;
}

const CLAUDE_NATIVE_PROMPT_MATCH_TOLERANCE_MS = 1_000;
const CLAUDE_NATIVE_UNKNOWN_COMMAND_ARGS_MAX_GAP_MS = 5_000;
const CLAUDE_NATIVE_UNKNOWN_COMMAND_RE = /^Unknown command:\s*(\S+)/iu;
const CLAUDE_NATIVE_UNKNOWN_SKILL_ARGS_RE = /^Args from unknown skill:\s*(.+)$/iu;

function readClaudeNativeTurnMatchTimestamp(
  turn: ClaudeNativeVisibleAssistantTurn,
): number | undefined {
  return turn.userTimestamp ?? turn.timestamp;
}

export function selectClaudeNativeVisibleAssistantTurnAfter(
  turns: readonly ClaudeNativeVisibleAssistantTurn[],
  lowerBoundMs: number,
): ClaudeNativeVisibleAssistantTurn | null {
  const minTimestamp = lowerBoundMs - CLAUDE_NATIVE_PROMPT_MATCH_TOLERANCE_MS;
  const candidates = turns.filter((turn) => {
    const timestamp = readClaudeNativeTurnMatchTimestamp(turn);
    return timestamp !== undefined && timestamp >= minTimestamp && turn.content.trim().length > 0;
  });
  const strictCandidates = candidates.filter((turn) => {
    const timestamp = readClaudeNativeTurnMatchTimestamp(turn);
    return timestamp !== undefined && timestamp >= lowerBoundMs;
  });
  if (strictCandidates.length > 0) {
    return strictCandidates[0] ?? null;
  }

  const truncatedTimestampCandidates = candidates.filter(
    (turn) => turn.timestamp === undefined || turn.timestamp >= lowerBoundMs,
  );

  // Bugfix: Claude-native and ZCode turnIndexes drift across session/load, synthesized errors,
  // and cross-provider continuation. Attribute assistants by userTimestamp first, or nearby
  // session/load additions (No response requested) with fresher timestamps
  // leak into this turn and overwrite an older API error with a fake success.
  // Bugfix: native user timestamps truncate to seconds, so rapid prompts put the
  // previous user inside the 1s window; exclude assistants written before this turn's send
  // and take the last in log order: the assistant closest to this prompt.
  // Never search forward for terminals, or an unfinished turn jumps to a later one's body.
  return truncatedTimestampCandidates.at(-1) ?? null;
}

export function parseClaudeNativeVisibleAssistantTurns(
  records: readonly JsonLineRecord[],
): ClaudeNativeVisibleAssistantTurn[] {
  const turns: ClaudeNativeVisibleAssistantTurn[] = [];
  let currentTurnIndex = -1;
  let currentUserTimestamp: number | undefined;
  let pendingAssistantContent = "";
  let pendingAssistantTerminal = false;
  let pendingAssistantTimestamp: number | undefined;

  const flushPendingAssistant = () => {
    if (!pendingAssistantContent || currentTurnIndex < 0) {
      pendingAssistantContent = "";
      pendingAssistantTerminal = false;
      pendingAssistantTimestamp = undefined;
      return;
    }

    // Core rule: prompt-finalization needs more than a body; it must know whether this turn
    // reached a terminal (end_turn/max_tokens), or tool_use openings
    // read as final replies.
    turns.push({
      turnIndex: currentTurnIndex,
      content: pendingAssistantContent,
      terminal: pendingAssistantTerminal,
      ...(currentUserTimestamp !== undefined ? { userTimestamp: currentUserTimestamp } : {}),
      ...(pendingAssistantTimestamp !== undefined ? { timestamp: pendingAssistantTimestamp } : {}),
    });
    pendingAssistantContent = "";
    pendingAssistantTerminal = false;
    pendingAssistantTimestamp = undefined;
  };

  for (const entry of records) {
    const userText = extractClaudeUserText(entry);
    if (userText) {
      flushPendingAssistant();
      currentTurnIndex += 1;
      currentUserTimestamp = readEntryTimestamp(entry);
      continue;
    }

    const assistantText = extractClaudeAssistantText(entry);
    if (!assistantText || currentTurnIndex < 0) {
      continue;
    }

    pendingAssistantContent += assistantText;
    pendingAssistantTerminal =
      pendingAssistantTerminal || isTerminalAssistantStopReason(readAssistantStopReason(entry));
    pendingAssistantTimestamp = readEntryTimestamp(entry) ?? pendingAssistantTimestamp;
  }

  flushPendingAssistant();
  return turns;
}

export async function readClaudeNativeVisibleAssistantTurnsFile(
  filePath: string,
): Promise<ClaudeNativeVisibleAssistantTurn[]> {
  const records = await readJsonLinesFile(filePath);
  return parseClaudeNativeVisibleAssistantTurns(records);
}

function extractClaudeSystemDiagnosticText(entry: JsonLineRecord): string | null {
  if (entry.type !== "system") {
    return null;
  }

  const level = readTrimmedString(entry.level);
  const subtype = readTrimmedString(entry.subtype);
  if (level !== "warning" && subtype !== "local_command") {
    return null;
  }

  const content = readTrimmedString(entry.content);
  if (content) {
    // Bugfix: Claude Code 2.1.148 logs unknown slash commands as
    // system/local_command/info with the error inside local-command-stdout tags.
    // Strip the tags, keep the diagnostics, and avoid the generic no-reply fallback.
    return sanitizeClaudeDiagnosticText(content);
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const messageContent = readTrimmedString(message?.content);
  return messageContent ? sanitizeClaudeDiagnosticText(messageContent) : null;
}

export function parseClaudeNativeUnknownCommandWarnings(
  records: readonly JsonLineRecord[],
): ClaudeNativeUnknownCommandWarning[] {
  const warnings: ClaudeNativeUnknownCommandWarning[] = [];

  for (const entry of records) {
    const text = extractClaudeSystemDiagnosticText(entry);
    if (!text) {
      continue;
    }

    const timestamp = readEntryTimestamp(entry);
    const unknownCommandMatch = text.match(CLAUDE_NATIVE_UNKNOWN_COMMAND_RE);
    if (unknownCommandMatch?.[1]) {
      warnings.push({
        command: unknownCommandMatch[1],
        ...(timestamp !== undefined ? { timestamp } : {}),
      });
      continue;
    }

    const argsMatch = text.match(CLAUDE_NATIVE_UNKNOWN_SKILL_ARGS_RE);
    const latest = warnings.at(-1);
    if (!argsMatch?.[1] || !latest || latest.args) {
      continue;
    }

    const latestTimestamp = latest.timestamp;
    const isSameWarningGroup =
      timestamp === undefined ||
      latestTimestamp === undefined ||
      Math.abs(timestamp - latestTimestamp) <= CLAUDE_NATIVE_UNKNOWN_COMMAND_ARGS_MAX_GAP_MS;
    if (isSameWarningGroup) {
      // Bugfix: unknown slash commands split into two system warnings
      // (name, then args); merge them so ZCode shows an actionable failure.
      latest.args = argsMatch[1].trim();
    }
  }

  return warnings;
}

export function selectClaudeNativeUnknownCommandWarningAfter(
  warnings: readonly ClaudeNativeUnknownCommandWarning[],
  lowerBoundMs: number,
): ClaudeNativeUnknownCommandWarning | null {
  const minTimestamp = lowerBoundMs - CLAUDE_NATIVE_PROMPT_MATCH_TOLERANCE_MS;
  const candidates = warnings.filter((warning) => {
    return warning.timestamp === undefined || warning.timestamp >= minTimestamp;
  });
  const strictCandidates = candidates.filter((warning) => {
    return warning.timestamp === undefined || warning.timestamp >= lowerBoundMs;
  });
  return strictCandidates[0] ?? candidates.at(-1) ?? null;
}

export async function readClaudeNativeUnknownCommandWarningsFile(
  filePath: string,
): Promise<ClaudeNativeUnknownCommandWarning[]> {
  const records = await readJsonLinesFile(filePath);
  return parseClaudeNativeUnknownCommandWarnings(records);
}

export async function parseClaudeNativeSessionFile(params: {
  filePath: string;
  workspacePath: string;
  sessionId: string;
  sourcePath?: string;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
}): Promise<ClaudeNativeImportedSessionSource> {
  const [records, sourceStat] = await Promise.all([
    readJsonLinesFile(params.filePath),
    stat(params.filePath),
  ]);

  return parseClaudeNativeSessionRecords({
    records,
    workspacePath: params.workspacePath,
    sessionId: params.sessionId,
    sourcePath: params.sourcePath ?? params.filePath,
    fallbackCreatedAt: params.fallbackCreatedAt ?? Math.trunc(sourceStat.birthtimeMs),
    fallbackUpdatedAt: params.fallbackUpdatedAt ?? Math.trunc(sourceStat.mtimeMs),
  });
}
