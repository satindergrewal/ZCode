import { isHighspeedProviderId } from "@zcode/shared";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/services";
import { logger } from "@/logger.js";

// Keeps the legacy key; reads stay compatible with history entries storing ModelSelection only.
const COMPOSER_RECENT_KEY_PREFIX = "zcode-model-selection-recent-v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ComposerRecent {
  readonly modelSelection?: ModelSelection;
  readonly mode?: SubmissionMode;
}

let submissionSequence = 0;
const acceptedSequences = new WeakMap<StorageLike, Map<string, number>>();

function resolveComposerRecentKey(workspacePath: string, workspaceIdentity?: string): string {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${COMPOSER_RECENT_KEY_PREFIX}:${workspaceKey}`;
}

export function readComposerRecent(
  workspacePath: string,
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): ComposerRecent | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(resolveComposerRecentKey(workspacePath, workspaceIdentity));
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    // Validate both leaves independently so stale models or bad data never drop valid grants, either way.
    const selection = modelSelectionSchema.safeParse(
      "modelSelection" in record ? record.modelSelection : record,
    );
    const mode = submissionModeSchema.safeParse("mode" in record ? record.mode : undefined);
    // 自愈（spec §5.1）：存量 Recent 可能被加速轮覆盖写入隐藏加速 Provider，模型视图里它
    // 解析为 provider-not-found，会让新任务草稿的模型选择器卡在空态。按叶子丢弃模型、保留
    // mode，新草稿回落默认选择；与 readSessionModelSelection 丢弃加速常驻 entry 同口径。
    const healedSelection =
      selection.success && !isHighspeedProviderId(selection.data.providerId)
        ? selection.data
        : undefined;
    if (!healedSelection && !mode.success) return null;
    return {
      ...(healedSelection ? { modelSelection: healedSelection } : {}),
      ...(mode.success ? { mode: mode.data } : {}),
    };
  } catch {
    return null;
  }
}

/** Captured when the real submission starts; the returned fn runs only after the accepted ACK. */
export function captureComposerRecentSubmission(
  workspacePath: string,
  submission: { readonly modelSelection: ModelSelection; readonly mode: SubmissionMode },
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): () => void {
  if (!storage) return () => {};
  const key = resolveComposerRecentKey(workspacePath, workspaceIdentity);
  const mode = submissionModeSchema.safeParse(submission.mode);
  const modelSelection = normalizeSparseModelSelection(submission.modelSelection);
  if (modelSelection && isHighspeedProviderId(modelSelection.providerId)) {
    // 兜底（spec §5.1）：加速 Provider 是单轮执行身份，不在任何模型目录里，写进 Recent 会让
    // 新任务草稿种子解析为空。正常链路由 SessionPane 在加速轮传入 Composer 原始选择，这里
    // 只拦截直接拿覆盖后 payload 调用的路径；跳过不推进序号，保留上一次合法记录。
    logger.warn("[ComposerRecent] 提交指向加速卡 Provider，跳过偏好记录", {
      workspacePath,
      workspaceIdentity,
    });
    return () => {};
  }
  if (!mode.success || !modelSelection) {
    // Recents are a send-time side preference; on bad input drop the record, never block the command.
    logger.warn("[ComposerRecent] Invalid recent submission shape, skipping preference record", {
      workspacePath,
      workspaceIdentity,
    });
    return () => {};
  }
  const sequence = ++submissionSequence;
  const recent = {
    modelSelection,
    mode: mode.data,
  };
  let accepted = acceptedSequences.get(storage);
  if (!accepted) {
    accepted = new Map();
    acceptedSequences.set(storage, accepted);
  }
  return () => {
    // Model-only persistence loses grants after a root migration; both fields must be saved together.
    // Within a renderer take the latest accepted submission by start order so late cross-pane ACKs never
    // rewrite stale preferences; unaccepted candidates never advance the watermark or input queues.
    if (sequence <= (accepted.get(key) ?? 0)) return;
    accepted.set(key, sequence);
    try {
      storage.setItem(key, JSON.stringify(recent));
    } catch (error) {
      // The authoritative send already accepted; a preference write failure must not read as send failure.
      logger.warn("[ComposerRecent] Failed to persist recent submission", {
        workspacePath,
        workspaceIdentity,
        error,
      });
    }
  };
}

export function resolveDraftInitialModelSelection(
  view: ModelSelectionView | null,
  recent: ModelSelection | null,
): { readonly selection: ModelSelection | null; readonly invalidated: boolean } {
  // Before the registry arrives, existing draft intent must not read as stale; keep it verbatim until
  // the same hook receives the view and revalidates semantics.
  if (!view) return { selection: recent, invalidated: false };
  if (recent) {
    const model = findModel(view, recent);
    if (!model) return { selection: null, invalidated: true };
    const reasoning = recent.options?.reasoningLevel;
    if (
      reasoning === undefined ||
      !model.config.optionSpecs.reasoningLevel.values.includes(reasoning)
    ) {
      // Provider and model identity stay while stale tiers clear; the composer shows no generic toast and
      // lets the empty reasoning control demand an explicit new choice.
      return {
        selection: { providerId: recent.providerId, modelId: recent.modelId },
        invalidated: true,
      };
    }
    return { selection: recent, invalidated: false };
  }
  return {
    selection:
      view.preferredSelection && isSelectionInView(view, view.preferredSelection)
        ? view.preferredSelection
        : null,
    invalidated: recent !== null,
  };
}

export function isSelectionInView(view: ModelSelectionView, selection: ModelSelection): boolean {
  const model = findModel(view, selection);
  if (!model) return false;
  const reasoning = selection.options?.reasoningLevel;
  const reasoningSpec = model.config.optionSpecs.reasoningLevel;
  return reasoning !== undefined && reasoningSpec.values.includes(reasoning);
}

function findModel(view: ModelSelectionView, selection: ModelSelection) {
  return view.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
}

function normalizeSparseModelSelection(selection: ModelSelection): ModelSelection | null {
  const candidate =
    selection && typeof selection === "object" && !Array.isArray(selection) ? selection : null;
  const options = candidate?.options;
  const normalizedOptions =
    options?.reasoningLevel !== undefined ? { reasoningLevel: options.reasoningLevel } : {};
  const parsed = modelSelectionSchema.safeParse({
    providerId: candidate?.providerId,
    modelId: candidate?.modelId,
    ...(Object.keys(normalizedOptions).length > 0 ? { options: normalizedOptions } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
