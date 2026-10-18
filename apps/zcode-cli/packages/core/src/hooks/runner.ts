import {
  HookOutcome,
  SessionEventType,
  isCoreError,
  traceContextToLogContext,
  type HookExecutionDescriptor,
  type HookInput,
  type HookJSONOutput,
  type Logger,
  type SessionEvent,
} from "@zcode/contracts";
import { mergeHookRunResult, processHookOutput } from "./output.js";
import { sanitizeHookDisplayText } from "./display-metadata.js";
import {
  HOOK_TIMEOUT_ABORT_REASON,
  createHookCancelledError,
  createHookTimeoutError,
  linkAbortSignal,
  matchesAnyHookMatcher,
  readHookErrorMessage,
  resolveHookDescriptor,
  resolveHookFailureOutcome,
  resolveHookRunAdmission,
} from "./runner-helpers.js";
import type {
  HookRegistration,
  HookCallbackDiagnostics,
  HookCallbackResult,
  HookRunOptions,
  HookRunResult,
  HookRunner,
  HookRunnerOptions,
} from "./types.js";

export class InMemoryHookRunner implements HookRunner {
  private readonly defaultTimeoutMs: number;
  private readonly emitEvent?: (event: SessionEvent) => Promise<void>;
  private readonly hooks: HookRegistration[];
  private readonly logger?: Logger;

  constructor(options: HookRunnerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60000;
    this.emitEvent = options.emitEvent;
    this.hooks = [...(options.hooks ?? [])];
    this.logger = options.logger;
  }

  register(hook: HookRegistration): void {
    this.hooks.push(hook);
  }

