import { getDefaultConfigPath, updateUiLocaleInFileConfig } from "@zcode/adapters/config";
import type { SessionEvent } from "@zcode/contracts";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import { DEFAULT_LOCALE, type SupportedLocale } from "@zcode/i18n";
import type { TuiRequestPermission } from "@zcode/tui";
import type { GlobalOptions } from "@zcode/shared-types";
import { createCommandCenter, parseSlashCommand } from "./command-center.js";
import type { CommandCenterApp } from "./command-center.js";
import { resolveDisplayLocale } from "./locale.js";
import { createCliHeadlessBrowserRuntime } from "./headless-browser.js";
// Reuse the defensive runtime read: subscribeEvents is not on the app's static type face,
// and two hand-written copies of how-to-read-it would fix only one site when the method is renamed.
import { readRuntimeEventSubscriber } from "./runtime-event-subscriber.js";
import { createTuiSessionEventRelay } from "./tui-session-event-relay.js";
import { attachTuiAppQueries, readTuiSessionMetadata } from "./tui-prompt-handler-queries.js";
import {
  createTuiProcessRuntimeState,
  prepareTuiAppRuntime,
} from "./tui-prompt-handler-runtime.js";
import { DEFAULT_CLI_CLEANUP_TIMEOUT_MS, runCliCleanupWithTimeout } from "./shutdown.js";
import {
  configureApiKeyForTui,
  loginBigmodelForTui,
  loginForTui,
  logoutForTui,
} from "./tui-auth.js";
import {
  listCustomCommandsForTui,
  listSessionsForTui,
  listSkillsForTui,
  loadCustomCommandForTui,
} from "./tui-command-data.js";
import {
  currentCliMode,
  readTuiMode,
  TUI_TITLE_GENERATION_CONFIG,
  type TuiPromptHandler,
} from "./tui-command-state.js";
import { createTuiModelAvailabilityChecker } from "./tui-login-state.js";
import { withTuiMetadata } from "./tui-submit-metadata.js";
import type {
  CliModeState,
  CliPermissionMode,
  CliResumeRequest,
  CliRuntimeMode,
  ModeCapableApp,
  RunDependencies,
} from "./cli-types.js";

