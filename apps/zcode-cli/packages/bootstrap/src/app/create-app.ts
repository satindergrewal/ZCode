import { subagentProfilesFromSnapshot } from "../subagent-runtime-config.js";
import { isAbsolute, join, resolve } from "node:path";
import {
  createInMemorySessionEventStore,
  createNodeToolArtifactStore,
} from "@zcode/adapters/storage";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import {
  createNodeExecutionAdapter,
  resolveEffectiveBashShellSelection,
} from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createJimpImageProcessorAdapter } from "@zcode/adapters/image";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";
import { createNodeSessionMailboxAdapter } from "@zcode/adapters/mailbox";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import { createMcpAdapter } from "@zcode/adapters/mcp";
import {
  AgentRuntime,
  normalizeAgentProfiles,
  PermissionService,
  buildPluginReferenceCatalog,
  writeWorkflowDraft,
  type AmendWorkflowRunSettingsInput,
  type ResumeSessionResult,
} from "@zcode/core";
import { createModelTelemetry } from "@zcode/telemetry";
import {
  createRootTraceContext,
  traceContextToLogContext,
  type TraceContext,
  createSessionId,
  createSessionEvent,
  type ExecutionShellSelection,
  type MessageId,
} from "@zcode/contracts";
import { isRemoteWorkspaceIdentity, resolveZCodeRuntimeEnv } from "@zcode/shared";
import {
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
} from "@zcode/shared/zcode-protocol-v4";

