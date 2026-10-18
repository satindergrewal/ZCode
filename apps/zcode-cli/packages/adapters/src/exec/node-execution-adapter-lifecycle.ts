import { BACKGROUND_BASH_OUTPUT_MAX_BYTES, type BackgroundBashOutputResult } from "@zcode/shared";
import { readBashOutput } from "./bash-file-output.js";
import { NodeExecutionAdapterRun } from "./node-execution-adapter-run.js";
import {
  BASH_RUNTIME_OUTPUT_LIMIT_BYTES,
  DEFAULT_TIMEOUT_MS,
  isBashMergedOutputRequest,
} from "./execution-utils.js";
import type {
  BashBackgroundLifecycleMode,
  BashBackgroundLifecycleResult,
  InternalExecutionRunOptions,
} from "./execution-adapter-types.js";
import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
} from "@zcode/contracts";

export class NodeExecutionAdapterLifecycle extends NodeExecutionAdapterRun {
  async start(
    request: ExecutionRequest,
    options: ExecutionRunOptions = {},
  ): Promise<BackgroundExecutionStartResult> {
    if (this.closePromise) {
      throw new Error("Execution adapter is shutting down");
    }

    const taskId = `exec_${crypto.randomUUID()}`;
    const controller = new AbortController();
    const startedAt = new Date();
    const outputPaths = this.outputPathsForRequest(request);
    const runRequest =
      request.captureCwdAfterSuccess === true
        ? { ...request, captureCwdAfterSuccess: undefined }
        : request;
    if (runRequest !== request) {
      this.outputPathsByRequest.set(runRequest, outputPaths);
    }
    if (!isBashMergedOutputRequest(runRequest)) await this.ensureBackgroundOutputFiles(outputPaths);
    const record = this.createBackgroundTaskRecord({
      controller,
      outputPaths,
      startedAt,
      taskId,
      request,
    });
    this.backgroundTasks.set(taskId, record);

    const externalAbort = () => controller.abort();
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", externalAbort, { once: true });
      record.externalAbort = externalAbort;
    }

    void this.run(runRequest, {
      ...options,
      signal: controller.signal,
      onOutputEncodingResolved: (encoding) => {
        record.legacyOutputEncoding = encoding;
      },
      shouldRetainExecutionAfterRootExit: () => true,
      ...(isBashMergedOutputRequest(runRequest)
        ? { bashLifecycle: { isBackgrounded: () => true } }
        : {}),
      onEvent: (event) => {
        this.updateBackgroundTaskRecordFromEvent(record, event);
        return options.onEvent?.(event);
      },
    } as InternalExecutionRunOptions).then(
      (result) => {
        this.finalizeBackgroundTaskRecord(record, result);
        if (record.externalAbort) {
          options.signal?.removeEventListener("abort", record.externalAbort);
        }
      },
      (error) => {
        const failure = this.toFailure("unknown", error);
        this.finalizeBackgroundTaskRecord(
          record,
          this.createStoppedResult(startedAt, "spawn_error", failure.message),
        );
        if (record.externalAbort) {
          options.signal?.removeEventListener("abort", record.externalAbort);
        }
      },
    );

