import type { AgentTelemetryCausation, Model } from "@zcode/contracts";
import type { TraceContext } from "../deps.js";
import {
  canStartMemoryRecall,
  createMemoryRecallState,
  filterMemorySelections,
  findLatestMemoryRecallQuery,
  formatRelevantMemoryAttachment,
  getMemoryRecallManifest,
  isMemoryRecallQueryEligible,
  readRecalledMemories,
  recordRecalledMemories,
  runMemorySelector,
  type MemoryManifestEntry,
  type MemoryRecallState,
  type RecalledMemory,
} from "../../memory/recall/index.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import {
  createReadFileStateKey,
  createReadFileStatePathKey,
  normalizeReadFileStateMtimeMs,
} from "../../tool/read-file-state.js";
import type { ProjectMemoryRetrievalBranch } from "../../memory/project-memory-retrieval-branch.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "../methods/model-runtime-headers.js";
import { withModelInvocationContext } from "../methods/runtime-model.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

interface PrefetchedMemory {
  entry: MemoryManifestEntry;
  memory: RecalledMemory;
}

export interface ProjectMemoryRecallPrefetch {
  abortController: AbortController;
  consumed: boolean;
  detachTurnAbort: () => void;
  memories: PrefetchedMemory[];
  settled: boolean;
}