import { createModelAdapter } from "../model-factory.js";
import { StartupTimer, startupNow } from "../startup-logging.js";
import { scheduleStartupLogRetentionCleanup } from "../log-retention.js";
import type {
  PrepareUserExecutionBoundary,
  ResumeOptions,
  ZCodeApp,
  ZCodeAppOptions,
} from "./types.js";
import {
  createConfigCliOverrides,
  isMessageEnabled,
  resolveEffectiveLocale,
  resolveEffectiveConfigResult,
} from "./app-config-options.js";
import { getCliStorageRoot, getModelIoDir, projectIdFromDirectory } from "./paths.js";
import {
  asInputHistoryStore,
  asLocalSettingStore,
  openStartupSessionStore,
  readProjectPermissionMode,
  readSessionModelSelection,
} from "./session-store.js";
import { createWorkflowFacade } from "./workflow-facade.js";
import { createInputFacade } from "./input-facade.js";
import { createPluginFacadeForApp } from "./plugin-facade.js";
import { resolvePluginRuntimeFeatures } from "./plugin-runtime-features.js";
import { createSessionFacade } from "./session-facade.js";
import { resolveAppRuntimeConfig, runtimeConfigLogContext } from "./runtime-config.js";
import { resolveBundledSkillRoots } from "./bundled-skills.js";
import { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";
import { createWorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";
import { createScriptWorkflowBridge } from "./script-workflow-methods.js";
import {
  createDynamicWorkflowRunService,
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
} from "./dynamic-workflow-run-service.js";
import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";
import { createDynamicWorkflowSnippetService } from "./dynamic-workflow-snippet-service.js";
import { createModelCatalogPort } from "./model-catalog-port.js";
import { createDynamicWorkflowRunProgressSink } from "./dynamic-workflow-run-progress-sink.js";
import { createScriptWorkflowAgentRuntime } from "./script-workflow-child-runtime.js";
import { workflowActorModelPolicy } from "./workflow-actor-model.js";
import {
  workflowActorInteractionDescription,
  workflowActorPermissionPolicy,
} from "./workflow-actor-permission.js";
import { workflowActorToolPolicy } from "./workflow-actor-tools.js";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./node-repl-browser-broker.js";
import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import { resolveZCodeCustomCommandPrompt } from "../custom-command-prompt.js";
import { resolveZCodeBuiltinPromptCommandInvocation } from "../builtin-prompt-command.js";
import { BUILTIN_WORKFLOW_COMMAND_NAME } from "../builtin-workflow-command.js";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import {
  loadPluginAgentTemplates,
  resolvePluginAgentProfiles,
  loadZCodeAgentProfiles,
} from "../subagents.js";
import { createRuntimeAiSdkModelExecutionConfig } from "../model-config.js";
import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import {
  completeAppStartup,
  debugRuntimeConfigResolved,
  markConfigurationLoaded,
  markMcpAdapterInitialized,
  markRuntimeConstructed,
  markStorageAdaptersInitialized,
  resolveStartupPlugins,
  startAppStartup,
} from "./startup-marks.js";

function decodePromptAttachmentDataUrl(
  content: string,
  fallbackMime: string,
  maxBytes: number,
): { bytes: Uint8Array; mediaType: string } {
  const commaIndex = content.indexOf(",");
  const headerParts =
    content.slice(0, "data:".length).toLowerCase() === "data:" && commaIndex >= 0
      ? content.slice("data:".length, commaIndex).split(";")
      : [];
  const mediaType = (headerParts.shift()?.trim() || fallbackMime).split(";", 1)[0]!.toLowerCase();
  const payload = commaIndex >= 0 ? content.slice(commaIndex + 1) : "";
  if (
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) ||
    payload.length % 4 !== 0
  ) {
    throw new Error("fault.attachment.previewArtifactInvalid");
  }
  if (
    !mediaType.startsWith("image/") &&
    !mediaType.startsWith("video/") &&
    mediaType !== "application/pdf" &&
    // Root cause: text materials reuse the upload artifact path, but the legacy data-URL decoder accepted media only, rejecting legitimate previews twice.
    !(
      mediaType === "text/plain" &&
      fallbackMime.split(";", 1)[0]?.trim().toLowerCase() === "text/plain"
    )
  ) {
    throw new Error("fault.attachment.previewNotMedia");
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength > maxBytes) {
    throw new Error("fault.attachment.previewTooLarge");
  }
  return { bytes, mediaType };
}

export async function createZCodeApp(options: ZCodeAppOptions): Promise<ZCodeApp> {
  if (!options?.providerRegistry) {
    throw new Error("createZCodeApp requires a Provider Registry");
  }
  const startupStartedAt = startupNow();
  const appVersion = options.version ?? "0.0.0";
  const sessionId = options.sessionId ?? createSessionId();
  const traceContext = options.traceContext ?? createRootTraceContext({ sessionId });
  const workingDirectory = resolve(options.runtimeConfig?.workingDirectory ?? process.cwd());
  const configResult = resolveEffectiveConfigResult(
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
      cliOverrides: createConfigCliOverrides(options),
    }),
    options,
  );
  const loggerFactory = options.loggerFactory ?? createNodeLoggerFactory({ env: options.env });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap",
  });
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap",
      startupKind: "zcode_app",
    },
    startupStartedAt,
  );
  startAppStartup({
    hasInjectedModelAdapter: options.modelAdapter !== undefined,
    resume: options.resume === true,
    startupTimer,
  });
  markConfigurationLoaded({
    configResult,
    startupTimer,
  });
  const modelLogger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "adapters.model",
  });
  const modelTelemetry = createModelTelemetry({
    owner: options.telemetryOwner,
    sessionId,
  });
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let ownedNodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let providerModelRuntime: ApiProviderModelRuntime | undefined;
  try {
    const storageRoot = resolvePath(configResult.config.storage.dir);
    const cliStorageRoot = getCliStorageRoot(storageRoot);
    const modelIoDir = getModelIoDir(
      cliStorageRoot,
      resolveZCodeRuntimeEnv(options.env ?? process.env) === "development",
    );
    // Initialization and the parent turn must use the same Host source, or the CLI storage.dir's other definition vanishes on the first turn.
    const hostSubagentSnapshot = await options.readSubagentRuntimeConfig?.({
      signal: new AbortController().signal,
      traceContext,
    });
    const zcodeSubagentProfileOutcome = hostSubagentSnapshot
      ? subagentProfilesFromSnapshot(hostSubagentSnapshot)
      : await loadZCodeAgentProfiles({ logger, storageRoot, workingDirectory });
    const zcodeSubagentProfiles = zcodeSubagentProfileOutcome.profiles;
    const pluginOutcome = resolveStartupPlugins({
      cliStorageRoot,
      configResult,
      env: options.env,
      logger,
      options,
      startupTimer,
      workingDirectory,
    });
    // Skill bundles bundled with the CLI (dynamic-workflows etc.): part of no plugin; users can neither disable nor uninstall them.
    const bundledSkillRoots = resolveBundledSkillRoots({ cliStorageRoot, logger });
    const pluginTemplates = loadPluginAgentTemplates({ logger, plugins: pluginOutcome.plugins });
    const pluginSubagentProfiles =
      hostSubagentSnapshot?.kind === "built-in-fallback"
        ? []
        : resolvePluginAgentProfiles(
            {
              logger,
              plugins: pluginOutcome.plugins,
              reservedProfileNames: zcodeSubagentProfiles.map((profile) => profile.name),
              modelSelectionOverrides:
                zcodeSubagentProfileOutcome.pluginAgentModelSelectionOverrides,
            },
            pluginTemplates,
          ).profiles;
    const pluginRuntimeFeatures = resolvePluginRuntimeFeatures(pluginOutcome);
    const builtInMcpServers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome,
      workingDirectory,
    });
    // User dirs were migrated in place before the loader; no in-memory compat shims for stale project/plugin identities.
    const subagentProfiles = [...zcodeSubagentProfiles, ...pluginSubagentProfiles];
    const ownsSessionStore = options.sessionStore === undefined;
    const sessionStore =
      options.sessionStore ?? (await openStartupSessionStore(configResult, startupTimer));
    const localSettingStore = asLocalSettingStore(sessionStore);
    const projectID = projectIdFromDirectory(workingDirectory);
    const persistedMode = options.runtimeConfig?.mode
      ? undefined
      : readProjectPermissionMode(localSettingStore, projectID);
    let { configuredMcpServers, runtimeConfig, untrustedProjectMcpServers } =
      resolveAppRuntimeConfig({
        cliStorageRoot,
        configResult,
        options,
        persistedMode,
        pluginHooks: pluginOutcome.hooks,
        pluginMcpServers: pluginOutcome.mcpServers,
        builtInMcpServers,
        pluginRuntimeFeatures,
        builtInSubagentModelSelectionOverrides:
          zcodeSubagentProfileOutcome.builtInModelSelectionOverrides,
        subagentOutputRootDir: join(cliStorageRoot, "agents"),
        subagentProfiles,
        storageRoot,
        workingDirectory,
        workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      });
    const browserControlPort = options.browserControlPort;
    if (
      browserControlPort &&
      pluginRuntimeFeatures.browserUse === true &&
      runtimeConfig.mcp?.servers?.node_repl?.type === "stdio"
    ) {
      nodeReplBrowserBroker =
        options.nodeReplBrowserBroker ??
        (ownedNodeReplBrowserBroker = createNodeReplBrowserBroker({
          browserControlPort,
          logger,
          platform: options.platform,
        }));
      configuredMcpServers = injectNodeReplBrowserBroker(
        configuredMcpServers,
        nodeReplBrowserBroker,
      );
      runtimeConfig.mcp = {
        ...runtimeConfig.mcp,
        servers: injectNodeReplBrowserBroker(
          runtimeConfig.mcp.servers ?? {},
          nodeReplBrowserBroker,
        ),
      };
    }
    startupTimer.mark("ZCode runtime configuration resolved", {
      context: runtimeConfigLogContext(runtimeConfig, workingDirectory),
      event: "bootstrap.app.startup.runtime_config.completed",
      stage: "resolve_runtime_config",
    });
    // Plugin conversation references: the identity catalog is frozen once at App (Session runtime)
    // creation. Cold recovery rebuilds the App and naturally gets the new catalog; existing Sessions do not hot-load new Plugins.
    const pluginReferenceCatalog = buildPluginReferenceCatalog(pluginOutcome.plugins);
    runtimeConfig.pluginReferenceCatalog = pluginReferenceCatalog;
    let runtime: AgentRuntime | undefined;
    const workspaceHookRuntimeSecurity = createWorkspaceHookRuntimeSecurity({
      appVersion,
      logger,
      projectConfigPath: options.projectConfigPath,
      policy: options.workspaceHookPolicy,
      policyProvider: options.workspaceHookPolicyProvider,
      reviewHost: options.workspaceHookReviewHost,
      workspaceHookTrustEnabled: options.workspaceHookTrustEnabled,
      runtimeRoot: configResult.sources.project.workspaceHookRuntimeRoot ?? {
        // Fallback applies only when config-factory exported nothing (theoretically impossible).
        // This used to rebuild runtimeRoot unconditionally from the single runtimeConfig.hooks
        // layer, diverging from config-factory's derivation across default/user/project/env/cli,
        // so review snapshots and toggle rebuilds hashed different bundleDigests and a
        // toggle-during-review got misreported as workspace_hooks_snapshot_mismatch.
        enabled: runtimeConfig.hooks?.enabled === true,
        timeoutMs: runtimeConfig.hooks?.timeoutMs ?? 60_000,
        maxOutputBytes: runtimeConfig.hooks?.maxOutputBytes ?? 32_768,
      },
      sessionId,
      snapshot: configResult.sources.project.workspaceHookSnapshot,
      userConfigPath: configResult.sources.user.path,
      workingDirectory,
      ...(options.workspaceHookReviewHost
        ? {
            emitReviewEvent: async (event) => {
              if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
              await runtime.appendEvent(
                createSessionEvent(event.type, sessionId, event.payload, {
                  traceId: traceContext.traceId,
                }),
                traceContext,
              );
            },
            emitAdmissionEvent: async (event) => {
              if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
              await runtime.appendEvent(
                createSessionEvent(event.type, sessionId, event.payload, {
                  traceId: traceContext.traceId,
                }),
                traceContext,
              );
            },
          }
        : {}),
    });
    const permissionService = new PermissionService({
      allowedTools: new Set(configResult.config.permission.allowedTools),
      autoApproveHighRisk: configResult.config.permission.autoApproveHighRisk,
      disallowedTools: new Set(configResult.config.permission.disallowedTools),
      allowMediumRiskInAutoMode: configResult.config.permission.allowMediumRiskInAuto,
    });
    const inputHistoryStore = options.inputHistoryStore ?? asInputHistoryStore(sessionStore);
    const artifactStore =
      options.artifactStore ??
      createNodeToolArtifactStore({
        imageCacheRootDir: join(storageRoot, "cli", "image-cache"),
        pdfCacheRootDir: join(storageRoot, "cli", "pdf-cache"),
        rootDir: join(storageRoot, "cli", "artifacts"),
        videoCacheRootDir: join(storageRoot, "cli", "video-cache"),
      });
    const imageProcessorPort = options.imageProcessorPort ?? createJimpImageProcessorAdapter();
    const messageEnabled = isMessageEnabled(options.env ?? process.env);
    const sessionMailboxPort =
      options.sessionMailboxPort ??
      (messageEnabled
        ? createNodeSessionMailboxAdapter({
            rootDir: resolvePath(
              (options.env ?? process.env).ZCODE_MAILBOX_ROOT ?? "~/.zcode/mailbox",
            ),
          })
        : undefined);
    markStorageAdaptersInitialized({
      cliStorageRoot,
      hasInjectedArtifactStore: options.artifactStore !== undefined,
      hasInjectedSessionStore: options.sessionStore !== undefined,
      startupTimer,
      storageRoot,
    });
    const mcpPort =
      options.mcpPort ??
      (runtimeConfig.mcp?.enabled === false
        ? undefined
        : (options.mcpPortFactory?.({ workingDirectory }) ??
          createMcpAdapter({
            clientVersion: appVersion,
            env: options.env,
            logger,
            network: {
              httpProxy: configResult.config.network.httpProxy,
              noProxy: configResult.config.network.noProxy,
              caCertFile: configResult.config.network.caCertFile,
            },
            workingDirectory,
          })));
    const ownsMcpPort = options.mcpPort === undefined && mcpPort !== undefined;
    const executionPort =
      options.executionPort ??
      createNodeExecutionAdapter({
        onToolExecResource: options.onToolExecResource,
        network: {
          httpProxy: configResult.config.network.httpProxy,
          noProxy: configResult.config.network.noProxy,
          caCertFile: configResult.config.network.caCertFile,
        },
        outputRootDir: join(storageRoot, "cli", "exec"),
        processEnv: options.env ?? process.env,
      });
    const ownsExecutionPort = options.executionPort === undefined;
    const pdfDocumentPort =
      options.pdfDocumentPort ?? createPopplerPdfDocumentAdapter({ executionPort });
    // browser-use control port: available only when the host (desktop) injects it; no local fallback (plain CLI has no browser stack).
    const fileSystemPort = options.fileSystemPort ?? createNodeFileSystemAdapter();
    const httpClientPort =
      options.httpClientPort ??
      createNodeWebFetchHttpClientAdapter({
        env: options.env ?? process.env,
        timeoutMs: configResult.config.network.timeout,
        proxyUrl: configResult.config.network.httpProxy,
        noProxy: configResult.config.network.noProxy,
        caCertFile: configResult.config.network.caCertFile,
      });
    const providerEndpointRoutingPort = options.providerEndpointRoutingPort;
    markMcpAdapterInitialized({
      configuredMcpServers,
      hasInjectedMcpPort: options.mcpPort !== undefined,
      mcpEnabled: runtimeConfig.mcp?.enabled !== false,
      startupTimer,
      trustedMcpServerCount: Object.keys(runtimeConfig.mcp?.servers ?? {}).length,
    });
    debugRuntimeConfigResolved({
      configResult,
      logger,
      runtimeConfig,
    });
    const getRuntime = (): AgentRuntime => {
      if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
      return runtime;
    };
    let resumePrepared = false;
    const resolveDefaultShellSelection = (): ExecutionShellSelection =>
      resolveEffectiveBashShellSelection({
        env: options.env ?? process.env,
        platform: options.platform ?? process.platform,
      }).selection;
    let initialShellSelectionPromise: Promise<ExecutionShellSelection> | undefined;
    const resolveInitialShellSelection = (): Promise<ExecutionShellSelection> => {
      initialShellSelectionPromise ??= (async () =>
        (await options.resolveInitialBashShellSelection?.()) ?? resolveDefaultShellSelection())();
      return initialShellSelectionPromise;
    };
    const initializeSessionShellEnvironment = async (): Promise<void> => {
      getRuntime().initializeSessionShellEnvironmentIfNeeded(await resolveInitialShellSelection());
    };

    const restorePersistedModelSelection = async (): Promise<
      ResumeSessionResult["modelSelection"]
    > => {
      const registry = options.providerRegistry;
      let selection: ResumeSessionResult["modelSelection"];
      try {
        // Database startup has run the versioned migrations; recovery only reads new fields and never re-migrates per session.
        selection = await readSessionModelSelection(sessionStore, sessionId);
      } catch (error) {
        // Read/parse failures of the selection entry must not sink standalone history recovery; keep the real storage error,
        // and never mask the failure by reading legacy messages or a default model.
        logger.warn("Session model selection restore failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "session.model_selection.restore_failed",
          sessionId,
        });
      }
      const validation = selection && registry.validateSelection(selection);
      if (selection && validation && !validation.ok) {
        // Observation: a validation failure affects the runtime binding only, not the saved intent; but once unbound, a later highspeed-only
        // turn has no chance to rebind. It used to be silently blanked in the 600ms window where the Registry was ready but entitlements
        // unresolved, surfacing only at card-expiry downgrade with no fallback target and nothing in the logs.
        logger.warn("Session model selection restored but not bound to the runtime", {
          event: "session.model_selection.restore_unbound",
          modelId: selection.modelId,
          providerId: selection.providerId,
          sessionId,
          validationCode: validation.code,
        });
      }
      // Existence-only checks would rebind a missing-tier/deleted selection into the Runtime,
      // undoing unbound-init. History recovery does not demand an executable model; only a complete selection binds.
      getRuntime().setSessionModelSelection(validation?.ok ? selection : undefined);
      // The recovery result is a saved intent, not a runtime binding. Blank/tier-deletion here used to hide the original intent from the Host's
      // Selection View forever, surviving neither account switches nor config restores.
      return selection;
    };

    const resumeFromStore = async (resumeOptions?: ResumeOptions): Promise<ResumeSessionResult> => {
      const runtime = getRuntime();
      const unsubscribe = resumeOptions?.onEvent
        ? runtime.subscribeEvents({ onSessionEvent: resumeOptions.onEvent })
        : undefined;

      try {
        const resumeTraceContext = resumeOptions?.traceContext ?? traceContext;
        const modelSelection = await restorePersistedModelSelection();
        await initializeSessionShellEnvironment();
        const result = await runtime.resumeFromStore({
          ...(resumeOptions?.abortSignal ? { abortSignal: resumeOptions.abortSignal } : {}),
          // Pass only the caller's original mode; project/global defaults must not pose as an invocation override,
          // or interactive resume could never restore the actually persisted session mode.
          modeOverride: options.runtimeConfig?.mode,
          persistedMessages: resumeOptions?.persistedMessages,
          traceContext: resumeTraceContext,
        });
        const resumedTarget = await runtime.activatePausedTargetAfterResume(resumeTraceContext);
        // Mission mode (ZCODE_MISSION_CONTINUATION): after a cold resume, fire the goal
        // continuation loop immediately so hardware-gated mission work resumes without a
        // manual /goal resume. The loop is a safe no-op when no active goal exists.
        if (process.env.ZCODE_MISSION_CONTINUATION === "1" && resumedTarget?.status === "active") {
          void runtime
            .continueActiveTargetLoop({
              traceContext: resumeTraceContext,
              trigger: "manual",
              verifyBeforeFirstContinue: false,
            })
            .catch((error: unknown) => {
              logger.warn("Mission goal continuation after resume failed", {
                error: error instanceof Error ? error.message : String(error),
                event: "mission.goal_continuation.resume_failed",
              });
            });
        }
        resumePrepared = true;
        return { ...result, modelSelection };
      } finally {
        unsubscribe?.();
      }
    };

    const prepareResume = async (
      submitTraceContext?: TraceContext,
      abortSignal?: AbortSignal,
    ): Promise<void> => {
      if (!options.resume || resumePrepared) return;
      await resumeFromStore({
        ...(abortSignal ? { abortSignal } : {}),
        traceContext: submitTraceContext ?? traceContext,
      });
      resumePrepared = true;
    };

    const prepareUserExecutionBoundary: PrepareUserExecutionBoundary = async (boundaryOptions) => {
      // The bash shell snapshot belongs to the first-real-user-execution boundary, not to chat
      // input alone. A plain prompt, expert workflow, or script workflow can each be a new
      // session's first model/subagent entry, so it must settle once before resume/context init,
      // keeping the model-visible shell and the Bash execution shell from diverging.
      await initializeSessionShellEnvironment();
      await prepareResume(boundaryOptions?.traceContext, boundaryOptions?.abortSignal);
    };

    const modelExecutionConfig = createRuntimeAiSdkModelExecutionConfig(options.env, {
      appVersion,
      endpointRoutingPort: providerEndpointRoutingPort,
      network: configResult.config.network,
      sourceTitle: options.sourceTitle,
    });
    const modelAdapter =
      options.modelAdapter ??
      createModelAdapter({
        env: options.env,
        logger: modelLogger,
        modelIoDir,
        modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
        executionConfig: modelExecutionConfig,
        statusSink: modelTelemetry.statusSink,
        streamIdleTimeoutMs: configResult.config.modelStream.idleTimeoutMs,
      });
    if (options.modelAdapter && modelTelemetry.statusSink) {
      modelAdapter.addStatusSink(modelTelemetry.statusSink);
    }
    // Process-level concurrency governor: the run service gets a narrow port for the
    // driver (one request-admission port per actor runtime); the main runtime hooks its observer (deps below) --
    // no queueing, no cooldown, but in-flight counting and signal feeding. Process-level singleton: quotas live on the account, not per session.
    // No more adapter-level addStatusSink feeding: one event feeds at most once per ticket.
    const workflowConcurrencyGovernor = getWorkflowConcurrencyGovernor();
    modelAdapter.setModelIoFullRetentionEnabled(options.modelIoFullRetentionEnabled ?? false);
    providerModelRuntime = new ApiProviderModelRuntime({
      registry: options.providerRegistry,
      modelAdapter,
    });
    providerModelRuntime.start();
    // The model factory is constructed before all three workflow-child assembly lines: the script bridge, dwf actor
    // runtime and expert facade all SHARE the parent session's factory; only then do Models created after a Registry view
    // update see it, and children never freeze their own copy.
    const modelFactory = providerModelRuntime.modelFactory;
    const scriptWorkflowFacade = createScriptWorkflowBridge({
      agentTelemetry: modelTelemetry.agentExecution,
      appOptions: options,
      appVersion,
      artifactStore,
      configResult,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      pluginSkillRoots: pluginOutcome.skillRoots,
      prepareUserExecutionBoundary,
      getRuntime,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });

    // Workflow run service: the side that actually starts the engine after CreateWorkflow's confirm is Allowed.
    // When the journal narrowing fails (store without dwf_* tables) the service is NOT constructed -- the port stays undefined
    // and CreateWorkflow falls back to the placeholder diagnostic path. A logged visible degradation, never a
    // silently-dropped persistent run path (see dynamic-workflow-run-service.ts's header).
    const dynamicWorkflowJournal = resolveDynamicWorkflowJournalStore(sessionStore, logger);
    const dynamicWorkflowRunPort =
      dynamicWorkflowJournal === undefined
        ? undefined
        : createDynamicWorkflowRunService({
            concurrency: workflowConcurrencyGovernor,
            createActorRuntime: ({
              actor,
              persona,
              pinnedModel,
              runSubagentModel,
              actorModel,
              subagentPermissionMode,
              sessionId: actorSessionId,
              submitPort,
              submitProfile,
              escalatePort,
              modelRequestAdmission,
            }) =>
              createScriptWorkflowAgentRuntime({
                childSessionId: actorSessionId,
                configOverrides: {
                  // The persona's identity (effective name + system) -> the context builder's workflow-subagent path.
                  // Anonymous/no-system leaves fields absent; the builder omits the named clause and persona section accordingly.
                  workflowActor: {
                    ...(persona.name === undefined ? {} : { name: persona.name }),
                    ...(persona.system === undefined ? {} : { persona: persona.system }),
                  },
                  // The actor tool surface is subtractive (all tools minus plan and meta tools); expressible only via configOverrides
                  // (request.opts.tools is allowlist-shaped).
                  ...workflowActorToolPolicy(),
                  // Permission surface: subagents run the launching session's permission mode (plan aside); unrecorded = YOLO.
                  // （docs/dynamic-workflow/launch.md「Permissions inside a run」）。
                  ...workflowActorPermissionPolicy(subagentPermissionMode),
                  // Model surface: runSubagentModel is THIS run's own choice (subagent_model); present, it overrides
                  // wholesale and ranks above the pin -- the main agent is unaffected. With neither, no override: the child runtime's
                  // baseline already is the parent's current model (the factory baseline; see script-workflow-child-runtime.ts).
                  // A resume-carried pin pins the last actually-run model (the persisted half of the persona-freeze invariant, see
                  // workflow-actor-model.ts's priority table); parentSelection takes the parent's CURRENT choice,
                  // same source as the factory baseline, so the pin comparison cannot drift.
                  ...workflowActorModelPolicy(
                    {
                      parentSelection: getRuntime().getSessionModelSelection(),
                      ...(runSubagentModel === undefined ? {} : { runSelection: runSubagentModel }),
                      // A persona-named model (the script agent(..., { model })) ranks above the run choice.
                      ...(actorModel === undefined ? {} : { actorSelection: actorModel }),
                    },
                    pinnedModel,
                  ).configOverrides,
                },
                deps: {
                  agentTelemetry: modelTelemetry.agentExecution,
                  appOptions: options,
                  appVersion,
                  artifactStore,
                  configResult,
                  fileSystemPort,
                  httpClientPort,
                  imageProcessorPort,
                  logger,
                  mcpPort,
                  // The parent session model factory: actor and main turns build Models from the
                  // same Registry view, no per-side frozen copy.
                  modelFactory,
                  permissionService,
                  pluginSkillRoots: pluginOutcome.skillRoots,
                  runtime: getRuntime(),
                  runtimeConfig,
                  sessionId,
                  sessionStore,
                  storageRoot,
                  workingDirectory,
                },
                // The persona no longer replaces the subagent system prompt wholesale via request.opts.systemPrompt; it layers
                // onto the base via workflowActor.
                // request here is a factory-signature placeholder: empty opts means "override nothing".
                request: { opts: {} } as never,
                // The permission prompt's origin badge names this subagent: <persona name> (<siteId>@<ordinal>).
                interactionDescription: workflowActorInteractionDescription({ actor, persona }),
                // The subagent's Browser Use: the parent's port, child-port derived via forChildSession (tab ownership is the
                // actor's own sessionId). The actor runtime calls closeBrowserSession at run dispose,
                // closing the tab and deregistering (dynamic-workflow/docs/execution-engine.md, "Subagent sessions").
                ...(browserControlPort === undefined ? {} : { browserControlPort }),
                traceContext,
                // submit profile -> submit_result shapes:
                // untyped injects no port (core's registration gate is port presence, so the tool does not exist -- a fully untyped
                // subagent has nowhere to submit anyway); mono injects port + typed schema; generic the port only (generic schema).
                ...(submitProfile.kind === "untyped" ? {} : { workflowSubmitPort: submitPort }),
                // Unfolding: dwf's JsonSchema is an interface without index signature, contracts' is a Record;
                // a literal spread gains the implicit index signature, no converter needed between the packages.
                ...(submitProfile.kind === "mono"
                  ? { workflowSubmitSchema: { ...submitProfile.schema } }
                  : {}),
                // Escalate port rides with the submit port: both are control channels of the actor session, and port presence
                // IS core's registration gate. Always passed (the run service always builds it), never opt-in --
                // the actor most likely to hit an unforeseen wall is exactly the one the author did not mark.
                workflowEscalatePort: escalatePort,
                // Request-admission port: provided by the driver when the governor exists; every runner attempt passes the gate first.
                ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
              }),
            // Boundary accounting and transcript truncation both read/write actor session messages; it must be the same store.
            actorTranscriptStore: sessionStore,
            // Where user-facing artifact bytes land: the same tool-artifact store as the main session and workflow
            // subagents, so artifacts share the directory tree of other large results.
            artifactStore,
            executionPort,
            fileSystemPort,
            journal: dynamicWorkflowJournal,
            logger,
            // The progress projection seam: one engine event -> one parent-session event -> v4's workflowRuns state key.
            // Going through the runtime append chain (not pushing eventSink directly) is required: only it persists,
            // backfills sequenceNumber and fans out, making cold recovery and replayable reconnect free.
            //
            // Identity gate, runtime-not-ready and append-failure degradation paths all live in this sink (with their unit tests);
            // see dynamic-workflow-run-progress-sink.ts's header.
            onRunEvent: createDynamicWorkflowRunProgressSink({
              // Lazy: the run service is built before the runtime exists (it is one of the AgentRuntime dependencies).
              getRuntime,
              logger,
              sessionId,
            }),
            // Orphan convergence scope: this app's sessions. At construction, non-terminal runs THIS session left in the journal
            // (dead-process relics) converge to failed; sibling sessions' in-flight runs are never touched.
            parentSessionId: sessionId,
            // fill): the inline rule has one implementation, in the tool layer; inject it here rather than copying it into the run service.
            // the inline rule has one implementation, in the tool layer; inject it here rather than copying it into the run service.
            writeWorkflowDraft,
            // The session's permission mode at run creation (recorded on run-launched; subagents follow).
            // Lazy, same as onRunEvent: launches only come from tool calls or v4 commands, when the runtime is necessarily ready.
            permissionMode: () => getRuntime().getMode(),
            // An in-flight engine pins this session resident. The 2026-09-15 bug: the engine was not in the runtime task registry, so the
            // resident pool closed an App with in-flight runs as idle (10 min) and resume started a second engine.
            // Lazy runtime fetch, same as onRunEvent: the run service is an AgentRuntime dependency, constructed earlier;
            // launches only come from tool calls or v4 commands, when the runtime is necessarily ready.
            registerResidencyBlockingWork: (work) => {
              void getRuntime().trackResidencyBlockingWork(work);
            },
            // Launch anchor: CreateWorkflow runs inside the parent's active turn,
            // whose inputId is the message the subagent's agent_step attaches to. If trace.turnId does not match the active turn
            // (theoretically impossible), hand back to the submit side's fallback mint; never record another turn's id as the anchor.
            resolveLaunchInputId: (trace) => {
              const active = getRuntime().getActiveTurnInfo();
              return active !== undefined && active.turnId === trace.turnId
                ? active.inputId
                : undefined;
            },
            ...(isDynamicWorkflowTaskLinkStore(sessionStore)
              ? { taskLinkStore: sessionStore }
              : {}),
          });
    // The dwf snippet service: EvalWorkflowSnippet's execution surface. Deliberately NOT dependent on the dwf journal:
    // a snippet is fully transient (in-memory journal) and must not inherit the run service's durability premise;
    // so even with the run port unconstructed for lack of journal, the experiment channel works.
    const dynamicWorkflowSnippetPort = createDynamicWorkflowSnippetService({
      executionPort,
      fileSystemPort,
      logger,
    });
    // Model catalog: lets the tool layer resolve user-spoken model names into workflow-run subagent selections (model-catalog-port.ts).
    const modelCatalogPort = createModelCatalogPort({
      registry: options.providerRegistry,
      currentSelection: () => getRuntime().getSessionModelSelection(),
    });
    runtime = new AgentRuntime(sessionId, runtimeConfig, {
      ...(options.readSubagentRuntimeConfig
        ? {
            loadAgentDefinitions: async (input) => {
              const snapshot = await options.readSubagentRuntimeConfig!(input);
              const parsed = subagentProfilesFromSnapshot(snapshot);
              const pluginProfiles =
                snapshot.kind === "built-in-fallback"
                  ? []
                  : resolvePluginAgentProfiles(
                      {
                        logger,
                        plugins: pluginOutcome.plugins,
                        reservedProfileNames: parsed.profiles.map((profile) => profile.name),
                        modelSelectionOverrides: parsed.pluginAgentModelSelectionOverrides,
                      },
                      pluginTemplates,
                    ).profiles;
              return {
                activeAgents: normalizeAgentProfiles(
                  [
                    ...(options.runtimeConfig?.subagents?.profiles ?? []),
                    ...parsed.profiles,
                    ...pluginProfiles,
                  ],
                  {
                    builtInModelSelectionOverrides: {
                      ...parsed.builtInModelSelectionOverrides,
                      ...options.runtimeConfig?.subagents?.builtInModelSelectionOverrides,
                    },
                  },
                ),
              };
            },
          }
        : {}),
      agentTelemetry: modelTelemetry.agentExecution,
      // Main-agent model requests pass the governor observer: granted immediately, but the governor sees the 429s / successes.
      modelRequestAdmission: workflowConcurrencyGovernor.observer(),
      eventStore: options.eventStore ?? createInMemorySessionEventStore(),
      sessionStore,
      sessionMailboxPort,
      logger,
      executionPort,
      workspaceHookAdmission: workspaceHookRuntimeSecurity?.admission,
      workspaceHookSnapshot: workspaceHookRuntimeSecurity?.snapshot,
      browserControlPort,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      artifactStore,
      contextSourcePort:
        options.contextSourcePort ?? createNodeContextSourceAdapter({ env: options.env }),
      skillPort:
        configResult.config.features.skill && configResult.config.skills.enabled
          ? (options.skillPort ??
            createNodeSkillAdapter({
              extraRoots: configResult.config.skills.roots,
              extraResolvedRoots: [...pluginOutcome.skillRoots, ...bundledSkillRoots],
              disabledPaths: [
                ...collectDisabledPaths(configResult.config.skillOverrides),
                // With dynamic workflows disabled, do not provide the dynamic-workflows skill:
                // none of the ten tools exist; letting the model read "how to write workflow scripts" only invites calls to nonexistent tools.
                ...(runtimeConfig.dynamicWorkflowEnabled === false
                  ? collectDynamicWorkflowDisabledSkillPaths(bundledSkillRoots)
                  : []),
              ],
            }))
          : undefined,
      mcpPort,
      eventSink: options.eventSink,
      modelFactory,
      modelIoDir,
      providerRuntimeHeadersPort: options.providerRuntimeHeadersPort,
      resolveEffectiveModelSelection: options.resolveEffectiveModelSelection,
      isRemoteWorkspace: () =>
        isRemoteWorkspaceIdentity(runtimeConfig.memory?.workspaceIdentity ?? ""),
      permissionBroker: options.permissionBroker,
      permissionService,
      workflowPort: scriptWorkflowFacade.workflowPort,
      dynamicWorkflowRunPort,
      dynamicWorkflowSnippetPort,
      modelCatalogPort,
      automationPort: options.automationPort,
      offPeakPort: options.offPeakPort,
      topicResourcePort: options.topicResourcePort,
      appVersion,
      traceContext,
    });
    markRuntimeConstructed({
      hasInjectedModelAdapter: options.modelAdapter !== undefined,
      sessionId,
      startupTimer,
    });
    completeAppStartup({
      sessionId,
      startupTimer,
      workingDirectory,
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    const inputFacade = createInputFacade({
      artifactStore,
      customCommandPromptResolver: async (text, resolverOptions) => {
        const builtin = resolveZCodeBuiltinPromptCommandInvocation(text, {
          // With the rollout disabled, the builtin /workflow must not expand (DWG-03). The catalog side already removes it from the / panel,
          // but the name can still be typed; both paths must conclude identically. Standalone CLI TUI and headless
          // read --workflow-mode explicitly; absent (in-process embedders) sets no gate, see the runtimeConfig field docs.
          dynamicWorkflowEnabled: runtimeConfig.dynamicWorkflowEnabled,
          workingDirectory,
        });
        if (builtin !== undefined) {
          if (builtin.name === BUILTIN_WORKFLOW_COMMAND_NAME) {
            // /workflow's expansion point is the on-demand session's activation (launch.md, "On demand: activation"):
            // before executeTurn, so the turn's first model request already carries the ten tools. no-op for alwaysOn / already-activated sessions.
            // Ask the runtime, not the closure's runtimeConfig: config is copied at construction and the closure cannot see flips.
            await runtime?.activateDynamicWorkflowTools({
              source: "command",
              traceContext: resolverOptions?.traceContext ?? traceContext,
            });
          }
          return builtin.prompt;
        }
        return await resolveZCodeCustomCommandPrompt(text, {
          env: options.env,
          executionPort,
          logger,
          projectConfigPath: options.projectConfigPath,
          sessionId,
          signal: resolverOptions?.abortSignal,
          skipUserConfig: options.skipUserConfig,
          traceContext: resolverOptions?.traceContext ?? traceContext,
          userConfigPath: options.userConfigPath,
          workingDirectory,
        });
      },
      inputHistoryStore,
      logger,
      prepareUserExecutionBoundary,
      runtime,
      sessionId,
      traceContext,
    });
    const workflowFacade = createWorkflowFacade({
      agentTelemetry: modelTelemetry.agentExecution,
      appOptions: options,
      appVersion,
      artifactStore,
      cliStorageRoot,
      configResult,
      eventSink: options.eventSink,
      imageProcessorPort,
      pdfDocumentPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      prepareUserExecutionBoundary,
      runtime,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });
    const sessionFacade = createSessionFacade({
      // On App close, stop the dwf runs this session owns:
      // the engine lives in this App's closure; closing the App without stopping it leaves journal rows running until the next orphan sweep.
      ...(dynamicWorkflowRunPort === undefined
        ? {}
        : { closeDynamicWorkflowRuns: () => dynamicWorkflowRunPort.close() }),
      configResult,
      configuredMcpServers,
      ...(options.configuredDefaultModelSelection
        ? {
            configuredDefaultModelSelection: options.configuredDefaultModelSelection,
          }
        : {}),
      executionPort,
      localSettingStore,
      logger,
      loggerFactory,
      mcpPort,
      ownsExecutionPort,
      ownsMcpPort,
      closeNodeReplBrowserBroker: async () => {
        await ownedNodeReplBrowserBroker?.close();
      },
      ownsSessionStore,
      prepareUserExecutionBoundary,
      prepareResume,
      projectID,
      providerRegistry: options.providerRegistry,
      resolveUiLocale: (locale) => resolveEffectiveLocale(locale, options),
      runtime,
      sessionId,
      sessionStore,
      traceContext,
      untrustedProjectMcpServers,
      workingDirectory,
    });

    const closeSession = sessionFacade.close;
    const resolvePromptAttachment = async (input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    }): Promise<{ ref: string; mediaType: string; artifactUri?: string }> => {
      let ref = input.ref;
      let mediaType = input.mime;
      let artifactUri: string | undefined;
      if (input.messageId && input.attachmentIndex !== undefined) {
        // Previewing one attachment used to decode the whole session via messages(); long sessions scanned
        // every part synchronously, and unrelated bad rows failed the target preview. Read by session/message instead.
        const persistedMessage = await sessionStore.messageWithParts({
          sessionID: sessionId,
          messageID: input.messageId as MessageId,
        });
        const persistedAttachment = persistedMessage?.parts.filter((part) => part.type === "file")[
          input.attachmentIndex
        ];
        if (persistedAttachment?.type === "file") {
          mediaType = persistedAttachment.mime;
          // A live row's ref is still the original path; reading it directly diverges hot previews from the cold-recovery artifact once the source file is
          // deleted or overwritten. The same message/index must prefer the immutable copy.
          artifactUri =
            persistedAttachment.metadata?.artifactUri ??
            (persistedAttachment.url.startsWith("zcode-artifact://")
              ? persistedAttachment.url
              : undefined);
          ref =
            artifactUri ??
            (!persistedAttachment.url.startsWith("data:") ? persistedAttachment.url : input.ref);
        }
        // The message row lands before later FileParts one by one; while the target part is not yet visible, still use the
        // input.ref already authorized by the current projection; never open a transient preview-failure window.
      }
      return { ref, mediaType, ...(artifactUri ? { artifactUri } : {}) };
    };
    return {
      sessionId,
      traceId: traceContext.traceId,
      runtime,
      respondWorkspaceHookReview: (input) =>
        workspaceHookRuntimeSecurity?.respond(
          {
            sessionId: input.sessionId,
            taskId: input.taskId,
            runId: input.runId,
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            workspaceIdentity: input.workspaceIdentity,
            bundleDigest: input.bundleDigest,
            reviewFlowId: input.reviewFlowId,
            generation: input.generation,
            interactionId: input.interactionId,
          },
          input.decision,
        ) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      toggleWorkspaceHookReviewItem: (input) =>
        workspaceHookRuntimeSecurity?.toggle(
          {
            sessionId: input.sessionId,
            taskId: input.taskId,
            runId: input.runId,
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            workspaceIdentity: input.workspaceIdentity,
            bundleDigest: input.bundleDigest,
            reviewFlowId: input.reviewFlowId,
            generation: input.generation,
            interactionId: input.interactionId,
          },
          input.reviewItemId,
          input.enabled,
        ) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      revokeWorkspaceHookTrust: (input) =>
        ("hookDeclarationDigests" in input
          ? workspaceHookRuntimeSecurity?.revokeCurrent(input)
          : workspaceHookRuntimeSecurity?.revoke(
              {
                sessionId: input.sessionId,
                taskId: input.taskId,
                runId: input.runId,
                ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
                workspaceIdentity: input.workspaceIdentity,
                bundleDigest: input.bundleDigest,
                reviewFlowId: input.reviewFlowId,
                generation: input.generation,
                interactionId: input.interactionId,
              },
              input.reviewItemIds,
            )) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      requestWorkspaceHookReview: (input) =>
        workspaceHookRuntimeSecurity?.requestReview({
          workspaceIdentity: input.workspaceIdentity,
          bundleDigest: input.bundleDigest,
        }) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      // Invoked by the server per workspace after Settings writes a pretrust: reload the trust
      // store into this session coordinator and re-emit admission state (see types.ts).
      reloadWorkspaceHookTrust: () =>
        workspaceHookRuntimeSecurity?.reloadTrust() ?? Promise.resolve(),
      setModelIoFullRetentionEnabled: (enabled) =>
        modelAdapter.setModelIoFullRetentionEnabled(enabled),
      readToolResultArtifact: (uri) =>
        artifactStore.readToolResultArtifact({ uri, trace: traceContext }),
      // wire/staging stays decoded chunks throughout; only after the full checksum commit does the
      // CLI process restore the legacy data-URL artifact shape, keeping the provider read chain compatible.
      writePromptAttachment: async (input) => {
        const artifact = await artifactStore.writeToolResultArtifact({
          content: `data:${input.mime};base64,${Buffer.from(input.bytes).toString("base64")}`,
          contentType: "text/plain",
          retention: "session",
          sessionId,
          toolCallId: `prompt-attachment-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          toolName: "prompt-attachment:upload",
          trace: traceContext,
        });
        if (
          input.mime.startsWith("image/") ||
          input.mime.startsWith("video/") ||
          input.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf"
        ) {
          // Derived media is a rebuildable cache; a real IO failure never damages the durable data URL, and the final request projection re-ensures.
          void artifactStore
            .primeMediaAttachmentPath?.({
              bytes: input.bytes,
              mediaType: input.mime,
              uri: artifact.uri,
            })
            .catch(() => undefined);
        }
        return { ref: artifact.uri };
      },
      readPromptAttachment: async (input) => {
        const { ref, mediaType } = await resolvePromptAttachment(input);
        // Reads must stay inside the session runtime: artifacts via the session store, paths via the current
        // FileSystemPort, so SSH/WSL/Docker hit the right remote filesystem.
        if (ref.startsWith("zcode-artifact://")) {
          const artifact = await artifactStore.readToolResultArtifact({
            uri: ref,
            trace: traceContext,
          });
          return decodePromptAttachmentDataUrl(artifact.content, mediaType, input.maxBytes);
        }
        const read = await fileSystemPort.readBinaryFile({
          path: ref,
          maxBytes: input.maxBytes,
          trace: traceContext,
        });
        return { bytes: read.content, mediaType };
      },
      statPromptAttachment: async (input) => {
        const { ref, mediaType, artifactUri } = await resolvePromptAttachment(input);
        if (artifactUri) {
          if (!artifactStore.statToolResultArtifact) {
            throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
          }
          const result = await artifactStore.statToolResultArtifact({
            uri: artifactUri,
            trace: traceContext,
          });
          return {
            totalBytes: result.bytes,
            mediaType: result.contentType || mediaType,
            ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
          };
        }
        const result = await fileSystemPort.stat({ path: ref, trace: traceContext });
        if (result.kind !== "file") {
          // Directory/symlink/gone each means "this attachment is no longer a shareable file": raise with a stable code
          // so the share precheck classifies deterministically instead of guessing from error text.
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statNotFile);
        }
        return {
          totalBytes: result.sizeBytes,
          mediaType,
          ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
        };
      },
      resolvePromptAttachmentPreviewSource: async (input) => {
        const resolved = await resolvePromptAttachment(input);
        if (!resolved.mediaType.startsWith("video/")) return { kind: "chunked" };
        if (resolved.artifactUri) {
          if (!artifactStore.ensureMediaAttachmentPath) return { kind: "chunked" };
          try {
            const materialized = await artifactStore.ensureMediaAttachmentPath({
              uri: resolved.artifactUri,
              mediaType: resolved.mediaType,
            });
            if (materialized.status === "ready" && materialized.path.trim()) {
              return {
                kind: "local_path",
                path: materialized.path,
                mediaType: resolved.mediaType,
              };
            }
          } catch {
            // The artifact remains the immutable fact; a derived-file failure only lets the gateway fall back to artifact chunks.
          }
          return { kind: "chunked" };
        }
        if (isAbsolute(resolved.ref)) {
          return {
            kind: "local_path",
            path: resolved.ref,
            mediaType: resolved.mediaType,
          };
        }
        return { kind: "chunked" };
      },
      ...sessionFacade,
      close: async () => {
        try {
          await closeSession?.();
        } finally {
          try {
            providerModelRuntime?.dispose();
          } finally {
            await modelTelemetry.shutdown();
          }
        }
      },
      ...workflowFacade,
      ...scriptWorkflowFacade,
      // The dwf event log read surface. An OPTIONAL capability: without the journal the whole run service is not constructed,
      // this method is absent with it, and the v4 gateway returns a structured capability-unsupported error -- "no events" vs
      // "this session lacks the capability" must be distinguishable by the renderer.
      ...(dynamicWorkflowRunPort === undefined
        ? {}
        : {
            listDynamicWorkflowRunEvents: async (input: {
              runId: string;
              afterSequence?: number;
              limit?: number;
              maxBytes?: number;
            }) =>
              dynamicWorkflowRunPort.listEvents(input.runId, {
                ...(input.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                ...(input.limit === undefined ? {} : { limit: input.limit }),
                ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
              }),
          }),
      // The workflow run's USER-FACING ARTIFACT read surface. Three registered together,
      // absent together: three slices of one journal read surface; partial presence would hand the UI a side panel with a card
      // that cannot open. All three port members are optional (stub ports skip), hence per-member probes.
      // Terminology: artifact = the output the script published to the user, NOT the port's output (top-level return value).
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.listArtifacts !== "function" ||
      typeof dynamicWorkflowRunPort.listArtifactItems !== "function" ||
      typeof dynamicWorkflowRunPort.readArtifact !== "function"
        ? {}
        : {
            listDynamicWorkflowRunArtifacts: async (input: { runId: string }) =>
              dynamicWorkflowRunPort.listArtifacts!(input.runId),
            listDynamicWorkflowRunArtifactItems: async (input: {
              runId: string;
              artifactId: string;
              afterSequence?: number;
              limit: number;
              maxBytes: number;
              fields?: readonly string[];
            }) =>
              dynamicWorkflowRunPort.listArtifactItems!(input.runId, input.artifactId, {
                ...(input.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                limit: input.limit,
                maxBytes: input.maxBytes,
                ...(input.fields === undefined ? {} : { fields: input.fields }),
              }),
            readDynamicWorkflowRunArtifact: async (input: {
              runId: string;
              artifactId: string;
              version: number;
            }) =>
              dynamicWorkflowRunPort.readArtifact!(input.runId, input.artifactId, input.version),
          }),
      // Workspace transcript of a workflow run: the two register and vanish together, same reason
      // as the artifact trio.
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.listWorkspaceNodes !== "function" ||
      typeof dynamicWorkflowRunPort.readWorkspaceNodeResult !== "function"
        ? {}
        : {
            listDynamicWorkflowRunWorkspaceNodes: async (input: { runId: string }) =>
              dynamicWorkflowRunPort.listWorkspaceNodes!(input.runId),
            readDynamicWorkflowRunNodeResult: async (input: {
              runId: string;
              siteId: string;
              ordinal: number;
              maxBytes: number;
            }) =>
              dynamicWorkflowRunPort.readWorkspaceNodeResult!(
                input.runId,
                input.siteId,
                input.ordinal,
                { maxBytes: input.maxBytes },
              ),
          }),
      // A dwf run's session-level lifecycle read surface (in-flight count + settlement subscription). Consumer: the host provider registry's
      // safety boundary: subagents share this session's live adapter; replacing the registry during an in-flight run would dispose
      // their bound per-request resources. Absence condition as above.
      ...(dynamicWorkflowRunPort === undefined ? {} : {}),
      // The dwf run enumeration surface (post-restart discovery). Same absence condition; the port's listRunsForSession
      // is an optional member -- without the method, this capability is not registered either.
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.listRunsForSession !== "function"
        ? {}
        : {
            listDynamicWorkflowRuns: async (input: { limit?: number }) =>
              dynamicWorkflowRunPort.listRunsForSession!(input.limit),
          }),
      // Cold replay of workflow runs. Absence condition as above.
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.replayProgressForSession !== "function"
        ? {}
        : {
            replayDynamicWorkflowRuns: async (input: { excludeRunIds: ReadonlySet<string> }) =>
              dynamicWorkflowRunPort.replayProgressForSession!(input),
          }),
      // Resuming a dwf run. Absence condition as above; additionally the port resume is an
      // optional member (stub ports skip it) and the capability is not registered when the method
      // is missing - to the renderer, port-absent and method-absent are the same business fact.
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.resume !== "function"
        ? {}
        : {
            resumeWorkflowRun: async (input: { workId: string; name?: string }) => {
              const result = await dynamicWorkflowRunPort.resume!(input.workId);
              if (result.ok) {
                // Re-arming the tracker must follow a successful resume immediately: registry entry (reclaim guard), backgroundWorks
                // entry (cancellable), terminal notification. port.resume has already replaced the registry entry,
                // so the waiter hangs on the new settlement promise (run service header, invariant 5).
                await getRuntime().trackResumedDynamicWorkflowRun({
                  runId: result.runId,
                  ...(result.toolCallId === undefined ? {} : { toolCallId: result.toolCallId }),
                  ...(input.name === undefined ? {} : { name: input.name }),
                  traceContext,
                });
              }
              return result;
            },
          }),
      // The hub directly launching a saved workflow. Same capability-absence rule as the
      // resumeWorkflowRun family: with the whole dwf port absent (stub/unit-test hosts) do not register -- the GUI gets
      // capability-unsupported and shows it as-is, instead of misreading "direct launch unsupported" as a failed launch.
      // Isomorphic to the /goal control turn: first the unified user-execution boundary (else shell selection is empty before the first
      // persistence and cold recovery falls back to legacy), then runtime resolve + validate + compile + launch turn + submit.
      ...(dynamicWorkflowRunPort === undefined
        ? {}
        : {
            startSavedWorkflow: async (input: {
              name: string;
              scope?: "project" | "global";
              args?: Record<string, unknown>;
            }) => {
              await prepareUserExecutionBoundary({ traceContext });
              return await getRuntime().startSavedWorkflowRun({ ...input, traceContext });
            },
          }),
      // The GUI "configure". It
      // reuses the predecessor's script, so the port must amend AND read the script back; lacking either, do not register -- the GUI gets capability-unsupported.
      // Same user-execution boundary as startSavedWorkflow: a cold-recovered session restores the Session boundary before the settings turn lands.
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.amend !== "function" ||
      typeof dynamicWorkflowRunPort.getScript !== "function"
        ? {}
        : {
            amendWorkflowRunSettings: async (
              input: Omit<AmendWorkflowRunSettingsInput, "traceContext">,
            ) => {
              await prepareUserExecutionBoundary({ traceContext });
              return await getRuntime().amendWorkflowRunSettings({ ...input, traceContext });
            },
          }),
      ...createPluginFacadeForApp({ configResult, options, workingDirectory }),
      getPluginReferenceCatalog: () => pluginReferenceCatalog,
      getSkillCatalog: async () => {
        // The skill catalog belongs to context-init results. Cold recovery must restore the Session boundary first, then read
        // the NEW runtime's snapshot; never scan independently with the old cwd after resume.
        await prepareUserExecutionBoundary({ traceContext });
        return await getRuntime().getSkillCatalog(traceContext);
      },
      resume: resumeFromStore,
      ...inputFacade,
    };
  } catch (error) {
    providerModelRuntime?.dispose();
    void modelTelemetry.shutdown().catch(() => undefined);
    void ownedNodeReplBrowserBroker?.close();
    startupTimer.fail("ZCode app startup failed", error, {
      context: { sessionId, workingDirectory },
      event: "bootstrap.app.startup.failed",
      stage: "total",
    });
    throw error;
  }
}
