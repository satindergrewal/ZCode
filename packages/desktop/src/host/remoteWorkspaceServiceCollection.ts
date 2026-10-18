/* eslint-disable max-lines -- remote workspace service registration stays central to preserve injection order */
import {
  ServiceCollection,
  IFileService,
  IMediaPreviewService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  IOnboardingRecordService,
  ICredentialService,
  IBroadcastService,
  IZCodeTaskService,
  IZCodeAgentService,
  IZCodeSessionService,
  IConversationShareService,
  createUnsupportedConversationShareService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IModelSelectionService,
  IProviderSettingsService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  IOutputStyleService,
  ISettingsSyncService,
  IPromptAttachmentTransferService,
  type IServiceAccessor,
} from "@zcode/services";
import {
  ConversationShareHttpClient,
  ConversationShareService,
  createSettingService,
  createCredentialService,
  createBroadcastService,
  createNodeApiClient,
  createHostApiNetworkTransport,
  registerHostApiNetworkTransportForDispose,
  createOAuthService,
  createOAuthProviderLogoutHandler,
  createAccountProviderCredentialStore,
  createAccountProviderCredentialService,
  createAccountProjectTokenClient,
  getAccountRequestAuthService,
  createAccountProviderRequestAuthService,
  createAccountRequestAuthService,
  resolveCurrentAccountAccess,
  resolveAccountTeamPlanRuntimeMaterial,
  createSettingsSyncService,
  createBotsService,
  createUsageStatsService,
  createMediaPreviewService,
  createCodingPlanSubscriptionService,
  createClientScenesService,
  createServiceLogger,
  createSubagentsService,
  createMemoryService,
  createOutputStyleService,
  createRemoteConversationShareArtifactSource,
  OAuthCredentialRepo,
} from "@zcode/services/node";
import {
  BIGMODEL_PROVIDER_ID,
  buildRuntimeZCodeApiUrl,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  type ProviderFamilyDomain,
  resolveBigModelApiOrigin,
  resolveZaiBusinessBaseUrl,
  type ZCodeSessionRuntimePreferencesResult,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { assertLegacyRemoteWorkspaceRpcContract } from "./legacyRemoteWorkspaceRpcContract.js";
import {
  createRemoteProviderProvisioningExecutorFromWorkspace,
  registerRemoteProviderProvisioningExecutor,
} from "./remoteProviderProvisioningService.js";

const runtimePreferencesLogger = createServiceLogger("remote-runtime-preferences");
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const conversationShareLog = createServiceLogger("conversation-share");

function createUnsupportedRemoteConversationShareService(): IConversationShareService {
  return createUnsupportedConversationShareService({
    message: "Conversation sharing is not available for this client or remote target",
    onRejected: (action) => {
      conversationShareLog.warn(undefined, "conversation share action rejected", {
        action,
        kind: "feature_disabled",
        reason: "server_remote_unsupported",
      });
    },
  });
}

export function createRemoteWorkspaceServiceCollection(params: {
  clientConfigService: IClientConfigService;
  connectionServices: IServiceAccessor;
  sourceServices?: ServiceCollection;
  localOnboardingRecordService: IOnboardingRecordService;
  parentPort: Parameters<typeof createBroadcastService>[0];
  createReportingRemoteZCodeTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentSessionService: <T extends object>(service: T) => T;
  promptAttachmentTransferService: IPromptAttachmentTransferService;
  runtimePreferencesBridge: {
    onError: (error: unknown) => void;
  };
}): ServiceCollection {
  assertLegacyRemoteWorkspaceRpcContract(params.connectionServices);
  const localSettingService = createSettingService();
  let fallbackTokenClient: ReturnType<typeof createAccountProjectTokenClient> | undefined;
  const localCredentialService = createCredentialService({
    onDidMutate: ({ key }) => {
      if (key.startsWith("oauth:") || key === ZCODE_JWT_TOKEN_KEY) fallbackTokenClient?.clear();
    },
  });
  const localAccountProviderCredentialStore = createAccountProviderCredentialStore({
    credentialService: localCredentialService,
  });
  const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
    const settings = await localSettingService.get();
    return {
      httpProxy: settings.httpProxy,
      noProxy: settings.httpProxyNoProxy,
      caCertPath: settings.httpProxyCaCertPath,
    };
  });
  const localApiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
  });
  const localBroadcastService = createBroadcastService(params.parentPort);
  let handleOAuthProviderLogout: ReturnType<typeof createOAuthProviderLogoutHandler> | null = null;
  const localOAuthCredentialRepo = new OAuthCredentialRepo(localCredentialService, {
    onCorruptOAuthSessionCleared: async (providers) => {
      // The remote workspace host reads and writes this machine's OAuth credentials.
      // Corruption recovery must clear Start/Coding Plan derived providers like the local host, so the phone remote keeps no stale key.
      await Promise.all(
        providers.map((provider) => handleOAuthProviderLogout?.(provider) ?? Promise.resolve()),
      );
    },
  });
  const readLocalAccountProviderSettings = async () => {
    const settings = await localSettingService.get();
    return {
      providerFamilyDomain: settings.providerFamilyDomain ?? null,
      selections: settings.providerFamilyConnectionSelections ?? {},
    };
  };
  const loadLocalAccountIdentity = async (family: ProviderFamilyDomain) => {
    const providerId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
    return (await localOAuthCredentialRepo.loadUserProfile(providerId))?.id ?? null;
  };
  const localAccountRequestAuthService =
    (params.sourceServices ? getAccountRequestAuthService(params.sourceServices) : undefined) ??
    (() => {
      // The old implementation read only the on-disk key and resolved nothing; after migration, reuse the proper owner or re-credential at this boundary.
      const tokenClient = createAccountProjectTokenClient(localApiClient, localCredentialService);
      fallbackTokenClient = tokenClient;
      // 401 recovery must thread the failed PAT fingerprint through the personal/team callbacks, or the cache keeps returning rejected credentials.
      const credentialResolver = createAccountProviderCredentialService({
        async loadOAuthAccessToken(family) {
          const providerId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
          return (await localOAuthCredentialRepo.loadTokenSet(providerId))?.accessToken ?? null;
        },
        async resolveProviderMaterial(
          family,
          loginToken,
          accountIdentity,
          rejectedProjectTokenFingerprint,
        ) {
          const result = await tokenClient.resolve({
            origin:
              family === "zai"
                ? resolveZaiBusinessBaseUrl(process.env)
                : resolveBigModelApiOrigin(process.env),
            family,
            loginToken,
            accountId: accountIdentity,
            rejectedProjectTokenFingerprint,
          });
          return result;
        },
      });
      return createAccountRequestAuthService(
        createAccountProviderRequestAuthService({
          resolveCurrentAccountAccess: (access) =>
            resolveCurrentAccountAccess({
              access,
              readSettings: readLocalAccountProviderSettings,
              loadAccountIdentity: loadLocalAccountIdentity,
            }),
          loadOAuthTokenSet: (providerId) => localOAuthCredentialRepo.loadTokenSet(providerId),
          async loadIndividualPlanMaterial(providerId, family, rejectedProjectTokenFingerprint) {
            const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
            const accountIdentity = (
              await localOAuthCredentialRepo.loadUserProfile(oauthProviderId)
            )?.id;
            if (!accountIdentity) return null;
            return credentialResolver.loadCodingPlanMaterial({
              providerId,
              family,
              accountIdentity,
              rejectedProjectTokenFingerprint,
            });
          },
          resolveTeamPlanMaterial: async (access, rejectedProjectTokenFingerprint) => {
            const accountIdentity = await loadLocalAccountIdentity(access.family);
            if (!accountIdentity) return null;
            return resolveAccountTeamPlanRuntimeMaterial({
              apiClient: localApiClient,
              credentialService: localCredentialService,
              accountIdentity,
              tokenClient,
              access,
              rejectedProjectTokenFingerprint,
            });
          },
        }),
      );
    })();
  const localCodingPlanSubscriptionService = createCodingPlanSubscriptionService({
    apiClient: localApiClient,
    credentialService: localCredentialService,
  });
  handleOAuthProviderLogout = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore: localAccountProviderCredentialStore,
  });
  const conversationShareClient = new ConversationShareHttpClient({
    // Sharing from a remote workspace must use the real API; the local mock is unit-test-only and generates no cross-process links.
    apiClient: localApiClient,
    baseUrl: buildRuntimeZCodeApiUrl(process.env, "/api/v1"),
    tokenProvider: async () =>
      (await localCredentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() || null,
  });
  const conversationShareService = new ConversationShareService({
    zcodeAgentService: params.connectionServices.zcodeAgentService,
    client: conversationShareClient,
    artifactSource: createRemoteConversationShareArtifactSource(
      params.connectionServices.fileService,
    ),
  });
  const reportingRemoteZCodeTaskService = params.createReportingRemoteZCodeTaskService(
    params.connectionServices.zcodeTaskService,
  );
  // The phone remote's replayable mirror publishes user messages inside the reporting wrapper;
  // attachment materialization must wrap reporting so the mirror and the prompt sent to the remote agent use the same remote path.
  const remoteZCodeTaskService = params.createRemotePromptAttachmentTaskService(
    reportingRemoteZCodeTaskService,
  );
  const remoteZCodeSessionService = params.createRemotePromptAttachmentSessionService(
    params.connectionServices.zcodeSessionService,
  );
  const remoteProviderProvisioningService =
    createRemoteProviderProvisioningExecutorFromWorkspace(params);

  // A desktop-attached remote runs its Agent remotely, but app-global settings authority stays with
  // the desktop shared Host. The narrowed runtime-preferences request round-trips there; the remote never reads its own settings.
  const { onError } = params.runtimePreferencesBridge;
  params.connectionServices.zcodeAgentService.onDynamicSessionRuntimePreferencesRequest()(
    (request) => {
      const startedAt = Date.now();
      const requestContext = {
        event: "zcode_protocol.runtime_preferences.host_request_received",
        module: "desktop.host.remote_workspace",
        requestId: request.requestId,
        scope: request.scope,
        sessionId: request.sessionId,
      };
      // Diagnostics: an Agent-side timeout only means no response; record whether the Host got the request
      // and use got-request-no-response to distinguish transport loss from a stuck settings read.
      runtimePreferencesLogger.info(
        undefined,
        "runtime preferences host request received",
        requestContext,
      );
      void (async () => {
        const trackStage = <T>(stage: string, promise: Promise<T>): Promise<T> => {
          const stageStartedAt = Date.now();
          return promise.then(
            (value) => {
              runtimePreferencesLogger.debug(
                undefined,
                "runtime preferences host stage completed",
                {
                  ...requestContext,
                  durationMs: Math.max(0, Date.now() - stageStartedAt),
                  stage,
                },
              );
              return value;
            },
            (error: unknown) => {
              runtimePreferencesLogger.warn(undefined, "runtime preferences host stage failed", {
                ...requestContext,
                durationMs: Math.max(0, Date.now() - stageStartedAt),
                error: error instanceof Error ? error.message : String(error),
                stage,
              });
              throw error;
            },
          );
        };
        let resolution:
          | { status: "resolved"; preferences: ZCodeSessionRuntimePreferencesResult }
          | { status: "failed"; message: string };
        try {
          // Same origin as the local Host: the fixed budget bypasses the config gateway so remote/phone preference reads never serialize on the network.
          const settings = await trackStage("settings", localSettingService.get());
          const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
          resolution = {
            status: "resolved",
            preferences: {
              askUserQuestionAutoResolutionEnabled:
                settings.askUserQuestionAutoResolutionEnabled !== false,
              nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
              memoryEnabled: settings.memoryEnabled === true,
              modelContextBudgetStrategy,
              // Keep the same scope boundary as the local Host; the first execution must not wait on client config again.
              ...(request.scope === "user-execution" && settings.integratedTerminalShell
                ? { integratedTerminalShell: settings.integratedTerminalShell }
                : {}),
            },
          };
        } catch (error) {
          resolution = {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          };
          runtimePreferencesLogger.warn(undefined, "runtime preferences host resolution failed", {
            ...requestContext,
            durationMs: Math.max(0, Date.now() - startedAt),
            error: resolution.message,
          });
        }
        // Encode only settings-read failures as -32603; send failures go to the final onError and must not retry the same request.
        await params.connectionServices.zcodeAgentService.respondSessionRuntimePreferences({
          requestId: request.requestId,
          resolution,
        });
        runtimePreferencesLogger.info(undefined, "runtime preferences host response sent", {
          ...requestContext,
          durationMs: Math.max(0, Date.now() - startedAt),
          resolutionStatus: resolution.status,
        });
      })().catch((error: unknown) => {
        runtimePreferencesLogger.warn(undefined, "runtime preferences host response failed", {
          ...requestContext,
          durationMs: Math.max(0, Date.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        });
        onError(error);
      });
    },
  );

  // The web phone remote entering an SSH task connects only to the remote workspace host,
  // without the desktop renderer's baseServices + remoteServices merge.
  // So layer local global channels onto the remote workspace host here; files, terminal, and the ZCode Agent still come from the remote,
  // while settings, credentials, OAuth, model providers, and settings-sync keep reading and writing local config.
  const services = new ServiceCollection()
    .register(IFileService, params.connectionServices.fileService)
    .register(IGitService, params.connectionServices.gitService)
    .register(IGitCheckpointService, params.connectionServices.gitCheckpointService)
    .register(ISystemService, params.connectionServices.systemService)
    .register(ITerminalService, params.connectionServices.terminalService)
    .register(ISettingService, localSettingService)
    // After the phone rebuilds the remote root, a missing channel here popped onboarding wrongly; reuse the Local Host owner so records and login state share one source.
    .register(IOnboardingRecordService, params.localOnboardingRecordService)
    .register(ICredentialService, localCredentialService)
    .register(IBroadcastService, localBroadcastService)
    .register(IZCodeTaskService, remoteZCodeTaskService)
    .register(IZCodeAgentService, params.connectionServices.zcodeAgentService)
    .register(IZCodeSessionService, remoteZCodeSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(
      IBotsService,
      createBotsService({
        credentialService: localCredentialService,
        zcodeTaskService: remoteZCodeTaskService,
        broadcastService: localBroadcastService,
        settingService: localSettingService,
        modelSelectionService: params.connectionServices.modelSelectionService,
        // Bugfix: the remote workspace host's first paint needs only remote file/agent capabilities;
        // a bot background task polling or calling getAll immediately would re-pull local presets and stretch SSH/Docker connect time.
        runStartupBackgroundTasks: false,
      }),
    )
    .register(IFileWatcherService, params.connectionServices.fileWatcherService)
    .register(
      IOAuthService,
      createOAuthService(localCredentialService, {
        apiClient: localApiClient,
        onProviderLogout: handleOAuthProviderLogout,
      }),
    )
    // Provider/Model facts belong to the target Environment. Remote workspace pickers and settings views
    // must read the remote Registry directly, never the desktop-local providers.
    .register(IModelSelectionService, params.connectionServices.modelSelectionService)
    .register(IProviderSettingsService, params.connectionServices.providerSettingsService)
    .register(
      IUsageStatsService,
      createUsageStatsService({
        apiClient: localApiClient,
        accountRequestAuthService: localAccountRequestAuthService,
        credentialService: localCredentialService,
        zcodeAgentService: params.connectionServices.zcodeAgentService,
      }),
    )
    .register(ICodingPlanSubscriptionService, localCodingPlanSubscriptionService)
    .register(IClientConfigService, params.clientConfigService)
    .register(IClientScenesService, createClientScenesService({ apiClient: localApiClient }))
    // A remote workspace's project-level skills/plugins/commands live on the SSH/Docker filesystem.
    // Expose the remote services here so local services never scan remote workspacePaths against local dirs.
    .register(ISkillsService, params.connectionServices.skillsService)
    .register(ISkillSyncService, params.connectionServices.skillSyncService)
    .register(IMcpSyncService, params.connectionServices.mcpSyncService)
    .register(IPluginSyncService, params.connectionServices.pluginSyncService)
    .register(IPluginsService, params.connectionServices.pluginsService)
    // Plugin management in remote settings must hit the remote agent too (plugin dirs live on the remote filesystem).
    .register(IPluginManagementService, params.connectionServices.pluginManagementService)
    .register(ICommandsService, params.connectionServices.commandsService)
    .register(ISubagentsService, createSubagentsService({ isDesktopRuntime: true }))
    .register(IHooksService, params.connectionServices.hooksService)
    .register(IMemoryService, createMemoryService())
    .register(IOutputStyleService, createOutputStyleService())
    .register(
      ISettingsSyncService,
      createSettingsSyncService({ settingService: localSettingService }),
    )
    .register(IPromptAttachmentTransferService, params.promptAttachmentTransferService);
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);
  registerRemoteProviderProvisioningExecutor(services, remoteProviderProvisioningService);
  return services;
}

export function createServerRemoteWorkspaceServiceCollection(params: {
  clientConfigService: IClientConfigService;
  connectionServices: IServiceAccessor;
  sourceServices?: ServiceCollection;
}): ServiceCollection {
  assertLegacyRemoteWorkspaceRpcContract(params.connectionServices);
  // A server-remote connection attaches to an already-running full ZCode server.
  // The Host only relays RPC; it never decides workspace/runtime/model-provider ownership for the server.
  const remoteProviderProvisioningService =
    createRemoteProviderProvisioningExecutorFromWorkspace(params);
  const services = new ServiceCollection()
    .register(IFileService, params.connectionServices.fileService)
    .register(
      IMediaPreviewService,
      params.connectionServices.mediaPreviewService ??
        createMediaPreviewService({ fileService: params.connectionServices.fileService }),
    )
    .register(IGitService, params.connectionServices.gitService)
    .register(IGitCheckpointService, params.connectionServices.gitCheckpointService)
    .register(ISystemService, params.connectionServices.systemService)
    .register(ITerminalService, params.connectionServices.terminalService)
    .register(ISettingService, params.connectionServices.settingService)
    .register(ICredentialService, params.connectionServices.credentialService)
    .register(IBroadcastService, params.connectionServices.broadcastService)
    .register(IZCodeTaskService, params.connectionServices.zcodeTaskService)
    .register(IZCodeAgentService, params.connectionServices.zcodeAgentService)
    .register(IZCodeSessionService, params.connectionServices.zcodeSessionService)
    .register(IConversationShareService, createUnsupportedRemoteConversationShareService())
    .register(IBotsService, params.connectionServices.botsService)
    .register(IFileWatcherService, params.connectionServices.fileWatcherService)
    .register(IOAuthService, params.connectionServices.oauthService)
    .register(IModelSelectionService, params.connectionServices.modelSelectionService)
    .register(IProviderSettingsService, params.connectionServices.providerSettingsService)
    .register(IUsageStatsService, params.connectionServices.usageStatsService)
    .register(
      ICodingPlanSubscriptionService,
      params.connectionServices.codingPlanSubscriptionService,
    )
    .register(IClientConfigService, params.clientConfigService)
    .register(IClientScenesService, params.connectionServices.clientScenesService)
    .register(ISkillsService, params.connectionServices.skillsService)
    .register(ISkillSyncService, params.connectionServices.skillSyncService)
    .register(IMcpSyncService, params.connectionServices.mcpSyncService)
    .register(IPluginsService, params.connectionServices.pluginsService)
    .register(IPluginManagementService, params.connectionServices.pluginManagementService)
    .register(ISubagentsService, params.connectionServices.subagentsService)
    .register(ICommandsService, params.connectionServices.commandsService)
    .register(IHooksService, params.connectionServices.hooksService)
    .register(IMemoryService, params.connectionServices.memoryService)
    .register(IOutputStyleService, params.connectionServices.outputStyleService)
    .register(ISettingsSyncService, params.connectionServices.settingsSyncService)
    .register(
      IPromptAttachmentTransferService,
      params.connectionServices.promptAttachmentTransferService,
    );
  // Settings and OAuth belong to the server; onboarding records must pass through the same
  // service, never borrowing desktop records. Keep the accessor's optional-capability contract;
  // RemoteServiceAccess provides this proxy.
  if (params.connectionServices.onboardingRecordService) {
    services.register(IOnboardingRecordService, params.connectionServices.onboardingRecordService);
  }
  registerRemoteProviderProvisioningExecutor(services, remoteProviderProvisioningService);
  return services;
}