export function startProjectMemoryRecallPrefetch(
  runtime: AgentRuntimeInternal,
  input: { model: Model; traceContext: TraceContext; turnAbortSignal: AbortSignal },
  retrievalBranch: ProjectMemoryRetrievalBranch,
): void {
  if (retrievalBranch !== "semantic-recall") return;
  if (runtime.memoryRecallPrefetch) return;
  if (!runtime.memoryRoot || !runtime.fileSystemPort) return;
  // The selector must receive strict JSON Schema; never pick an implicit provider/model because of capability gaps.
  if (!input.model.properties.supportsJsonSchemaOutput) return;
  if (!canStartMemoryRecall(runtime.memoryRecallState)) return;

  const query = findLatestMemoryRecallQuery(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
  if (!isMemoryRecallQueryEligible(query)) return;
  const recallState = runtime.memoryRecallState;
  if (hasRecalledEveryManifestEntry(recallState)) return;

  const abortController = new AbortController();
  const prefetch: ProjectMemoryRecallPrefetch = {
    abortController,
    consumed: false,
    detachTurnAbort: forwardTurnAbort(input.turnAbortSignal, abortController),
    memories: [],
    settled: false,
  };
  runtime.memoryRecallPrefetch = prefetch;

  const readFileStateSnapshot: ReadFileStateMap = new Map(runtime.readFileState);
  const recalledPathsSnapshot = new Set(recallState.recalledPaths);
  void prefetchProjectMemories(runtime, {
    abortSignal: abortController.signal,
    causation: runtime.agentTelemetry.captureCausation(),
    model: input.model,
    query,
    readFileStateSnapshot,
    recalledPathsSnapshot,
    rootDir: runtime.memoryRoot,
    state: recallState,
    traceContext: input.traceContext,
  })
    .then((memories) => {
      prefetch.memories = memories;
    })
    .catch(() => {
      prefetch.memories = [];
    })
    .finally(() => {
      prefetch.settled = true;
      prefetch.detachTurnAbort();
    });
}

export function consumeSettledProjectMemoryRecall(
  runtime: AgentRuntimeInternal,
  retrievalBranch: ProjectMemoryRetrievalBranch,
): RuntimeMessageEntry | undefined {
  if (retrievalBranch !== "semantic-recall") return undefined;
  const prefetch = runtime.memoryRecallPrefetch;
  if (!prefetch || !prefetch.settled || prefetch.consumed) return undefined;
  prefetch.consumed = true;

  const eligibleEntries = filterMemorySelections({
    manifest: runtime.memoryRecallState.manifest ?? prefetch.memories.map(({ entry }) => entry),
    readFileState: runtime.readFileState,
    recalledPaths: runtime.memoryRecallState.recalledPaths,
    selectedFilenames: prefetch.memories.map(({ entry }) => entry.filename),
  });
  const memories = matchPrefetchedMemories(prefetch.memories, eligibleEntries);
  if (memories.length === 0) return undefined;

  // Why: recall text is model-equivalent to a read; sync existing read-state at actual injection time for later Edit/Write.
  const readAt = new Date();
  for (const memory of memories) {
    runtime.readFileState.set(createReadFileStateKey(memory.filePath, undefined, memory.limit), {
      content: memory.content,
      isPartialView: false,
      limit: memory.limit,
      mtimeMs: normalizeReadFileStateMtimeMs(memory.mtimeMs),
      offset: undefined,
      path: memory.filePath,
      readAt,
      revisionId: memory.revisionId,
      sizeBytes: memory.sizeBytes,
    });
  }
  const entry = systemReminderAttachmentEntry(
    "relevant_memory",
    formatRelevantMemoryAttachment(memories),
  );
  runtime.messageHistory.addEntries([entry]);
  recordRecalledMemories(runtime.memoryRecallState, memories);
  return entry;
}

export function disposeProjectMemoryRecallPrefetch(runtime: AgentRuntimeInternal): void {
  const prefetch = runtime.memoryRecallPrefetch;
  if (!prefetch) return;
  runtime.memoryRecallPrefetch = undefined;
  prefetch.detachTurnAbort();
  if (!prefetch.abortController.signal.aborted) {
    prefetch.abortController.abort();
  }
}

export function resetProjectMemoryRecall(runtime: AgentRuntimeInternal): void {
  disposeProjectMemoryRecallPrefetch(runtime);
  runtime.memoryRecallState = createMemoryRecallState();
}

export function invalidateProjectMemoryRecallPaths(
  runtime: AgentRuntimeInternal,
  paths: readonly string[],
): void {
  if (paths.length === 0) return;
  // While Dream rewrites files, completed-but-unconsumed prefetch still holds the old body; drop it first
  // so a later tool batch does not re-inject pre-update content into the provider context.
  disposeProjectMemoryRecallPrefetch(runtime);
  const touchedPathKeys = new Set(paths.map((path) => createReadFileStatePathKey(path)));

  for (const [key, entry] of runtime.readFileState) {
    if (touchedPathKeys.has(createReadFileStatePathKey(entry.path))) {
      runtime.readFileState.delete(key);
    }
  }
  for (const recalledPath of runtime.memoryRecallState.recalledPaths) {
    if (touchedPathKeys.has(createReadFileStatePathKey(recalledPath))) {
      runtime.memoryRecallState.recalledPaths.delete(recalledPath);
    }
  }

  runtime.memoryRecallState.manifest = undefined;
  runtime.memoryRecallState.selectorMessages = undefined;
}

async function prefetchProjectMemories(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal: AbortSignal;
    causation?: AgentTelemetryCausation;
    model: Model;
    query: string;
    readFileStateSnapshot: ReadFileStateMap;
    recalledPathsSnapshot: ReadonlySet<string>;
    rootDir: string;
    state: MemoryRecallState;
    traceContext: TraceContext;
  },
): Promise<PrefetchedMemory[]> {
  const telemetry = runtime.agentTelemetry.detached({
    causation: input.causation,
    executionKind: "background",
    operation: "project_memory_recall",
    targetKind: "project_memory",
    traceContext: input.traceContext,
    trigger: "turn",
  });

  return telemetry.run(async () => {
    try {
      const fileSystem = runtime.fileSystemPort!;
      const manifest = await getMemoryRecallManifest({
        fileSystem,
        rootDir: input.rootDir,
        signal: input.abortSignal,
        state: input.state,
      });
      if (manifest.every((entry) => input.recalledPathsSnapshot.has(entry.filePath))) {
        telemetry.setResultType("metadata");
        telemetry.finishCompleted();
        return [];
      }

      const selection = await runMemorySelector({
        abortSignal: input.abortSignal,
        model: selectorModel(input.model, runtime, input.traceContext),
        query: input.query,
        state: input.state,
      });
      const entries = filterMemorySelections({
        manifest,
        readFileState: input.readFileStateSnapshot,
        recalledPaths: input.recalledPathsSnapshot,
        selectedFilenames: selection.selectedMemories,
      });
      const memories = await readRecalledMemories({
        entries,
        fileSystem,
        nowMs: runtime.now().getTime(),
        signal: input.abortSignal,
      });
      const entryByPath = new Map(entries.map((entry) => [entry.filePath, entry]));
      telemetry.setResultType("metadata");
      telemetry.finishCompleted();
      return memories.flatMap((memory) => {
        const entry = entryByPath.get(memory.filePath);
        return entry ? [{ entry, memory }] : [];
      });
    } catch (error) {
      if (input.abortSignal.aborted || isAbortError(error)) {
        telemetry.finishCancelled("abort_signal");
      } else {
        telemetry.finishFailed("execute", "internal", error);
      }
      throw error;
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function selectorModel(
  model: Model,
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Model {
  return withModelInvocationContext(model, (request) => ({
    metadata: { querySource: "project_memory_recall" },
    modelCall: { operation: "project_memory_recall" },
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext,
    }),
    traceContext,
  }));
}

function hasRecalledEveryManifestEntry(state: MemoryRecallState): boolean {
  return (
    state.manifest !== undefined &&
    state.manifest.length > 0 &&
    state.manifest.every((entry) => state.recalledPaths.has(entry.filePath))
  );
}

function matchPrefetchedMemories(
  prefetched: readonly PrefetchedMemory[],
  eligibleEntries: readonly MemoryManifestEntry[],
): RecalledMemory[] {
  const byFilename = new Map<string, RecalledMemory[]>();
  for (const { entry, memory } of prefetched) {
    const queued = byFilename.get(entry.filename) ?? [];
    queued.push(memory);
    byFilename.set(entry.filename, queued);
  }
  return eligibleEntries.flatMap((entry) => {
    const memory = byFilename.get(entry.filename)?.shift();
    return memory ? [memory] : [];
  });
}

function forwardTurnAbort(
  turnAbortSignal: AbortSignal,
  abortController: AbortController,
): () => void {
  const abort = () => {
    if (!abortController.signal.aborted) abortController.abort(turnAbortSignal.reason);
  };
  if (turnAbortSignal.aborted) {
    abort();
    return () => {};
  }
  turnAbortSignal.addEventListener("abort", abort, { once: true });
  return () => turnAbortSignal.removeEventListener("abort", abort);
}