export function createTuiSubmitPrompt(
  deps: RunDependencies,
  modeState: CliModeState,
  version: string,
  resumeRequest: CliResumeRequest = { continueSession: false },
  uiLocale?: GlobalOptions["locale"],
  uiDetectedLocale?: GlobalOptions["detectedLocale"],
  startupLocale: SupportedLocale = DEFAULT_LOCALE,
  toolDisallowlist?: readonly string[],
  forceMcs = false,
  browserUse?: GlobalOptions["browserUse"],
  browserExecutable?: GlobalOptions["browserExecutable"],
): TuiPromptHandler {
  let app: Awaited<ReturnType<NonNullable<RunDependencies["createZCodeApp"]>>> | undefined;
  let activeUiLocale = uiLocale;
    // Process-level handles (telemetry / Provider Registry / endpoint routing) survive app swaps; see the runtime file.
  const processRuntime = createTuiProcessRuntimeState();
  let closeHandlerPromise: Promise<void> | undefined;
  const closePromises = new WeakMap<object, Promise<void>>();
  const browserRuntimes = new WeakMap<
    object,
    NonNullable<ReturnType<typeof createCliHeadlessBrowserRuntime>>
  >();
  let activeRequestPermission: TuiRequestPermission | undefined;
  const cleanupTimeoutMs = Math.max(
    1,
    Math.trunc(deps.shutdownCleanupTimeoutMs ?? DEFAULT_CLI_CLEANUP_TIMEOUT_MS),
  );
  const permissionBroker: NonNullable<ZCodeAppOptions["permissionBroker"]> = {
    requestPermission: async (request, requestOptions) => {
      const requestPermission = activeRequestPermission;
      if (!requestPermission) {
        return {
          decision: "deny",
          reason: `No interactive approval handler configured for ${request.toolName}`,
          resolvedAt: new Date(),
        };
      }

      return await requestPermission(request, requestOptions);
    },
  };

  const closeApp = async (targetApp = app): Promise<void> => {
    if (!targetApp) return;
    const closeKey = targetApp as object;
    let closePromise = closePromises.get(closeKey);
    if (!closePromise) {
      closePromise = (async () => {
        await runCliCleanupWithTimeout(async () => targetApp.close?.(), cleanupTimeoutMs);
                // Chromium started by the CLI itself must still be released when App/session close hangs or fails.
        await runCliCleanupWithTimeout(
          async () => browserRuntimes.get(closeKey)?.close(),
          cleanupTimeoutMs,
        );
      })();
      closePromises.set(closeKey, closePromise);
    }
    await closePromise;
  };

    // -- Cross-turn persistent session-event subscription --
    // The per-turn onEvent dies with its turn, missing out-of-turn events (dwf progress, notice-driven turns).
  const sessionEventRelay = createTuiSessionEventRelay({
    currentRuntime: () => (app as { runtime?: unknown } | undefined)?.runtime,
    readSubscriber: readRuntimeEventSubscriber,
  });

  const replaceApp = async (
    factory: () => Promise<Awaited<ReturnType<NonNullable<RunDependencies["createZCodeApp"]>>>>,
  ): Promise<CommandCenterApp> => {
    const previousApp = app;
    const nextApp = await factory();
    app = nextApp;
    if (previousApp && previousApp !== nextApp) {
      await closeApp(previousApp);
    }
        // The persistent subscription must reattach on app swap: this is the single choke point shared by /new, /resume, and /fork;
        // a missed attach means the TUI never again receives out-of-turn events after a session swap (dwf progress, notice-driven turns).
    sessionEventRelay.reattach();
    modeState.current = readTuiMode(app, currentCliMode(modeState));
    return app as unknown as CommandCenterApp;
  };

  const createApp = async (request: CliResumeRequest) => {
    if (closeHandlerPromise) throw new Error("TUI prompt handler is closed");
    const {
      appEnv,
      configuredDefaultModelSelection,
      createAppFactory,
      providerRegistryRuntime,
      sessionId,
      workingDirectory,
    } = await prepareTuiAppRuntime(deps, version, request, processRuntime);
    const browserRuntime = createCliHeadlessBrowserRuntime({ browserExecutable, browserUse }, deps);
    let createdApp: Awaited<ReturnType<NonNullable<RunDependencies["createZCodeApp"]>>>;
    try {
      createdApp = await createAppFactory({
        browserControlPort: browserRuntime?.browserControlPort,
        env: appEnv,
        projectConfigPath: deps.projectConfigPath,
        providerRegistry: providerRegistryRuntime.runtime.registryService,
        configuredDefaultModelSelection,
        ...(providerRegistryRuntime.providerRuntimeHeadersPort
          ? {
              providerRuntimeHeadersPort: providerRegistryRuntime.providerRuntimeHeadersPort,
            }
          : {}),
        resume: sessionId !== undefined,
        runtimeConfig: {
          ...(modeState.override ? { mode: modeState.override } : {}),
          ...(toolDisallowlist ? { toolDisallowlist } : {}),
          ...(forceMcs ? { midConversationSystem: { mode: "force" as const } } : {}),
          modelStreaming: "on",
          titleGeneration: TUI_TITLE_GENERATION_CONFIG,
          workingDirectory,
        },
        permissionBroker,
        sessionId,
        skipUserConfig: deps.skipUserConfig,
        uiDetectedLocale,
        uiLocale: activeUiLocale,
        userConfigPath: deps.userConfigPath,
        version,
      });
    } catch (error) {
      await runCliCleanupWithTimeout(async () => browserRuntime?.close(), cleanupTimeoutMs);
      throw error;
    }
    if (browserRuntime) browserRuntimes.set(createdApp as object, browserRuntime);
        // Init may still be awaiting the old identity import when the TUI closed; a late App must not become the current session again.
    if (closeHandlerPromise) {
      await closeApp(createdApp);
      throw new Error("TUI prompt handler is closed");
    }
    modeState.current = readTuiMode(createdApp, currentCliMode(modeState));
    return createdApp;
  };

  const getApp = async (): Promise<CommandCenterApp> => {
    app ??= await createApp(resumeRequest);
    modeState.current = readTuiMode(app, currentCliMode(modeState));
    return app as unknown as CommandCenterApp;
  };

  const resumeApp = async (sessionId?: string): Promise<CommandCenterApp> => {
    return await replaceApp(
      async () =>
        await createApp(
          sessionId
            ? {
                continueSession: false,
                resumeSessionId: sessionId,
              }
            : {
                continueSession: true,
              },
        ),
    );
  };

  const newApp = async (): Promise<CommandCenterApp> => {
    return await replaceApp(
      async () =>
        await createApp({
          continueSession: false,
        }),
    );
  };

  const setCliMode = async (nextMode: CliPermissionMode): Promise<CliRuntimeMode> => {
    modeState.override = nextMode;

    if (app) {
      const modeCapableApp = app as ModeCapableApp;
      if (modeCapableApp.setMode) {
        const result = await modeCapableApp.setMode(nextMode);
        modeState.current = readTuiMode(modeCapableApp, result.mode);
        return modeState.current;
      }

      modeCapableApp.runtime.updateConfig({ mode: nextMode });
    }

    modeState.current = app ? readTuiMode(app, nextMode) : nextMode;
    return modeState.current;
  };

  const commandCenter = createCommandCenter({
    forkApp: async (targetCheckpointId) => {
      const activeApp = await getApp();
      const result = await activeApp.forkFromCheckpoint?.({ targetCheckpointId });
      if (!result) {
        throw new Error("Forking is not available in this client.");
      }
      await replaceApp(
        async () =>
          await createApp({
            continueSession: false,
            resumeSessionId: result.forkedSessionId,
          }),
      );
      return {
        copiedMessageCount: result.copiedMessageCount,
        forkedSessionId: result.forkedSessionId,
        response: `${result.response}\nSwitched to forked session ${result.forkedSessionId}.`,
        restoredFileCount: result.restoredFileCount ?? result.restoredFiles?.length ?? 0,
      };
    },
    getApp,
    getMode: () => currentCliMode(modeState),
    getLocale: () =>
      app?.getLocale?.() ?? resolveDisplayLocale(activeUiLocale, uiDetectedLocale) ?? startupLocale,
    hasSelectableModels: createTuiModelAvailabilityChecker(getApp),
    listCustomCommands: () => listCustomCommandsForTui(deps),
    listSessions: () => listSessionsForTui(deps),
    listSkills: () => listSkillsForTui(deps),
    configureApiKey: (options) => configureApiKeyForTui(deps, options),
    login: (options) => loginForTui(deps, options),
    loginBigmodel: (options) => loginBigmodelForTui(deps, options),
    loadCustomCommand: (name) => loadCustomCommandForTui(deps, name),
    newApp,
    recordInputHistory: async (input, kind) => {
      await app?.recordInputHistory?.(input, kind);
    },
    resumeApp,
    saveDefaultModelSelection: async (selection) => {
      const runtime = await processRuntime.providerRegistryRuntimePromise;
      if (!runtime?.modelSelectionConfigRepository) {
        throw new Error("Default model configuration storage is unavailable.");
      }
      await runtime.modelSelectionConfigRepository.saveConfiguredDefault(selection);
    },
    logout: () => logoutForTui(deps),
    setLocale: async (locale) => {
      if (app?.setLocale) {
        const result = await app.setLocale(locale);
        activeUiLocale = locale;
        return result;
      }
      activeUiLocale = locale;
      const persisted = await updateUiLocaleInFileConfig(
        deps.userConfigPath ?? getDefaultConfigPath(),
        locale,
      );
      return {
        configPath: persisted.path,
        locale: resolveDisplayLocale(locale, uiDetectedLocale) ?? "en-US",
        requestedLocale: locale,
      };
    },
    setMode: setCliMode,
  });

  const submitPrompt: TuiPromptHandler = async (input, options) => {
    const previousRequestPermission = activeRequestPermission;
    activeRequestPermission = options.requestPermission;

    try {
      const result = await commandCenter(input, options);
      return app ? { ...result, ...(await readTuiSessionMetadata(await getApp())) } : result;
    } finally {
      activeRequestPermission = previousRequestPermission;
    }
  };

  submitPrompt.setMode = async (nextMode) => ({ mode: await setCliMode(nextMode) });

  submitPrompt.sendInput = async (input, options) => {
    const previousRequestPermission = activeRequestPermission;
    // busy-turn or resumed input can start a new turn through sendInput,
    // bypassing submitPrompt's scoped approval handler and leaving approvals invisible.
    activeRequestPermission = options?.requestPermission;

    try {
      // Model/effort changes configure subsequent requests, including during an active turn.
      const command = parseSlashCommand(typeof input === "string" ? input : input.text);
      if (command?.type === "known" && (command.name === "model" || command.name === "effort")) {
        return {
          kind: "command_result",
          result: await submitPrompt(input, {
            ...options,
            abortSignal: options?.abortSignal ?? new AbortController().signal,
          }),
        };
      }
      const activeApp = await getApp();
      if (activeApp.sendInput) {
        const result = await activeApp.sendInput(input, options);
        if (result.kind !== "started_turn") return result;
        return withTuiMetadata(result.result, activeApp, currentCliMode(modeState));
      }

      return withTuiMetadata(
        await activeApp.submitPrompt(input, options),
        activeApp,
        currentCliMode(modeState),
      );
    } finally {
      activeRequestPermission = previousRequestPermission;
    }
  };

  attachTuiAppQueries(submitPrompt, getApp);

  submitPrompt.subscribeSessionEvents = (sink: (event: SessionEvent) => void) => {
    const unsubscribe = sessionEventRelay.addSink(sink);
        // The first real attach misses while the app does not exist yet; attach again once it does (reattach is idempotent, no double fan-out).
    void getApp().then(
      () => sessionEventRelay.reattach(),
      () => undefined,
    );
    return unsubscribe;
  };

    // Main session id: feeds the TUI's session gate (actor/child-session events keep their own sessionId and feed the same sink set).
    // Read fresh every time, never cached: replaceApp swaps the session, and a cached id would judge the whole relay foreign.
  submitPrompt.getMainSessionId = () => {
    const runtime = (app as { runtime?: { getSessionId?: () => string } } | undefined)?.runtime;
    const sessionId = runtime?.getSessionId?.();
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
  };

  submitPrompt.close = async () => {
    closeHandlerPromise ??= (async () => {
      await closeApp();
            // Root cause: the TUI's session switch and process exit share App close; shared Owners must not be closed early on /new-style paths --
            // only terminal Prompt Handler state performs the symmetric shutdown.
      await runCliCleanupWithTimeout(
        async () => processRuntime.shutdownTelemetry?.(),
        cleanupTimeoutMs,
      );
      const providerRegistryRuntime = await processRuntime.providerRegistryRuntimePromise;
      providerRegistryRuntime?.dispose();
    })();
    await closeHandlerPromise;
  };

  return submitPrompt;
}