  async run(input: HookInput, options: HookRunOptions = {}): Promise<HookRunResult> {
    const matchingHooks = this.hooks.filter(
      (hook) => hook.event === input.hookEventName && matchesAnyHookMatcher(options, hook.matcher),
    );
    const result: HookRunResult = {
      additionalContexts: [],
    };
    const hookInvocationId = crypto.randomUUID();

    // Hooks with skipLifecycle emit no events and must not count into the client-awaited hookCount.
    // Fix: resolve admission for all matchingHooks first, drop the skipLifecycle ones from the participating list,
    // then compute clientVisibleHookCount, so hookCount equals the hooks that will actually emit.
    //
    // Note: admission here is used only for skipLifecycle filtering and the hookCount count —
    // both hinge on the stable enabled-in-config property. Allowed-grant decisions must never reuse this phase's
    // cache: when one event matches several sequential hooks, revokes / policy tightenings / trust-store reloads
    // happening while an earlier hook runs must take effect immediately for hooks not yet started,
    // so the loop re-calls resolveHookRunAdmission before each hook dispatch.
    const participatingHooks: { hook: HookRegistration }[] = [];
    for (const hook of matchingHooks) {
      const admission = resolveHookRunAdmission(hook, input, this.logger);
      if (admission.skipLifecycle) continue;
      participatingHooks.push({ hook });
    }

    const clientVisibleHookCount = participatingHooks.filter(
      ({ hook }) => resolveHookDescriptor(hook, this.defaultTimeoutMs, input).clientVisible,
    ).length;
    let clientVisibleHookIndex = 0;

    for (const [runtimeIndex, { hook }] of participatingHooks.entries()) {
      const descriptor = resolveHookDescriptor(hook, this.defaultTimeoutMs, input);
      const hookIndex = descriptor.clientVisible ? clientVisibleHookIndex++ : runtimeIndex;
      const hookRunId = crypto.randomUUID();
      const startedAt = Date.now();
      // Re-resolve the grant decision before dispatch. The pre-scan may be stale: user revokes,
      // admin policy tightenings, or trust-store reloads while an earlier hook runs all change
      // the outcome. The point of security revisions is re-checking at the execution boundary; never cache grant decisions.
      const admission = resolveHookRunAdmission(hook, input, this.logger);
      if (!admission.allowed) {
        await this.emitHookEvent(
          SessionEventType.HookRunBlocked,
          input,
          hookInvocationId,
          hookRunId,
          hookIndex,
          clientVisibleHookCount,
          hook,
          descriptor,
          startedAt,
          {
            durationMs: 0,
            errorCode: admission.reasonCode,
            outcome: HookOutcome.Blocked,
            ...(admission.reasonCode
              ? { blockReason: sanitizeHookDisplayText(admission.reasonCode) }
              : {}),
          },
        );
        continue;
      }
      await this.emitHookEvent(
        SessionEventType.HookRunStarted,
        input,
        hookInvocationId,
        hookRunId,
        hookIndex,
        clientVisibleHookCount,
        hook,
        descriptor,
        startedAt,
      );

      if (hook.async) {
        // An async command outlives the current turn; its output must not retroactively alter already-taken actions.
        void this.runBackgroundHook({
          clientVisibleHookCount,
          descriptor,
          hook,
          hookIndex,
          hookInvocationId,
          hookRunId,
          input,
          parentSignal: options.signal,
          runtimeIndex,
          startedAt,
        }).catch((error) => {
          this.logger?.warn("Async hook lifecycle reporting failed", {
            ...traceContextToLogContext({
              traceId: input.traceId,
              sessionId: input.sessionId,
              turnId: input.turnId,
            }),
            error: error instanceof Error ? error.message : String(error),
            event: "hook.run.async_reporting_failed",
            hookEventName: input.hookEventName,
            hookIndex,
            module: "core.hooks",
            source: hook.source,
          });
        });
        continue;
      }

      try {
        const callbackResult = await this.runCallbackWithTimeout(
          hook,
          input,
          runtimeIndex,
          options.signal,
        );
        const { output, diagnostics } = unwrapHookCallbackResult(callbackResult);
        const durationMs = Date.now() - startedAt;
        const processed = processHookOutput(input.hookEventName, output);
        mergeHookRunResult(result, processed);
        const blocked =
          processed.permissionBehavior === "deny" ||
          processed.permissionRequestResult?.behavior === "deny" ||
          processed.preventContinuation ||
          processed.blockRequested;
        // Block reasons must ride the terminal event into the persisted projection; kept only in TurnResult/tooltip they are lost
        // on replay or mobile resume, leaving users unable to tell which hook intercepted the request.
        const blockReason = blocked
          ? sanitizeHookDisplayText(
              processed.stopReason ??
                processed.hookPermissionDecisionReason ??
                (processed.permissionRequestResult?.behavior === "deny"
                  ? processed.permissionRequestResult.message
                  : undefined) ??
                "Hook blocked execution",
            )
          : undefined;
        const safeDiagnostics = blocked ? sanitizeHookDiagnostics(diagnostics) : undefined;

        await this.emitHookEvent(
          blocked ? SessionEventType.HookRunBlocked : SessionEventType.HookRunCompleted,
          input,
          hookInvocationId,
          hookRunId,
          hookIndex,
          clientVisibleHookCount,
          hook,
          descriptor,
          startedAt,
          {
            durationMs,
            outcome: blocked ? HookOutcome.Blocked : HookOutcome.Success,
            ...(blockReason ? { blockReason } : {}),
            ...(safeDiagnostics?.errorMessage
              ? { errorMessage: safeDiagnostics.errorMessage }
              : {}),
            ...(safeDiagnostics?.stderrPreview
              ? { stderrPreview: safeDiagnostics.stderrPreview }
              : {}),
            ...(safeDiagnostics?.stdoutPreview
              ? { stdoutPreview: safeDiagnostics.stdoutPreview }
              : {}),
          },
        );
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const outcome = resolveHookFailureOutcome(error);
        const errorMessage = sanitizeHookDisplayText(readHookErrorMessage(error));
        await this.emitHookEvent(
          SessionEventType.HookRunFailed,
          input,
          hookInvocationId,
          hookRunId,
          hookIndex,
          clientVisibleHookCount,
          hook,
          descriptor,
          startedAt,
          {
            durationMs,
            errorCode: isCoreError(error) ? error.code : undefined,
            errorMessage,
            outcome,
            stderrPreview: errorMessage,
          },
        );

        this.logger?.warn("Hook execution failed", {
          ...traceContextToLogContext({
            traceId: input.traceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
          }),
          durationMs,
          event: "hook.run.failed",
          hookEventName: input.hookEventName,
          hookIndex,
          matcher: hook.matcher,
          module: "core.hooks",
          source: hook.source,
        });
      }
    }

    return result;
  }