    return {
      taskId,
      status: "running",
      startedAt,
      pid: record.pid,
      ...outputPaths,
    };
  }

  async runBashWithBackgroundLifecycle(
    request: ExecutionRequest,
    lifecycle: { mode: BashBackgroundLifecycleMode },
    options: ExecutionRunOptions = {},
  ): Promise<BashBackgroundLifecycleResult> {
    const useBashFile = isBashMergedOutputRequest(request);
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (lifecycle.mode === "auto_on_timeout" && timeoutMs <= 0) {
      return {
        kind: "foreground",
        result: await this.run(request, options),
      };
    }

    const taskId = `exec_${crypto.randomUUID()}`;
    const startedAt = new Date();
    const controller = new AbortController();
    const originalPersistOutput = request.outputLimit?.persistOutput ?? "none";
    const originalMaxArtifactBytes = useBashFile
      ? undefined
      : (request.outputLimit?.maxArtifactBytes ?? this.persistedOutputLimit(request));
    const runRequest: ExecutionRequest = {
      ...request,
      timeoutMs: 0,
      outputLimit: {
        ...request.outputLimit,
        killProcessOnPersistedLimit: false,
        maxPersistedBytes: BASH_RUNTIME_OUTPUT_LIMIT_BYTES,
        persistOutput: "always",
      },
    };
    const outputPaths = this.outputPathsForRequest(runRequest);
    if (!isBashMergedOutputRequest(runRequest)) {
      await this.ensureBackgroundOutputFiles(outputPaths);
    }
    const record = this.createBackgroundTaskRecord({
      controller,
      outputPaths,
      startedAt,
      taskId,
      request,
    });

    type LifecycleState = "preparing" | "foreground" | "backgrounded" | "settling" | "terminal";
    let state: LifecycleState = "preparing";
    const bashLifecycle: InternalExecutionRunOptions["bashLifecycle"] = useBashFile
      ? {
          isBackgrounded: () => state === "backgrounded",
          onExit: () => {
            // After root exit this only reads results async; the foreground deadline must not background it again.
            if (state === "preparing" || state === "foreground") {
              state = "settling";
              clearForegroundDeadline();
              removeExternalAbort();
            }
          },
        }
      : undefined;
    let persistedLimitReached = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let resolveOutcome: (result: BashBackgroundLifecycleResult) => void = () => undefined;
    const outcome = new Promise<BashBackgroundLifecycleResult>((resolve) => {
      resolveOutcome = resolve;
    });

    const externalAbort = () => {
      if (state === "backgrounded" || state === "terminal") return;
      controller.abort();
    };
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", externalAbort, { once: true });
      record.externalAbort = externalAbort;
    }

    const removeExternalAbort = () => {
      if (!record.externalAbort) return;
      options.signal?.removeEventListener("abort", record.externalAbort);
      record.externalAbort = undefined;
    };

    const clearForegroundDeadline = () => {
      if (!timeoutTimer) return;
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    };

    const commitBackground = () => {
      if (state !== "foreground" || controller.signal.aborted) return false;

      // Legacy explicit background reused generic start(), leaving foreground timeout and
      // parent turn abort attached to the child. Commit state atomically first, then clear the deadline,
      // detach parent abort and register the task, so abort/completion cannot kill it in the commit gap.
      state = "backgrounded";
      bashLifecycle?.onBackgrounded?.();
      clearForegroundDeadline();
      removeExternalAbort();
      this.backgroundTasks.set(taskId, record);
      if (persistedLimitReached) {
        controller.abort("output_limit");
      }
      resolveOutcome({
        kind: "backgrounded",
        task: {
          taskId,
          status: "running",
          startedAt,
          pid: record.pid,
          ...outputPaths,
        },
      });
      return true;
    };

    const armForegroundDeadline = () => {
      if (lifecycle.mode !== "auto_on_timeout" || timeoutTimer || state !== "foreground") {
        return;
      }
      timeoutTimer = setTimeout(commitBackground, timeoutMs);
    };

    const backgroundRunOptions: InternalExecutionRunOptions = {
      ...options,
      signal: controller.signal,
      onOutputEncodingResolved: (encoding) => {
        record.legacyOutputEncoding = encoding;
      },
      bashLifecycle,
      onPersistedLimit: () => {
        if (!controller.signal.aborted) {
          persistedLimitReached = true;
        }
      },
      onEvent: (event) => {
        this.updateBackgroundTaskRecordFromEvent(record, event);
        if (
          event.type === "started" &&
          event.pid !== undefined &&
          state === "preparing" &&
          !controller.signal.aborted
        ) {
          state = "foreground";
          if (lifecycle.mode === "explicit") {
            commitBackground();
          } else {
            armForegroundDeadline();
          }
        }
        if (state === "backgrounded") return;
        return options.onEvent?.(event);
      },
      // Generic lifecycle keeps a dedicated collector and shared hard budget; Bash is handled by the file watchdog.
      sharePersistedOutputLimitAcrossStreams: true,
      shouldStopOnPersistedLimit: () => state === "backgrounded",
      shouldRetainExecutionAfterRootExit: () => state === "backgrounded",
    };

    const settleExecution = async (unprocessedResult: ExecutionResult) => {
      clearForegroundDeadline();
      if (state === "backgrounded") {
        this.finalizeBackgroundTaskRecord(
          record,
          this.normalizeBashBackgroundOutputLimitResult(unprocessedResult, persistedLimitReached),
        );
        return;
      }
      if (state === "terminal") return;

      state = "terminal";
      removeExternalAbort();
      const result = await this.normalizeBashBackgroundLifecycleForegroundResult(
        unprocessedResult,
        outputPaths,
        originalMaxArtifactBytes,
        originalPersistOutput,
      );
      // Foreground completion still reuses BackgroundTaskRecord; settling only the outcome would leave
      // record.completion pending forever, flagged as a leak by async resource detection.
      this.finalizeBackgroundTaskRecord(record, result);
      resolveOutcome({
        kind: "foreground",
        result,
      });
    };

    void (async () => {
      try {
        await settleExecution(await this.run(runRequest, backgroundRunOptions));
      } catch (error) {
        const failure = this.toFailure("unknown", error);
        await settleExecution(this.createStoppedResult(startedAt, "spawn_error", failure.message));
      }
    })();

    return await outcome;
  }

  async readBackgroundBashOutput(
    workId: string,
    sessionId: string,
  ): Promise<BackgroundBashOutputResult> {
    const record = this.backgroundTasks.get(workId);
    if (
      !record ||
      record.sessionId !== sessionId ||
      !record.isBash ||
      !record.outputPath
    )
      return { kind: "unavailable", workId };
    // Freeze state before reading files; only then can a later query return a terminal state and final tail.
    const snapshot = this.snapshot(record);
    try {
      const output = await readBashOutput(
        record.outputPath,
        BACKGROUND_BASH_OUTPUT_MAX_BYTES,
        true,
        record.legacyOutputEncoding,
      );
      return {
        kind: "output",
        workId,
        // Stop marks cancelled first and settles later; do not let details stop the final tail read early.
        status: snapshot.result ? snapshot.status : "running",
        output: output.text,
        truncated: output.truncated,
        outputPath: record.outputPath,
      };
    } catch (error) {
      return {
        kind: "read_failed",
        workId,
        code: error instanceof Error && "code" in error ? String(error.code) : undefined,
      };
    }
  }

  async getBackgroundTask(taskId: string): Promise<BackgroundExecutionSnapshot | undefined> {
    const record = this.backgroundTasks.get(taskId);
    return record ? this.snapshot(record) : undefined;
  }

  async waitForBackgroundTask(
    taskId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<BackgroundExecutionSnapshot | undefined> {
    const record = this.backgroundTasks.get(taskId);
    if (!record) return undefined;
    if (record.status !== "running") return this.snapshot(record);
    if (options.signal?.aborted) return this.snapshot(record);

    if (!options.signal) return await record.completion;

    return await new Promise<BackgroundExecutionSnapshot>((resolve) => {
      const abort = () => resolve(this.snapshot(record));
      options.signal?.addEventListener("abort", abort, { once: true });
      record.completion.then((snapshot) => {
        options.signal?.removeEventListener("abort", abort);
        resolve(snapshot);
      });
    });
  }

  async cancelBackgroundTask(taskId: string): Promise<BackgroundExecutionSnapshot | undefined> {
    const record = this.backgroundTasks.get(taskId);
    if (!record) return undefined;
    if (record.status === "running") {
      record.status = "cancelled";
      record.controller.abort();
    }
    return this.snapshot(record);
  }
}