  private async runBackgroundHook(options: {
    clientVisibleHookCount: number;
    descriptor: HookExecutionDescriptor;
    hook: HookRegistration;
    hookIndex: number;
    hookInvocationId: string;
    hookRunId: string;
    input: HookInput;
    parentSignal: AbortSignal | undefined;
    runtimeIndex: number;
    startedAt: number;
  }): Promise<void> {
    const {
      clientVisibleHookCount,
      descriptor,
      hook,
      hookIndex,
      hookInvocationId,
      hookRunId,
      input,
      parentSignal,
      runtimeIndex,
      startedAt,
    } = options;
    try {
      await this.runCallbackWithTimeout(hook, input, runtimeIndex, parentSignal);
      await this.emitHookEvent(
        SessionEventType.HookRunCompleted,
        input,
        hookInvocationId,
        hookRunId,
        hookIndex,
        clientVisibleHookCount,
        hook,
        descriptor,
        startedAt,
        {
          durationMs: Date.now() - startedAt,
          outcome: HookOutcome.Success,
        },
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const outcome = resolveHookFailureOutcome(error);
      const errorMessage = sanitizeHookDisplayText(readHookErrorMessage(error));
      await this.emitHookEvent(
        SessionEventType.HookRunFailed,
        input,
        hookInvocationId,
        hookRunId,
        hookIndex,
        clientVisibleHookCount,
        hook,
        descriptor,
        startedAt,
        {
          durationMs,
          errorCode: isCoreError(error) ? error.code : undefined,
          errorMessage,
          outcome,
          stderrPreview: errorMessage,
        },
      );
      this.logger?.warn("Async hook execution failed", {
        ...traceContextToLogContext({
          traceId: input.traceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
        }),
        durationMs,
        event: "hook.run.async_failed",
        hookEventName: input.hookEventName,
        hookIndex,
        matcher: hook.matcher,
        module: "core.hooks",
        source: hook.source,
      });
    }
  }

  private async runCallbackWithTimeout(
    hook: HookRegistration,
    input: HookInput,
    hookIndex: number,
    parentSignal?: AbortSignal,
  ): Promise<HookJSONOutput | HookCallbackResult | void> {
    const timeoutMs = hook.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const unlink = linkAbortSignal(parentSignal, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await new Promise<HookJSONOutput | HookCallbackResult | void>((resolve, reject) => {
        if (controller.signal.aborted) {
          reject(createHookCancelledError());
          return;
        }

        timer = setTimeout(() => {
          controller.abort(HOOK_TIMEOUT_ABORT_REASON);
          reject(createHookTimeoutError(timeoutMs));
        }, timeoutMs);
        timer.unref?.();

        controller.signal.addEventListener(
          "abort",
          () => {
            reject(
              controller.signal.reason === HOOK_TIMEOUT_ABORT_REASON
                ? createHookTimeoutError(timeoutMs)
                : createHookCancelledError(),
            );
          },
          { once: true },
        );

        Promise.resolve(hook.callback(input, { hookIndex, signal: controller.signal })).then(
          resolve,
          reject,
        );
      });
    } finally {
      if (timer) clearTimeout(timer);
      unlink();
    }
  }

  private async emitHookEvent(
    type: SessionEventType,
    input: HookInput,
    hookInvocationId: string,
    hookRunId: string,
    hookIndex: number,
    hookCount: number,
    hook: HookRegistration,
    descriptor: HookExecutionDescriptor,
    startedAt: number,
    extra: Partial<SessionEvent["payload"] & Record<string, unknown>> = {},
  ): Promise<void> {
    if (!this.emitEvent) return;
    await this.emitEvent({
      id: crypto.randomUUID() as any,
      sessionId: input.sessionId,
      turnId: input.turnId,
      type,
      timestamp: type === SessionEventType.HookRunStarted ? new Date(startedAt) : new Date(),
      traceId: input.traceId,
      sequenceNumber: 0,
      payload: {
        agentName: input.agentName,
        descriptor,
        hookEventName: input.hookEventName,
        hookIndex,
        hookCount,
        hookInvocationId,
        hookRunId,
        hookSource: hook.source,
        matcher: hook.matcher,
        requestId: "requestId" in input ? input.requestId : undefined,
        startedAt,
        toolCallId: "toolCallId" in input ? input.toolCallId : undefined,
        toolName: "toolName" in input ? input.toolName : undefined,
        ...extra,
      },
    });
  }
}

function unwrapHookCallbackResult(result: HookJSONOutput | HookCallbackResult | void): {
  output: HookJSONOutput | undefined;
  diagnostics: HookCallbackDiagnostics | undefined;
} {
  if (isHookCallbackResult(result)) {
    return { output: result.output, diagnostics: result.diagnostics };
  }
  return { output: result as HookJSONOutput | undefined, diagnostics: undefined };
}

function isHookCallbackResult(value: unknown): value is HookCallbackResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "hookCallbackResult",
  );
}

function sanitizeHookDiagnostics(
  diagnostics: HookCallbackDiagnostics | undefined,
): HookCallbackDiagnostics | undefined {
  if (!diagnostics) return undefined;
  const sanitize = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? sanitizeHookDisplayText(trimmed).slice(0, 4000) : undefined;
  };
  const errorMessage = sanitize(diagnostics.errorMessage);
  const stderrPreview = sanitize(diagnostics.stderrPreview);
  const stdoutPreview = sanitize(diagnostics.stdoutPreview);
  if (!errorMessage && !stderrPreview && !stdoutPreview) return undefined;
  return {
    ...(errorMessage ? { errorMessage } : {}),
    ...(stderrPreview ? { stderrPreview } : {}),
    ...(stdoutPreview ? { stdoutPreview } : {}),
  };
}

export function createInMemoryHookRunner(options?: HookRunnerOptions): InMemoryHookRunner {
  return new InMemoryHookRunner(options);
}
