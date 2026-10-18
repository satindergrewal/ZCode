import { IGenUiService } from "./gen-ui/contract.js";
import { createGenUiService } from "./gen-ui/node.js";
import { channelReplyHostRequestSchema, channelReplyResultSchema } from "@zcode/shared";
/* eslint-disable max-lines -- host service registration and startup wiring stay together; splitting hides DI order */
// Node.js service implementations — NOT safe to import in browser code
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createNodeProviderRuntimePathEnv,
  NodeModelSelectionConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import { getAppConfigDir as resolveAppConfigDir } from "./paths.js";
import {
  buildLocalMediaPreviewUrl,
  type DynamicWorkflowMode,
  type ProviderProvisioningTrigger,
} from "@zcode/shared";

export {
  materializeZCodeBuiltinProviderConfig,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { randomUUID } from "node:crypto";
import { getAppConfigDir as getContentAppConfigDir } from "#src/paths.js";
import { ICloudContentService } from "#src/cloud-content/cloudContent.js";
import { createCloudContentService } from "#src/cloud-content/cloudContentService.js";
import { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";
import { createMarketingTouchService } from "#src/marketing-touch/marketingTouchService.js";
import { createMarketingAssetRegistry } from "#src/marketing-touch/marketingAssetRegistry.js";
import type { IChannel } from "@zcode/rpc";
import {
  readTopicResourceFromRelay,
  validateTopicResourceFromRelay,
} from "./zcode-agent/topicResourceRelayClient.js";
export {
  createTopicResourcePeers,
  type TopicResourcePeers,
} from "./zcode-agent/topicResourcePeers.js";
export { createTopicResourceRelayChannel } from "./zcode-agent/topicResourceRelayChannel.js";

export { createFileService } from "./file/fileService.js";
export {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type HostResourceUsageAgent,
  type ProcessResourceSample,
  type ProcessResourceSampler,
} from "./process/processResourceSampler.js";
export { createMediaPreviewService } from "./media-preview/mediaPreview.js";
export { createContentBundleCache } from "#src/cloud-content/contentBundleCache.js";
export type { ContentBundle } from "#src/cloud-content/contentBundleCache.js";
export type { CreateFileServiceOptions } from "./file/fileService.js";
export {
  defaultWorkspaceFileSearchFilter,
  type WorkspaceFileSearchDecision,
  type WorkspaceFileSearchEntry,
  type WorkspaceFileSearchFilter,
} from "./file/workspaceFileMentionFilter.js";
export {
  createFsFaultInjector,
  getProcessFsFaultInjector,
  maybeThrowInjectedFsFault,
  parseFsFaultRulesFromEnvValue,
  resetProcessFsFaultInjectorForTests,
  setFsFaultInjectorForTests,
  ZCODE_E2E_FS_FAULTS_ALLOW_ENV,
  ZCODE_E2E_FS_FAULTS_ENV,
} from "./fs/fsFaultInjection.js";
export type {
  FsFaultCheckInput,
  FsFaultHit,
  FsFaultInjector,
  FsFaultOperation,
  FsFaultRuleConfig,
  InjectedFsFaultError,
} from "./fs/fsFaultInjection.js";
export {
  setDataBaseDir,
  getDataBaseDir,
  getZCodeDataRootDir,
  getConversationWorkspaceDir,
  getAppConfigDir,
  getExportLogStageDir,
  getExportLogDir,
  getFeedbackRootDir,
  getFeedbackAttachmentDir,
  getFeedbackLogArchiveDir,
  getGitCheckpointIndexRootDir,
  copyDataDirectory,
  validateDataBaseDirTarget,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "./paths.js";
export { createGitService } from "./git/gitService.js";
export { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
export { createGitCheckpointService } from "./git/gitCheckpointService.js";
export { createSystemService } from "./system/systemService.js";
export { listSSHConfigAliasesFromLocalConfig } from "./system/sshConfigAlias.js";
export { createTerminalService } from "./terminal/terminalService.js";
export {
  createSettingService,
  createSettingServiceWithMigrations,
} from "./setting/settingService.js";
export { createCredentialService } from "./credential/credentialService.js";
export { createBroadcastService } from "./broadcast/broadcastService.js";
export { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
export { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
export { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
export {
  resolveDefaultZCodeAgentCommand,
  ZCodeAgentProcessManager,
} from "./zcode-agent/zcodeAgentProcessManager.js";
export type {
  ZCodeAgentCommand,
  ZCodeAgentCommandResolver,
  ZCodeAgentCommandResolverContext,
  ZCodeAgentProcessManagerOptions,
} from "./zcode-agent/zcodeAgentProcessManager.js";
export { ZCodeProtocolClient } from "./zcode-agent/zcodeProtocolClient.js";
export type { ZCodeProtocolTransport } from "./zcode-agent/zcodeProtocolTransport.js";
export { ZCodeStdioTransport } from "./zcode-agent/zcodeStdioTransport.js";
export {
  getZCodeStdioTapDevLogDir,
  readZCodeStdioTapDevState,
  setZCodeStdioTapDevEnabled,
} from "./zcode-agent/zcodeStdioTapDevConfig.js";
export type { ZCodeStdioTapDevState } from "@zcode/shared";
export {
  createCuaHelperInstaller,
  requestHelperAccessibilityPermissionViaLaunchServices,
  requestHelperScreenRecordingPermissionViaLaunchServices,
} from "./cua-permission-broker/index.js";
export {
  canonicalizeCuaHelperInstallerOptions,
  createCanonicalCuaHelperInstaller,
  normalizeCuaHelperArch,
  normalizeCuaHelperArchs,
} from "./cua-permission-broker/cuaHelperInstaller.js";
export type {
  CuaHelperInstaller,
  CuaHelperInstallerOptions,
} from "./cua-permission-broker/index.js";
export { createBotsService } from "./bots/botsService.js";
export { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
export { createOAuthService } from "./oauth/oauthService.js";
export { createOAuthProviderLogoutHandler } from "./oauth/oauthProviderLogout.js";
export { OAuthCredentialRepo } from "./oauth/repo/oauthCredentialRepo.js";
export { createTelemetryCore, ensureTelemetryDeviceMid } from "./telemetry/telemetryCore.js";
export type { EnsureTelemetryDeviceMidOptions } from "./telemetry/telemetryCore.js";
export type { AccountRequestAuthResolver } from "./model-provider/accountProviderRequestAuthService.js";
export { createAccountProviderCredentialStore } from "./model-provider/accountProviderCredentialStore.js";
export type {
  AccountProviderCredentialStore,
  AccountProviderCredentialStoreOptions,
} from "./model-provider/accountProviderCredentialStore.js";
export { importLegacyPersonalProviderConfig } from "./model-provider/legacyPersonalProviderConfigImporter.js";
export {
  createAccountProviderConfigSource,
  createAccountProviderConnectionResolver,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "./model-provider/accountProviderConnectionResolver.js";
export { bindAccountProviderInvalidation } from "./model-provider/accountProviderInvalidation.js";
export type {
  AccountProviderConfigSourceOptions,
  AccountProviderConnectionResolverOptions,
  AccountProviderConnectionSettings,
  AccountProviderFamilyAvailabilityInput,
  AccountProviderFamilyAvailabilityResolver,
  CodingPlanFamilyAvailabilityResolverOptions,
} from "./model-provider/accountProviderConnectionResolver.js";
export {
  createProviderConfigRuntime,
  ProviderConfigRuntime,
} from "./model-provider/providerConfigRuntime.js";
export type { ProviderConfigRuntimeOptions } from "./model-provider/providerConfigRuntime.js";
export {
  createProviderRuntime,
  createProviderRuntimeFromConfigRuntime,
  EmptyAccountProviderConfigSource,
  ProviderRuntime,
} from "./model-provider/providerRuntime.js";
export type {
  ProviderRuntimeDependencies,
  ProviderRuntimeOptions,
} from "./model-provider/providerRuntime.js";
export {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
  type ProviderProvisioningSourceOptions,
} from "./model-provider/providerProvisioningSource.js";
export {
  createProviderProvisioningTarget,
  type ProviderProvisioningTargetOptions,
} from "./model-provider/providerProvisioningTarget.js";
export {
  createModelSelectionService,
  createProviderSettingsService,
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
export { createAccountRequestAuthService } from "./model-provider/accountRequestAuthService.js";
export type { IAccountRequestAuthService } from "./model-provider/accountRequestAuthService.js";
export { createAccountProviderRequestAuthService } from "./model-provider/accountProviderRequestAuthService.js";
export {
  resolveAccountTeamPlanRuntimeApiKey,
  resolveAccountTeamPlanRuntimeMaterial,
} from "./model-provider/accountProviderTeamPlanRequestKey.js";
export { createAccountProjectTokenClient } from "./model-provider/accountProjectTokenClient.js";
export { createAccountProviderCredentialService } from "./model-provider/accountProviderCredentialService.js";
export { createUsageStatsService } from "./usage-stats/usageStatsService.js";
// Storage: service and adapters factories; the desktop host assembles them (Worker runner lives in the desktop package)
export { createStorageService } from "./storage/app/storageService.js";
export type {
  FsCleanerPort as StorageFsCleanerPort,
  RootsResolverPort as StorageRootsResolverPort,
  ScanRunnerPort as StorageScanRunnerPort,
  StorageScanProgress,
  StorageScanRunRequest,
} from "./storage/app/ports.js";
export { createFsStorageCleaner } from "./storage/adapters/fsCleaner.js";
export {
  createStorageRootsResolver,
  resolveStorageRoots,
} from "./storage/adapters/rootsResolver.js";
export { createFsVolumeProbe } from "./storage/adapters/volumeProbe.js";
export { runStorageScan } from "./storage/adapters/inProcessScanRunner.js";
export { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
export { createClientConfigService } from "./client-config/clientConfigService.js";
export { createClientScenesService } from "./client-scenes/clientScenesService.js";
export { createSkillsService } from "./skills/skillsService.js";
export { createSkillSyncService } from "./skill-sync/skillSyncService.js";
export { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
export { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
export { createPluginsService } from "./plugins/pluginsService.js";
export { createPluginManagementService } from "./plugins/pluginManagementService.js";
export { createSubagentsService } from "./subagents/subagentsService.js";
export { createCommandsService } from "./commands/commandsService.js";
export { createHooksService } from "./hooks/hooksService.js";
export { createMemoryService } from "./memory/memoryService.js";
export { createOutputStyleService } from "./output-style/outputStyleService.js";
export { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
export { createFeedbackDiagnosticArchive } from "./feedback/feedbackLogArchive.js";
export { createFeedbackService } from "./feedback/feedbackService.js";
export type { CreateFeedbackServiceOptions } from "./feedback/feedbackService.js";
export { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
export {
  createLocalConversationShareArtifactSource,
  createRemoteConversationShareArtifactSource,
} from "./conversation-share/conversationShareArtifactSource.js";
export { createNodeApiClient, NodeApiClient } from "./providers/api/nodeApiClient.js";
export {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
export {
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  normalizeRuntimeProcessEnv,
  prepareRuntimeProcessEnvPatch,
} from "./runtime-tools/runtimeCommandEnv.js";

// Scheduled tasks share the node-only store and cron semantics with the scheduler.
export {
  AutomationRepo,
  DISPATCH_RETRY_BASE_MS,
  DISPATCH_RETRY_CAP_MS,
  DISPATCH_MAX_ATTEMPTS,
  CLAIM_STALE_MS,
  computeRetryAt,
} from "./session/automationRepo.js";
export { AutomationService, InvalidCronExprError } from "./session/automationService.js";
// Off-peak tasks share the database with automation in different tables; types and constants are independent.
export { OffPeakTaskRepo, OFF_PEAK_CLAIM_STALE_MS } from "./session/offPeakTaskRepo.js";
// Host-side terminal backfill of files_changed reuses the task diff summarizer.
export { buildTaskChangeSummary } from "./session/taskChangeSummary.js";
export { OffPeakTaskService } from "./session/offPeakTaskService.js";
export { IOffPeakTaskService } from "./session/offPeakTask.js";
export { IHighspeedCardService } from "./highspeed/highspeedCard.js";
export { createOffPeakServerClient, OffPeakServerError } from "./session/offPeakServerClient.js";
export { isOffPeakMockEnabled, startOffPeakMockGateway } from "./session/offPeakMockGateway.js";
export {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCredentials,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakMockUpstream,
  OffPeakCodingPlanUnavailableError,
  OffPeakCredentialsUnavailableError,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
} from "./session/offPeakRuntimeModel.js";
export { createServiceLogger } from "./logger/serviceLogger.js";
export {
  buildOfficialMcpAuthHeaders,
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "./official-mcp/officialMcpCredentials.js";
export {
  computeAutomationNextRunAt,
  computeNextRunAt,
  computeScheduleRuleNextRunAt,
  isOneShotAutomation,
  isValidCronExpr,
} from "./session/automationCron.js";

import { ServiceCollection } from "./collection.js";
import { IFileService } from "./file/file.js";
import { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import { IGitService } from "./git/git.js";
import { IGitCheckpointService } from "./git/gitCheckpoint.js";
import { ISystemService } from "./system/system.js";
import { ITerminalService } from "./terminal/terminal.js";
import { ISettingService } from "./setting/setting.js";
import { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
import { ICredentialService } from "./credential/credential.js";
import { IBroadcastService } from "./broadcast/broadcast.js";
import { IZCodeTaskService } from "./session/zcodeTaskService.js";
import { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import type { CuaOperationStateReporter } from "./zcode-agent/cuaOperationTurnTracker.js";
import { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import {
  createUnsupportedConversationShareService,
  IConversationShareService,
  type IConversationShareService as IConversationShareServiceType,
} from "./conversation-share/conversationShare.js";
import {
  ConversationShareService,
  conversationShareConnectionScopeFactory,
} from "./conversation-share/conversationShareService.js";
import { createLocalConversationShareArtifactSource } from "./conversation-share/conversationShareArtifactSource.js";
import { ConversationShareHttpClient } from "./conversation-share/conversationShareHttpClient.js";
import { IBotsService } from "./bots/bots.js";
import { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import { IOAuthService } from "./oauth/oauth.js";
import { IUsageStatsService } from "./usage-stats/usageStats.js";
import { ICodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscription.js";
import { IClientScenesService } from "./client-scenes/clientScenes.js";
import { ISkillsService } from "./skills/skills.js";
import { ISkillSyncService } from "./skill-sync/skillSync.js";
import { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import { IPluginSyncService } from "./plugin-sync/pluginSync.js";
import { IPluginsService } from "./plugins/plugins.js";
import { IPluginManagementService } from "./plugins/pluginManagement.js";
import { ISubagentsService } from "./subagents/subagents.js";
import { ICommandsService } from "./commands/commands.js";
import { IHooksService } from "./hooks/hooks.js";
import { IMemoryService } from "./memory/memory.js";
import { IOutputStyleService } from "./output-style/outputStyle.js";
import { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import { IFeedbackService } from "./feedback/feedback.js";
import { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import { createFileService } from "./file/fileService.js";
import { createMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { WorkspaceFileSearchFilter } from "./file/workspaceFileMentionFilter.js";
import { createGitService } from "./git/gitService.js";
import { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
import { createGitCheckpointService } from "./git/gitCheckpointService.js";
import { createSystemService } from "./system/systemService.js";
import { createTerminalService } from "./terminal/terminalService.js";
import { createSettingServiceWithMigrations } from "./setting/settingService.js";
import { createOnboardingRecordService } from "./onboarding/onboardingRecordService.js";
import { createLegacyTeamOrganizationResolver } from "./model-provider/legacyTeamOrganizationResolver.js";
import { createObservableSettingService } from "./setting/observableSettingService.js";
import { createCredentialService } from "./credential/credentialService.js";
import { createBroadcastService } from "./broadcast/broadcastService.js";
import { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
import type { ZCodeAgentCommandResolver } from "./zcode-agent/zcodeAgentProcessManager.js";
import { buildAgentTelemetrySpawnEnv } from "./zcode-agent/agentTelemetryEnv.js";
import { resolveZCodeAgentPresentationSurface } from "./zcode-agent/zcodeAgentPresentationSurface.js";
import { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
import { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
import { createZCodeTaskIndexSyncer } from "./zcode-agent/zcodeTaskIndexSyncer.js";
import { TaskIndexRepo } from "./session/taskIndexRepo.js";
import { createBotsService } from "./bots/botsService.js";
import { createBotRemoteWorkspaceService } from "./bots/botRemoteWorkspaceBridge.js";
import type { SessionMessageSendRequested } from "#src/session/sessionMailbox.js";
import { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
import { createOAuthService } from "./oauth/oauthService.js";
import {
  isOAuthBusinessRequest,
  isCurrentOAuthCredentialRequest,
} from "#src/oauth/oauthUnauthorizedRequest.js";
import { createOAuthProviderLogoutHandler } from "./oauth/oauthProviderLogout.js";
import { OAuthCredentialRepo } from "./oauth/repo/oauthCredentialRepo.js";
import { readLegacyZCodeConfigProviders } from "./model-provider/legacyZCodeConfigProviderReader.js";
import { resolveAccountTeamPlanRuntimeMaterial } from "./model-provider/accountProviderTeamPlanRequestKey.js";
import { createAccountProviderCredentialStore } from "./model-provider/accountProviderCredentialStore.js";
import { createAccountProviderCredentialService } from "./model-provider/accountProviderCredentialService.js";
import { createAccountProviderRequestAuthService } from "./model-provider/accountProviderRequestAuthService.js";
import {
  createAccountProviderConfigSource,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "./model-provider/accountProviderConnectionResolver.js";
import { bindAccountProviderInvalidation } from "./model-provider/accountProviderInvalidation.js";
import { AccountProviderApiClient } from "./model-provider/accountProviderApiClient.js";
import { createAccountProjectTokenClient } from "./model-provider/accountProjectTokenClient.js";
import { AccountProviderApiKeyResolver } from "./model-provider/accountProviderApiKeyResolver.js";
import { createProviderConfigRuntime } from "./model-provider/providerConfigRuntime.js";
import { fetchZCodeBuiltinRemoteRelease } from "./model-provider/zcodeBuiltinRemoteConfig.js";
import {
  createProviderRuntimeFromConfigRuntime,
  type ProviderRuntime,
} from "./model-provider/providerRuntime.js";
import {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import { createProviderSettingsConnectivityTester } from "./model-provider/providerSettingsConnectivity.js";
import {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
} from "./model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "./model-provider/providerProvisioningTarget.js";
import { IProviderProvisioningTargetService } from "./model-provider/providerProvisioning.js";
import { buildOffPeakModelSelectionView } from "./model-provider/offPeakModelSelectionView.js";
import { resolveClientConfigPlatform } from "./runtime-tools/clientPlatform.js";
import {
  createAccountRequestAuthService,
  type IAccountRequestAuthService,
} from "./model-provider/accountRequestAuthService.js";
import { createUsageStatsService } from "./usage-stats/usageStatsService.js";
import { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
import { createClientConfigService } from "./client-config/clientConfigService.js";
import { IClientConfigService } from "./client-config/clientConfig.js";
import { createClientScenesService } from "./client-scenes/clientScenesService.js";
import { createSkillsService } from "./skills/skillsService.js";
import { createSkillSyncService } from "./skill-sync/skillSyncService.js";
import { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
import {
  IPluginUiAppToolsService,
  IPluginUiSamplingService,
  createPluginUiSamplingService,
  IPluginUiBridgeService,
  createPluginUiAppToolsService,
  createPluginUiBridgeService,
} from "./plugin-ui-bridge/index.js";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
import { createPluginsService } from "./plugins/pluginsService.js";
import { createPluginManagementService } from "./plugins/pluginManagementService.js";
import { createSubagentsService } from "./subagents/subagentsService.js";
import { createCommandsService } from "./commands/commandsService.js";
import { createHooksService } from "./hooks/hooksService.js";
import { createMemoryService } from "./memory/memoryService.js";
import { createOutputStyleService } from "./output-style/outputStyleService.js";
import { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
import {
  createFeedbackService,
  type CreateFeedbackServiceOptions,
} from "./feedback/feedbackService.js";
import { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
import { createNodeApiClient } from "./providers/api/nodeApiClient.js";
import {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
import type {
  RuntimeProcessLifecycleReporter,
  RuntimeTaskReporter,
} from "#src/process/runtimeProcessLifecycle.js";
import { initializeRuntimeProcessEnv } from "./runtime-tools/runtimeCommandEnv.js";
import {
  buildAgentEndpointOriginEnv,
  buildAgentRuntimeEnv,
} from "./runtime-tools/agentProxyEnv.js";
import { ensureAppCaCert } from "./runtime-tools/appCaCert.js";
import { buildHelperOpenArgs, isCuaLocalDevelopmentRuntime } from "@zcode/zcode-cua/broker/server";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import { IOffPeakTaskService } from "./session/offPeakTask.js";
import type { HighspeedMockScenario } from "@zcode/shared";
import { IHighspeedCardService } from "./highspeed/highspeedCard.js";
import {
  buildHighspeedCodingPlanAuthHeaders,
  HighspeedCardService,
  createHighspeedHttpTransport,
} from "./highspeed/highspeedCardService.js";
import { createHighspeedMockTransport } from "./highspeed/highspeedMockTransport.js";
import { OffPeakTaskService } from "./session/offPeakTaskService.js";
import { OffPeakTaskRepo } from "./session/offPeakTaskRepo.js";
import { createOffPeakServerClient } from "./session/offPeakServerClient.js";
import {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCredentials,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakMockUpstream,
} from "./session/offPeakRuntimeModel.js";
import {
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "./official-mcp/officialMcpCredentials.js";
import {
  createOfficialMcpTrustedOriginRegistry,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
} from "@zcode/shared";
import {
  BROKER_SOCKET_ENV,
  BROKER_UNAVAILABLE_ENV,
  createCuaPipSessionService,
  createCuaProductMcpServerResolver,
  createProductCuaHelperHost,
  CuaHelperLifecycleManager,
  ICuaPermissionService,
  ICuaPipSessionService,
  isOfficialCuaPluginEnabledForWorkspace,
  isPotentialZCodeCuaAgentMcpServer,
  isScreenCaptureProbeSuccess,
  reapOrphanedHelpers,
  resolveStandaloneStatusLaunchCandidates,
  shouldRunCuaScreenCaptureProbe,
  type CuaHelperHost,
  type CuaHelperTransportRestartOptions,
  type CuaHelperTransportRestartResult,
  type ManagedCuaProductHelperHost,
  type CuaProductMcpServerResolver,
  type CuaProductMcpServerResolverContext,
  type CuaPermissionRestartOptions,
  type CuaPermissionRestartResult,
  type CuaPermissionState,
  type CuaPermissionStatusQueryOptions,
  type CuaPermissionStatusResult,
} from "#src/cua-permission-broker/index.js";
import {
  resolveWindowsCuaRuntime,
  WindowsCuaDevRuntimeResolutionError,
  type WindowsCuaRuntime,
} from "#src/cua-permission-broker/windowsCuaDevRuntime.js";
import { createCanonicalCuaHelperInstaller } from "./cua-permission-broker/cuaHelperInstaller.js";
import { WindowsCuaHelperHost } from "#src/cua-permission-broker/windowsCuaDevHelperHost.js";
import {
  getStableCuaPipeName,
  resolveStableCuaWinRecipe,
} from "#src/cua-permission-broker/stableCuaTransport.js";
import { HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import { resolveBrokerSocketPath } from "@zcode/zcode-cua/broker/socketPath";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
  formatLogPrefix,
  isCredentialDecryptError,
  isStartPlanModelProviderId,
  OFF_PEAK_PROVIDER_IDS,
  BIGMODEL_PROVIDER_ID,
  type ProviderFamilyDomain,
  type ServiceAuthorityMode,
  resolveRuntimeZCodeEndpointOrigin,
  resolveSafeTelemetryHostname,
  type BrowserBackendDescriptor,
  type BrowserClientMode,
  type BrowserCommand,
  isZCodeCuaMcpCommand,
  isZCodeCuaMcpPackageArg,
  isZCodeCuaInternalFeatureEnabled,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  getCapturedZCodeAgentTelemetryEnv,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZCODE_MISSION_CONTINUATION_ENV_KEY,
  ZAI_PROVIDER_ID,
  zcodeAccountAccessSchema,
  zcodeProviderAccountAccessSchema,
  ZCODE_VERSION,
  ZCODE_ENV,
  buildRuntimeZCodeApiUrl,
} from "@zcode/shared";

// These conversation-share impls need Node fs; expose them only via @zcode/services/node
// so the browser-safe entry never drags node:* into the renderer.
export {
  ConversationShareService,
  ConversationShareHttpClient,
  conversationShareConnectionScopeFactory,
};

import { createPluginUiAccountBindings } from "./plugin-ui-bridge/instanceAccounts.js";
interface ServiceWithDisposeAll {
  disposeAll: () => void;
}

interface ServiceWithDisposeAllAndWait {
  disposeAllAndWait: () => Promise<void>;
}

// Bug A: the Helper's first cold launch (large Node SEA + first-time Gatekeeper/notarization
// assessment) routinely exceeds the old 5s health budget; warm it is <1s. Give the cold path
// plenty of headroom.
const CUA_HELPER_HEALTH_TIMEOUT_MS = 30_000;

type DefaultCuaProductHelper = {
  host: ManagedCuaProductHelperHost;
  macPermissionHost?: CuaHelperHost;
  resolver: CuaProductMcpServerResolver;
};

type ManagedDefaultCuaProductHelper = {
  helper: DefaultCuaProductHelper;
  seedContext?: CuaProductMcpServerResolverContext;
};

function hasDisposeAll(instance: unknown): instance is ServiceWithDisposeAll {
  return (
    typeof instance === "object" &&
    instance !== null &&
    "disposeAll" in instance &&
    typeof (instance as { disposeAll?: unknown }).disposeAll === "function"
  );
}

function hasDisposeAllAndWait(instance: unknown): instance is ServiceWithDisposeAllAndWait {
  return (
    typeof instance === "object" &&
    instance !== null &&
    typeof (instance as { disposeAllAndWait?: unknown }).disposeAllAndWait === "function"
  );
}

interface ManagedCuaHelperHostDispose {
  stop(): Promise<void>;
}

// The default Computer Use Helper is a long-lived TCC process (broker socket + Accessibility/Screen Recording).
// It is not an IPC service and stays out of ServiceCollection disposeAll, yet host teardown must stop it or it
// persists with granted TCC or respawns on rebuild: multi-instance/orphan/permission leaks. A WeakRef side-table
// keyed alongside the ServiceCollection registers them; dispose stops all (best-effort, never blocking).
const managedCuaHelperHosts = new WeakMap<ServiceCollection, ManagedCuaHelperHostDispose>();
const providerRuntimes = new WeakMap<ServiceCollection, ProviderRuntime>();
const providerProvisioningSources = new WeakMap<ServiceCollection, ProviderProvisioningSource>();
const providerProvisioningTriggerDisposers = new WeakMap<
  ServiceCollection,
  readonly (() => void)[]
>();
// TaskIndexRepo/OffPeakTaskRepo each hold tasks-index.sqlite handles;
// the dispose chain must close them all: on Windows a live handle makes temp-dir rm hit EBUSY
// (stable repro in the stdioDesktopPresentationSurface test); Linux unlink-while-open hides the leak.
// Like the other side tables, register alongside the ServiceCollection and close on dispose.
const sharedSqliteRepos = new WeakMap<ServiceCollection, ReadonlyArray<{ close(): void }>>();
const accountRequestAuthServices = new WeakMap<ServiceCollection, IAccountRequestAuthService>();
export type OffPeakRequestAuthBuilder = (
  ticketId: string,
) => Promise<{ apiKey: string; headers: Record<string, string>; accountScope?: string }>;
const offPeakRequestAuthBuilders = new WeakMap<ServiceCollection, OffPeakRequestAuthBuilder>();

/** In-process Local Host capabilities; never exposed to generic RPC channels. */
export function getAccountRequestAuthService(
  services: ServiceCollection,
): IAccountRequestAuthService | undefined {
  return accountRequestAuthServices.get(services);
}

/** In-process Local Host provisioning source; credentials never reach renderers over generic RPC. */
export function getProviderProvisioningSource(
  services: ServiceCollection,
): ProviderProvisioningSource | undefined {
  return providerProvisioningSources.get(services);
}

/** Local-Host-private off-peak auth assembly; reuses the real Registry/Account Access, RPC-free. */
export function getOffPeakRequestAuthBuilder(
  services: ServiceCollection,
): OffPeakRequestAuthBuilder | undefined {
  return offPeakRequestAuthBuilders.get(services);
}
const managedHostApiNetworkTransports = new WeakMap<ServiceCollection, HostApiNetworkTransport>();

export function registerManagedCuaHelperHostForDispose(
  services: ServiceCollection,
  host: ManagedCuaHelperHostDispose,
): void {
  managedCuaHelperHosts.set(services, host);
}

export function registerHostApiNetworkTransportForDispose(
  services: ServiceCollection,
  transport: HostApiNetworkTransport,
): void {
  managedHostApiNetworkTransports.set(services, transport);
}

export function shouldEnableDefaultCuaProductHelper(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): boolean {
  // CUA ships enabled (isZCodeCuaInternalFeatureEnabled defaults ON; only 0/false/off disables; 2026 note correcting the stale default-off comment). macOS uses the product Helper, Windows the packaged runtime;
  // both on demand. Disabled: no host, no probes, no children, no permission prompts.
  const env = options.env ?? process.env;
  if (!isZCodeCuaInternalFeatureEnabled(env)) return false;
  const platform = options.platform ?? process.platform;
  return platform === "darwin" || platform === "win32";
}

/**
 * Whether this host creates the default CUA product Helper. Only the desktop-local authority may:
 * - desktop-attached-remote and standalone-server never auto-create, or remote workspaces spawn Helpers
 * on the wrong host, breaking shared-host attachment and permission boundaries;
 * - never duplicates when a resolver was injected.
 * Platform/environment enablement is shouldEnableDefaultCuaProductHelper's call.
 */
export function shouldCreateDefaultCuaProductHelper(opts: {
  serviceAuthorityMode?: ServiceAuthorityMode;
  hasRemoteWorkspaceIdentity?: boolean;
  hasInjectedResolver: boolean;
  hasBuiltInCuaPlugin: boolean;
}): boolean {
  return (
    opts.hasBuiltInCuaPlugin &&
    opts.serviceAuthorityMode === "desktop-local" &&
    !opts.hasRemoteWorkspaceIdentity &&
    !opts.hasInjectedResolver
  );
}

export function shouldUseCuaPermissionService(opts: {
  platform?: NodeJS.Platform;
  cuaEnabled: boolean;
}): boolean {
  const platform = opts.platform ?? process.platform;
  return (platform === "darwin" || platform === "win32") && opts.cuaEnabled;
}

export function shouldRetainDefaultCuaProductHelper(): boolean {
  // The CUA toggle gates future admissions only; created Helpers stop at Host/App dispose.
  return true;
}

export function shouldEnableCuaOperationStateReporter(opts: {
  serviceAuthorityMode?: ServiceAuthorityMode;
  hasReporter: boolean;
}): boolean {
  // CUA state is a physical-desktop projection; remote servers never project turns onto this screen.
  return opts.hasReporter && opts.serviceAuthorityMode === "desktop-local";
}

export async function runCuaScreenCaptureReadinessProbe(
  host: Pick<CuaHelperHost, "queryScreenCaptureProbe">,
  screenRecording: "granted" | "denied" | "unknown",
  queryOptions?: CuaPermissionStatusQueryOptions,
): Promise<boolean> {
  if (!shouldRunCuaScreenCaptureProbe(screenRecording, queryOptions)) {
    return false;
  }
  try {
    return isScreenCaptureProbeSuccess(await host.queryScreenCaptureProbe());
  } catch {
    return false;
  }
}

/**
 * Screen-recording display value: prefer the short-lived probe's TCC truth, else the resident Helper's report.
 *
 * Why not trust the resident Helper: macOS revocations do not affect running processes;
 * they keep the granted capture and CGPreflightScreenCaptureAccess() returns the pre-revoke value.
 * So after a revoke the resident broker keeps saying granted until it restarts,
 * settings echo authorized, and the next Helper restart breaks CUA for real.
 * Grants read stale too: a just-approved Helper can still report denied.
 *
 * Fail-open is deliberate: on probe failure (open/timeout/invalid) keep the reported value,
 * no worse than not probing. Hard-denied would push granted users through a pointless prompt.
 */
export async function resolveCuaScreenRecordingState(
  host: Pick<CuaHelperHost, "queryScreenRecordingPreflight">,
  reported: "granted" | "denied" | "unknown",
): Promise<"granted" | "denied" | "unknown"> {
  // unknown means even CGPreflight was unavailable (pre-10.15). The probe is the same native call;
  // another process learns nothing new; skip the LaunchServices cold start.
  if (reported === "unknown") return reported;
  try {
    return (await host.queryScreenRecordingPreflight()) ?? reported;
  } catch {
    return reported;
  }
}

export function createDynamicCuaProductMcpServerResolver(options: {
  isPluginEnabled: (context?: CuaProductMcpServerResolverContext) => boolean;
  getResolver: (
    context?: CuaProductMcpServerResolverContext,
  ) => CuaProductMcpServerResolver | undefined | Promise<CuaProductMcpServerResolver | undefined>;
  isResolverCurrent?: (
    resolver: CuaProductMcpServerResolver,
    context?: CuaProductMcpServerResolverContext,
  ) => boolean;
}): CuaProductMcpServerResolver {
  return {
    async resolveMcpServers(servers, context) {
      if (!options.isPluginEnabled(context)) return servers;
      const resolver = await options.getResolver(context);
      if (!resolver) return servers;
      const resolved = await resolver.resolveMcpServers(servers, context);
      // Delegates can outrun Helper start/health awaits; once dispose marks the epoch terminal, a late
      // agent must not get the old generation's socket/token. Drop the CUA candidate, keep the rest.
      return options.isResolverCurrent?.(resolver, context) === false
        ? servers?.filter((server) => !isPotentialZCodeCuaAgentMcpServer(server))
        : resolved;
    },
    async restart() {
      // Delegate to the real resolver (ICuaPermissionService.restartHelper routes here).
      const resolver = await options.getResolver();
      if (!resolver) {
        throw new Error("ZCode Computer Use is not enabled (plugin off or not product mode).");
      }
      await resolver.restart();
    },
    async restartAfterPermissionGrant(onboardingSessionId) {
      // Post-grant restarts keep the session id to reuse idempotency guards.
      const resolver = await options.getResolver();
      if (!resolver) {
        throw new Error("ZCode Computer Use is not enabled (plugin off or not product mode).");
      }
      await resolver.restartAfterPermissionGrant(onboardingSessionId);
    },
  };
}

let orphanHelperReaperHasRun = false;

type CreateDefaultCuaProductHelperOptions = {
  // Forwarded to the resolver to gate restarts on active turns (cuaProductMcpResolver.ts).
  // The desktop-local agent service knows real CUA turn state; others default false.
  hasActiveTurn?: () => boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  arch?: NodeJS.Architecture;
  electronVersion?: string;
  resolveWindowsRuntime?: () => Promise<WindowsCuaRuntime>;
  createMacHost?: () => CuaHelperHost;
  createWindowsHost?: (runtime: WindowsCuaRuntime) => ManagedCuaProductHelperHost;
};

/**
 * Lazy resolver wrapper for the Windows Helper host: defer packaged-runtime resolution to first start()/checkHealth()
 * and cache the outcome (rejections included).
 *
 * resolveWindowsCuaRuntime can fail on missing-native-addon, artifact-integrity-mismatch,
 * or incompatible-runtime-manifest. Without a diagnostic the settings page
 * not-loaded state cannot say why, so log one error with the reason here.
 * Rejections cache on the same promise chain, so repeated start() never spams.
 * Payload: reason/artifact/errorName/message; resolution precedes token minting, so no secrets.
 */
export function createWindowsCuaHelperHost(options: {
  resolveRuntime: () => Promise<WindowsCuaRuntime>;
  createHost: (runtime: WindowsCuaRuntime) => ManagedCuaProductHelperHost;
  logger?: ServiceLogger;
}): ManagedCuaProductHelperHost {
  let host: ManagedCuaProductHelperHost | undefined;
  let resolving: Promise<ManagedCuaProductHelperHost> | undefined;
  let stopped = false;
  let lifecycleEpoch = 0;
  let stopDrain: Promise<void> | undefined;
  const logResolutionFailure = (error: unknown): void => {
    if (!options.logger) return;
    const resolutionError =
      error instanceof WindowsCuaDevRuntimeResolutionError ? error : undefined;
    const artifact = resolutionError?.artifact;
    options.logger.error(undefined, "Windows CUA Helper runtime resolution failed", {
      reason: resolutionError?.reason ?? "unknown",
      ...(artifact ? { artifact } : {}),
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
  };
  const assertActive = (epoch: number): void => {
    if (stopped || epoch !== lifecycleEpoch) {
      throw new Error("Windows Computer Use Helper startup stopped");
    }
  };
  const getHost = async (epoch: number): Promise<ManagedCuaProductHelperHost> => {
    assertActive(epoch);
    if (host) return host;
    resolving ??= options
      .resolveRuntime()
      // Catch only resolveRuntime: assertActive throws in the then are stop() races, not resolution failures,
      // and must not enter this diagnostic.
      .catch((error: unknown) => {
        logResolutionFailure(error);
        throw error;
      })
      .then((runtime) => {
        // stop() bumps the epoch synchronously; recheck after resolution or a disposed race orphans a Helper.
        assertActive(epoch);
        const nextHost = options.createHost(runtime);
        assertActive(epoch);
        host = nextHost;
        return nextHost;
      });
    const resolvedHost = await resolving;
    assertActive(epoch);
    return resolvedHost;
  };
  const withActiveHost = async <T>(
    operation: (activeHost: ManagedCuaProductHelperHost) => Promise<T>,
  ): Promise<T> => {
    const epoch = lifecycleEpoch;
    const activeHost = await getHost(epoch);
    assertActive(epoch);
    return operation(activeHost);
  };
  return {
    get running() {
      return host?.running ?? false;
    },
    get socketPath() {
      return host?.socketPath ?? null;
    },
    get pluginAuthority() {
      return host?.pluginAuthority ?? null;
    },
    async start() {
      return withActiveHost((activeHost) => activeHost.start());
    },
    async checkHealth(timeoutMs?: number) {
      return withActiveHost((activeHost) => activeHost.checkHealth(timeoutMs));
    },
    async waitForTransport(timeoutMs?: number) {
      return withActiveHost((activeHost) => {
        if (!activeHost.waitForTransport) {
          // Legacy injected hosts: without the two-phase API the full start handle is the only tuple.
          return activeHost.start().then((handle) => ({
            socketPath: handle.socketPath,
            pluginAuthority: handle.pluginAuthority,
          }));
        }
        return activeHost.waitForTransport(timeoutMs);
      });
    },
    async restart() {
      return withActiveHost((activeHost) => activeHost.restart());
    },
    async restartAfterCurrentStart() {
      return withActiveHost((activeHost) => activeHost.restartAfterCurrentStart());
    },
    async restartAfterCurrentStartPreservingTransport(
      restartOptions?: CuaHelperTransportRestartOptions,
    ): Promise<CuaHelperTransportRestartResult> {
      return withActiveHost((activeHost) => {
        if (activeHost.restartAfterCurrentStartPreservingTransport) {
          return activeHost.restartAfterCurrentStartPreservingTransport(restartOptions);
        }
        // Legacy hosts: once the wrapper exposes the preserving API it must also commit the fresh-start
        // marker, or the producer reads the fail-closed contract as broken post-start.
        restartOptions?.beforeFreshStart?.();
        return activeHost.restartAfterCurrentStart().then((handle) => ({ handle, reused: false }));
      });
    },
    async stop() {
      if (stopDrain) return stopDrain;
      stopped = true;
      lifecycleEpoch += 1;
      const pendingResolution = resolving;
      stopDrain = (async () => {
        // Settle in-flight resolution so it observes the terminal epoch; else a Helper starts after dispose.
        await pendingResolution?.catch(() => undefined);
        await host?.stop();
      })();
      return stopDrain;
    },
  };
}

export function createDefaultCuaProductHelper(
  options: CreateDefaultCuaProductHelperOptions,
): DefaultCuaProductHelper | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (!shouldEnableDefaultCuaProductHelper({ platform, env })) {
    return undefined;
  }
  const logger = createServiceLogger("cua-product-helper");
  // Best-effort, once per process: reap Helpers orphaned by prior sessions before minting a
  // fresh one. Complements the per-Helper launcher-pid watchdog (helperMain); the reaper never
  // throws, so it cannot block startup.
  if (platform === "darwin" && !orphanHelperReaperHasRun) {
    orphanHelperReaperHasRun = true;
    reapOrphanedHelpers({ logger, env });
  }
  let macPermissionHost: CuaHelperHost | undefined;
  let host: ManagedCuaProductHelperHost;
  if (platform === "darwin") {
    const bundledHelperAppPath = resolveBundledCuaHelperAppPath();
    if (!bundledHelperAppPath) {
      logger.error(
        undefined,
        "CUA product Helper is unavailable: packaged Resources path was not resolved",
      );
      return undefined;
    }
    macPermissionHost =
      options.createMacHost?.() ??
      createProductCuaHelperHost({
        logger,
        env: process.env,
        helperInstaller: createCanonicalCuaHelperInstaller({
          logger,
          env: process.env,
          bundledAppPath: bundledHelperAppPath,
        }),
        // Conflict rule: macOS consumes only the bundled Helper, never download sources;
        // Windows alone uses the packaged-runtime chain below.
        bundledHelperAppPath,
        // tolerate the Helper's cold first-launch instead of the 5s default.
        healthTimeoutMs: CUA_HELPER_HEALTH_TIMEOUT_MS,
        // The producer factory pins ghost cursor/PiP=true, background=false.
        // Consumers pass no fake dynamic getters; product policy lives in one repo.
      });
    host = macPermissionHost;
  } else {
    host = createWindowsCuaHelperHost({
      resolveRuntime:
        options.resolveWindowsRuntime ??
        (() =>
          resolveWindowsCuaRuntime({
            platform,
            env,
            resourcesPath: options.resourcesPath,
            arch: options.arch,
            electronVersion: options.electronVersion,
          })),
      createHost:
        options.createWindowsHost ??
        ((runtime) =>
          new WindowsCuaHelperHost({
            runtime,
            logger,
            mintSocketPath: () => getStableCuaPipeName(),
          })),
      logger,
    });
  }
  const resolver = createCuaProductMcpServerResolver(host, {
    hasActiveTurn: options.hasActiveTurn,
  });
  return {
    host,
    ...(macPermissionHost ? { macPermissionHost } : {}),
    resolver,
  };
}

export const ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV = "ZCODE_CUA_BUNDLED_HELPER_APP_PATH";

export function resolveBundledCuaHelperAppPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const injectedPath = env[ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV]?.trim();
  if (injectedPath) {
    return injectedPath;
  }
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath?.trim();
  return resourcesPath ? join(resourcesPath, "cua-helper", HELPER_APP_NAME) : undefined;
}

export { isOfficialCuaPluginEnabledForWorkspace };

export function hasGlobalCliZCodeCuaServer(env: NodeJS.ProcessEnv = process.env): boolean {
  const home = env.HOME?.trim() || homedir();
  const configPath = join(home, ".zcode", "cli", "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (isRecord(parsed.features) && parsed.features.mcp === false) return false;
  if (!isRecord(parsed.mcp) || !isRecord(parsed.mcp.servers)) return false;
  return Object.entries(parsed.mcp.servers).some(([name, config]) =>
    isGlobalCliZCodeCuaServer(name, config),
  );
}

function isGlobalCliZCodeCuaServer(name: string, config: unknown): boolean {
  if (!isRecord(config)) return false;
  if (config.enabled === false) return false;
  if (typeof config.type === "string" && config.type !== "stdio") return false;
  if (name === "computer-use") return true;
  // Share @zcode/shared's single source with the desktop resolver and CLI bootstrap; a third
  // divergent check risks missing git/.git/local-path zcode-cua, dropping broker socket/token from
  // CLI env, forcing agents back to Python/uvx-owned TCC (breaking the broker boundary).
  if (typeof config.command === "string" && isZCodeCuaMcpCommand(config.command)) {
    return true;
  }
  return (
    Array.isArray(config.args) &&
    config.args.some((arg) => typeof arg === "string" && isZCodeCuaMcpPackageArg(arg))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Creates the ServiceCollection with every local service
 *
 * @param options.parentPort - the Electron host process parentPort,
 * used by BroadcastService for cross-window relay; null disables broadcasting.
 */
export function createLocalServices(options: {
  /** Private callback channel from authenticated desktop stdio; not a public service. */
  topicResourceRelayChannel?: (request: unknown) => IChannel;
  parentPort?: Parameters<typeof createBroadcastService>[0];
  /** Settings authority injected at assembly; shares the network transport's Window Host lifetime. */
  settingService?: ISettingService;
  /** Shares the write queue with the injected local Setting; remote settings migrate at their own host. */
  prepareLegacyAccountConnections?: ReturnType<
    typeof createSettingServiceWithMigrations
  >["prepareLegacyAccountConnections"];
  /** ServiceCollection owns disposal once injected; reused by other host-managed downloads. */
  hostApiNetworkTransport?: HostApiNetworkTransport;
  /** Asks Main to register the exact local video path an Agent authorized. */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  /**
   * Forwarding for dynamic-workflow choice changes (docs/dynamic-workflow/launch.md, The user's choice):
   * the desktop host pushes the local setting to every live desktop-attached remote host in this window.
   */
  forwardDynamicWorkflowUserMode?: (mode: DynamicWorkflowMode | undefined) => void;
  /** Asks Main to register verified plugin UI HTML in exchange for a sandbox handle. */
  registerPluginSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  feedback?: Partial<
    Omit<CreateFeedbackServiceOptions, "apiClient" | "credentialService" | "oauthService">
  >;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  taskRuntimeReporter?: RuntimeTaskReporter;
  /** Workspace file search defaults to the builtin filter; inject the final impl at assembly. */
  workspaceFileSearchFilter?: WorkspaceFileSearchFilter;
  forwardSessionMessageSendRequested?: (
    request: SessionMessageSendRequested,
  ) => Promise<void> | void;
  /** Desktop-local hosts dispatch manual runs inline, bypassing the scheduler path. */
  onAutomationManualRunRequested?: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  /** Asks the host to wake the scheduler once schedulable flips (parentPort relay). */
  onOffPeakSchedulerWakeRequested?: () => void;
  // Injection point: the default resolver covers dev/desktop/SSH-remote;
  // tests and special hosts force custom binaries here.
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
  /** Login-shell env Desktop Main pre-collected; the Local Host skips its own synchronous probe. */
  runtimeProcessEnvPatch?: Record<string, string>;
  /** Local-desktop fallback for Agent spawn.cwd when the workspace is missing. */
  zcodeAgentSpawnFallbackCwd?: string;
  /** One-shot Agent network config handed to desktop-attached remote servers. */
  remoteAgentNetwork?: {
    httpProxy?: string;
    noProxy?: string;
  };
  /** Physical path of the environment's ZCode built-in provider config. */
  zcodeBuiltinProviderConfigFilePath: string;
  /** The HTTP server exposes cross-environment provisioning targets only with explicit auth. */
  providerProvisioningTargetEnabled?: boolean;
  /** Desktop-host-private notice: after the source persists, ask Main to mirror remotely. */
  onProviderProvisioningSourceChanged?: (
    trigger: Exclude<ProviderProvisioningTrigger, "environment-online">,
  ) => void;
  serviceAuthorityMode?: ServiceAuthorityMode;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
  agentTelemetry?: {
    getDeviceMid?: () => string | undefined;
    runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  };
  /** browser-use bridge (host-to-main WebContentsView+CDP); absent means no browser. */
  browserControlExecutor?: {
    list(input: {
      requestId: string;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
    }): Promise<BrowserBackendDescriptor[]>;
    execute(input: {
      requestId: string;
      browserId?: string;
      browserGeneration?: number;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
      command: BrowserCommand;
    }): Promise<{ ok: boolean; [k: string]: unknown }>;
  };
  /** CUA turn-state projection for Windows desktop-local hosts; others reject at assembly. */
  cuaOperationStateReporter?: CuaOperationStateReporter;
}): ServiceCollection {
  const isDesktopAttachedRemote = options?.serviceAuthorityMode === "desktop-attached-remote";
  // Hosts and remote servers used to inherit the process env for every child service.
  // GUI-launched desktops and SSH/WSL/Docker servers often miss the login shell PATH,
  // hiding profile-only commands like bun from agents and terminals.
  // Repair the runtime env before any local service starts and add the bundled rg to PATH,
  // so agents, terminals, and auth runtimes resolve commands identically.
  initializeRuntimeProcessEnv(options?.runtimeProcessEnvPatch);

  const desktopContextPromptEnabledRaw =
    process.env[ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]?.trim();
  const desktopContextPromptEnabled =
    desktopContextPromptEnabledRaw === "1"
      ? true
      : desktopContextPromptEnabledRaw === "0"
        ? false
        : undefined;

  // Mission continuation (task-list-driven autonomous continuation): snapshot the Desktop
  // toggle at Host startup, then inject it into every Agent spawn env. A standalone CLI run
  // can also enable it by exporting the variable directly.
  const missionContinuationEnabled =
    process.env[ZCODE_MISSION_CONTINUATION_ENV_KEY]?.trim() === "1";

  // App CA: generate a root CA once (idempotent) for agent trust via NODE_EXTRA_CA_CERTS
  // and proxy re-signing. Generation failures never block startup (read-only fs); log and continue.
  try {
    ensureAppCaCert();
  } catch (error) {
    console.error(formatLogPrefix("appCaCert", process.pid), "ensure app CA cert failed:", error);
  }

  const localSettings = options?.settingService ? null : createSettingServiceWithMigrations();
  const settingService = createObservableSettingService(
    options?.settingService ?? localSettings!.service,
  );
  const resolveCurrentZCodeEndpointOrigin = async () =>
    resolveRuntimeZCodeEndpointOrigin(process.env, {
      overrideOrigin: (await settingService.get()).zcodeEndpointOrigin,
    });
  let invalidateProjectTokens = () => {};
  let invalidatePluginUiAccounts: (() => void) | undefined;
  const provisioningOAuthKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  const credentialService = createCredentialService({
    onDidMutate: ({ key }) => {
      if (key === "oauth:active_provider" || /^oauth:[^:]+:user_info$/.test(key))
        invalidatePluginUiAccounts?.();
      if (provisioningOAuthKeys.has(key)) invalidateProjectTokens();
      if (provisioningOAuthKeys.has(key)) {
        options.onProviderProvisioningSourceChanged?.("credential");
      }
    },
  });
  const accountProviderCredentialStore = createAccountProviderCredentialStore({
    credentialService,
  });
  const broadcastService = createBroadcastService(options?.parentPort ?? null);
  const gitCheckpointService = createGitCheckpointService();
  const hostApiNetworkTransport =
    options?.hostApiNetworkTransport ??
    createHostApiNetworkTransport(async () => {
      const settings = await settingService.get();
      return {
        httpProxy: settings.httpProxy,
        noProxy: settings.httpProxyNoProxy,
        caCertPath: settings.httpProxyCaCertPath,
      };
    });
  const zcodeJwtLogoutHandlerRef: {
    current: ((input: string | URL, headers: Headers) => void) | null;
  } = { current: null };
  const apiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
    onZcodeJwtInvalid: (input, headers) => zcodeJwtLogoutHandlerRef.current?.(input, headers),
    isZcodeJwtRequest: (input, headers) =>
      isCurrentOAuthCredentialRequest({ input, headers, credentialService }),
    isBusinessUnauthorizedRequest: (input, _headers) =>
      isOAuthBusinessRequest({ input, credentialService }),
    resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
  });
  const systemService = createSystemService();
  // Onboarding eligibility and task lists share the global tasks-index; the repo lazy-loads, so early
  // construction costs no extra IO and the session syncer reuses it.
  const taskIndexRepo = new TaskIndexRepo();
  // Onboarding records: userId filled from auth (null for apikey/anonymous); docs/onboarding-record-spec.md.
  const onboardingRecordService = createOnboardingRecordService({
    loadUserId: async () => (await oauthCredentialRepo.loadActiveUserProfile())?.id ?? null,
    hasExistingLocalTask: async () => (await taskIndexRepo.listTaskMetas({})).length > 0,
  });
  let handleOAuthProviderLogout: ReturnType<typeof createOAuthProviderLogoutHandler> | null = null;
  const oauthCredentialRepo = new OAuthCredentialRepo(credentialService, {
    onCorruptOAuthSessionCleared: async (providers) => {
      // Background paths can read corrupt OAuth credentials before telemetry does.
      // Recovery must equal logout: reuse the handler clearing derived provider keys.
      await Promise.all(
        providers.map((provider) => handleOAuthProviderLogout?.(provider) ?? Promise.resolve()),
      );
    },
  });
  const projectTokenClient = createAccountProjectTokenClient(apiClient, credentialService);
  invalidateProjectTokens = () => projectTokenClient.clear();
  const accountProviderApiKeyRemoteClient = new AccountProviderApiClient(apiClient);
  const accountProviderApiKeyResolver = new AccountProviderApiKeyResolver(
    accountProviderApiKeyRemoteClient.fetchRemoteData.bind(accountProviderApiKeyRemoteClient),
    projectTokenClient,
  );
  const accountProviderCredentialService = createAccountProviderCredentialService({
    async loadOAuthAccessToken(family) {
      const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
      return (await oauthCredentialRepo.loadTokenSet(oauthProviderId))?.accessToken ?? null;
    },
    resolveProviderMaterial: (
      family,
      accessToken,
      accountIdentity,
      rejectedProjectTokenFingerprint,
    ) =>
      accountProviderApiKeyResolver.resolveProviderMaterial(
        family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID,
        accessToken,
        accountIdentity,
        rejectedProjectTokenFingerprint,
      ),
  });
  const resolveLegacyTeamOrganization = createLegacyTeamOrganizationResolver({
    apiClient,
    loadOAuthTokenSet: (family) =>
      oauthCredentialRepo.loadTokenSet(family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID),
  });
  const readAccountProviderSettings = async () => {
    // Migration coordinates at the account-facts entry only; ApiClient proxy/endpoint keeps reading plain settings.
    // Injected remote settings belong to their host and never read local legacy files.
    const prepare =
      options?.prepareLegacyAccountConnections ?? localSettings?.prepareLegacyAccountConnections;
    const unresolvedFamilies = (await prepare?.(resolveLegacyTeamOrganization)) ?? [];
    const settings = await settingService.get();
    return {
      providerFamilyDomain: settings.providerFamilyDomain ?? null,
      selections: settings.providerFamilyConnectionSelections ?? {},
      unresolvedFamilies,
    };
  };
  const loadAccountIdentity = async (family: ProviderFamilyDomain) => {
    const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
    return (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id ?? null;
  };
  const accountRequestAuthService = createAccountRequestAuthService(
    createAccountProviderRequestAuthService({
      resolveCurrentAccountAccess: (access) =>
        resolveCurrentAccountAccess({
          access,
          readSettings: readAccountProviderSettings,
          loadAccountIdentity,
        }),
      loadOAuthTokenSet: (providerId) => oauthCredentialRepo.loadTokenSet(providerId),
      async loadIndividualPlanMaterial(providerId, family, rejectedProjectTokenFingerprint) {
        const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
        const accountIdentity = (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id;
        if (!accountIdentity) return null;
        return accountProviderCredentialService.loadCodingPlanMaterial({
          providerId,
          family,
          accountIdentity,
          rejectedProjectTokenFingerprint,
        });
      },
      resolveTeamPlanMaterial: async (access, rejectedProjectTokenFingerprint) => {
        const accountIdentity = await loadAccountIdentity(access.family);
        if (!accountIdentity) return null;
        return resolveAccountTeamPlanRuntimeMaterial({
          apiClient,
          credentialService,
          access,
          accountIdentity,
          tokenClient: projectTokenClient,
          rejectedProjectTokenFingerprint,
        });
      },
    }),
  );
  const providerConfigLog = createServiceLogger("provider-config");
  const clientConfigPlatform = resolveClientConfigPlatform();
  const providerConfigRuntime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: options.zcodeBuiltinProviderConfigFilePath,
    zcodeBuiltinEnvironment: {
      environmentConfigRoot: resolveAppConfigDir(),
      platform: clientConfigPlatform,
      appVersion: ZCODE_VERSION,
      resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
      onRefreshResult: (event) => {
        if (event.result === "updated")
          providerConfigLog.info(undefined, "ZCode built-in CDN config updated", event);
        else providerConfigLog.debug(undefined, "ZCode built-in refresh check", event);
      },
      fetchRelease: (endpointOrigin, signal) =>
        fetchZCodeBuiltinRemoteRelease({
          apiClient,
          endpointOrigin,
          signal,
          appVersion: ZCODE_VERSION,
          platform: clientConfigPlatform,
        }),
    },
    onZCodeBuiltinRefreshError: (error) => {
      providerConfigLog.warn(undefined, "ZCode built-in config remote refresh failed", { error });
    },
    onPersonalConfigRecovery: (event) => {
      providerConfigLog.warn(
        undefined,
        "Personal provider config load failed; disk kept, degrading to empty in-memory config",
        {
          error: event.error,
        },
      );
    },
    onPersonalConfigPollingError: (error) => {
      // Poll errors surface once on entering the failed state; later rounds retry silently.
      providerConfigLog.warn(
        undefined,
        "Personal provider config poll failed temporarily; retrying",
        {
          error,
        },
      );
    },
    // The released config.json holds user config; ACP cleanup must keep this upgrade path.
    // The repository imports only when no personal config exists, keeping the old file for rollback.
    readLegacyProviders: () => readLegacyZCodeConfigProviders(),
  });
  const accountProviderConfigSource = createAccountProviderConfigSource({
    configSource: providerConfigRuntime.configService,
    readSettings: readAccountProviderSettings,
    async loadCodingPlanApiKey(providerId, family, accountIdentity, forceRefresh) {
      if (isStartPlanModelProviderId(providerId)) return null;
      return accountProviderCredentialService.loadCodingPlanApiKey({
        providerId,
        family,
        accountIdentity,
        forceRefresh,
      });
    },
    loadAccountIdentity,
    resolveFamilyAvailability: createCodingPlanFamilyAvailabilityResolver({
      apiClient,
      credentialService,
    }),
  });
  const accountProviderRuntimeLog = createServiceLogger("account-provider-runtime");
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: providerConfigRuntime.personalRepository,
  });
  const providerProvisioningSource = createProviderProvisioningSource({
    personalRepository: providerConfigRuntime.personalRepository,
    settingService,
    credentialFilePath: resolveCredentialFilePath(resolveAppConfigDir()),
    personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
  });
  const providerProvisioningDisposers = [
    providerConfigRuntime.configService.onDidChange((reason) => {
      // Every window host polls the same file; count only this process's committed updated
      // as the sync trigger so foreign poll-changed events cannot inflate generations.
      if (reason === "personal:updated") {
        options.onProviderProvisioningSourceChanged?.("personal-config");
      }
    }),
    settingService.onDidUpdate((event) => {
      if (
        event.keys.includes("providerFamilyDomain") ||
        event.keys.includes("providerFamilyConnectionSelections")
      ) {
        options.onProviderProvisioningSourceChanged?.("account-settings");
      }
    }),
  ];
  const disposeAccountProviderInvalidation = bindAccountProviderInvalidation({
    onDidUpdateSetting: (listener) => settingService.onDidUpdate(listener),
    refresh: (reason) => accountProviderConfigSource.refresh(reason),
  });
  const accountProviderRefreshErrorDispose = accountProviderConfigSource.onDidRefreshError(
    (event) => {
      accountProviderRuntimeLog.warn(undefined, "account provider source refresh failed", {
        error: event.error,
        reasons: event.reasons,
      });
    },
  );
  let providerConnectivityAgentService:
    | Pick<IZCodeAgentService, "testModelConnectivity">
    | undefined;
  const providerRuntime = createProviderRuntimeFromConfigRuntime({
    configRuntime: providerConfigRuntime,
    accountSource: accountProviderConfigSource,
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
    testConnectivity: createProviderSettingsConnectivityTester({
      testModelConnectivity: async (input) => {
        if (!providerConnectivityAgentService) {
          throw new Error("Agent service has not finished model connectivity wiring");
        }
        return providerConnectivityAgentService.testModelConnectivity(input);
      },
    }),
    disposeAccountSource: () => {
      disposeAccountProviderInvalidation();
      accountProviderRefreshErrorDispose();
      accountProviderConfigSource.dispose();
    },
  });
  handleOAuthProviderLogout = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore,
    refreshAccountProviders: (reason: string) => accountProviderConfigSource.refresh(reason),
  });
  // Official server MCP credential source. MCP auth headers and the quota probe (/api/v1/mcp/usage)
  // must share one implementation or their selected-connection reads diverge.
  // The quota side injects the resolver, not resolveHeaders: attribution needs providerFamily
  // and headers carry none; headers still come from buildOfficialMcpAuthHeaders.
  const officialMcpCredentialSource = {
    resolve: () =>
      resolveOfficialMcpCredentials({
        accountRequestAuthService,
        credentialService,
        modelSelectionService: providerRuntime.modelSelection,
      }),
  };
  // Closures in mcpSync/hooks call zcodeAgentService lazily; declaration order is safe.
  const skillsService = createSkillsService({ isDesktopRuntime: true });
  const mcpSyncService = createMcpSyncService({
    // mcp/list host consumption lives in mcpSync; real checks stay in the agent process.
    listMcpServerStatuses: (params) => zcodeAgentService.listMcpServerStatuses(params),
  });
  const pluginSyncService = createPluginSyncService();
  const pluginUiAccounts = createPluginUiAccountBindings({
    async readAccount() {
      const provider = await oauthCredentialRepo.loadActiveProvider();
      const profile = provider ? await oauthCredentialRepo.loadUserProfile(provider) : null;
      return [provider, profile?.id ?? null];
    },
    open: (params) => zcodeAgentService.openMcpUiInstance(params),
    close: (params) => zcodeAgentService.closeMcpUiInstance(params),
  });
  invalidatePluginUiAccounts = () => pluginUiAccounts.invalidate();
  const pluginUiBridgeService = createPluginUiBridgeService({
    openInstance: (params) => pluginUiAccounts.open(params),
    closeInstance: (params) => pluginUiAccounts.close(params),
    validateInstance: (params) => zcodeAgentService.validateMcpUiInstance(params),
    recycleInstance: (params) => zcodeAgentService.recycleMcpUiInstance(params),
    // Plugin UI: reads and tool calls run in the session's agent process; the host validates and registers.
    readMcpResource: (params) => zcodeAgentService.readMcpResource(params),
    callMcpToolForUi: (params) => zcodeAgentService.callMcpToolForUi(params),
    cancelMcpToolCallForUi: (params) => zcodeAgentService.cancelMcpToolCallForUi(params),
    readMcpResourceForUi: (params) => zcodeAgentService.readMcpResourceForUi(params),
    listMcpResourcesForUi: (params) => zcodeAgentService.listMcpResourcesForUi(params),
    listMcpResourceTemplatesForUi: (params) =>
      zcodeAgentService.listMcpResourceTemplatesForUi(params),
    subscribeMcpResourceForUi: (params) => zcodeAgentService.subscribeMcpResourceForUi(params),
    unsubscribeMcpResourceForUi: (params) => zcodeAgentService.unsubscribeMcpResourceForUi(params),
    listPluginUiSurfaces: (params) => zcodeAgentService.listPluginUiSurfaces(params),
    registerSandbox: options?.registerPluginSandbox,
  });
  // App-Provided Tools: registration and claim/return run in the session's agent process.
  const pluginUiSamplingService = createPluginUiSamplingService({
    sample: (params) => zcodeAgentService.sampleMcpApp(params),
    cancelSampling: (params) => zcodeAgentService.cancelMcpAppSampling(params),
  });
  const pluginUiAppToolsService = createPluginUiAppToolsService({
    registerAppToolsForUi: (params) => zcodeAgentService.registerAppToolsForUi(params),
    unregisterAppToolsForUi: (params) => zcodeAgentService.unregisterAppToolsForUi(params),
    claimAppToolCallForUi: (params) => zcodeAgentService.claimAppToolCallForUi(params),
    resolveAppToolCallForUi: (params) => zcodeAgentService.resolveAppToolCallForUi(params),
  });
  const subagentsService = createSubagentsService({
    isDesktopRuntime: true,
  });
  const commandsService = createCommandsService({ isDesktopRuntime: true });
  const hooksService = createHooksService({
    grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
  });
  const memoryService = createMemoryService();
  // Once this process mounts a provider runtime, its own Selection View
  // decides execution readiness; desktop-attached remotes read their own facts too.
  const modelSelectionReadinessSource = providerRuntime.modelSelection;
  const agentAccountProviderConfigSource = accountProviderConfigSource;
  //===== Computer Use Helper lifecycle (ported from feat) =====
  // Constraints: lazy coordinator plus generation fences (dispose only from explicit workspace lifecycles);
  // no periodic health probes; restarts reuse the host transport so agent sessions,
  // processes, and MCP streams survive.
  // P1-a: createDefaultCuaProductHelper() assembles the resolver before zcodeAgentService exists,
  // yet active-turn state appears only later. Forward-reference it: the resolver's hasActiveTurn()
  // runs inside a later async resolveMcpServers, long after the ref is assigned.
  // Wire the tracker via forward reference so Helpers never restart mid-turn;
  // assign after the service exists. Recovery never reaps agents.
  let hasActiveTurnRef: (() => boolean) | undefined;
  const isCuaEnabledForContext = (context?: CuaProductMcpServerResolverContext): boolean =>
    // Preserve main's gate (no regressions): dev/internal flags (ZCODE_CUA_DEV_MODE=1 or
    // ZCODE_CUA_PRODUCT_HELPER=1) enable regardless of config.json; main's bootstrap
    // gates the bundled plugin via isZCodeCuaInternalFeatureEnabled, unlike feat's workspace check.
    // In production, fall back to the plugin workspace check (matching feat).
    isZCodeCuaInternalFeatureEnabled(process.env) ||
    isOfficialCuaPluginEnabledForWorkspace({
      env: process.env,
      workingDirectory: context?.workspacePath,
    });
  const defaultCuaProductHelperLifecycle =
    new CuaHelperLifecycleManager<ManagedDefaultCuaProductHelper>(async (managed) => {
      await managed.helper.host.stop();
    });
  const createManagedDefaultCuaProductHelper = (
    context?: CuaProductMcpServerResolverContext,
  ): ManagedDefaultCuaProductHelper | undefined => {
    const helper = createDefaultCuaProductHelper({
      // Forward active-turn queries (forward ref, assigned post-construction).
      hasActiveTurn: () => hasActiveTurnRef?.() ?? false,
    });
    if (!helper) return undefined;

    // The legacy assembly ran a 10s watchdog; one idle broker_info timeout
    // triggered background restarts. The Helper is not the agent-runtime owner and need not self-heal idle;
    // health checks stay at spawn-env and request boundaries, timer-free.
    return {
      helper,
      ...(context ? { seedContext: context } : {}),
    };
  };
  const getOrCreateDefaultCuaProductHelper = async (
    context?: CuaProductMcpServerResolverContext,
  ): Promise<DefaultCuaProductHelper | undefined> => {
    const managed = await defaultCuaProductHelperLifecycle.acquire({
      isAdmitted: () =>
        shouldCreateDefaultCuaProductHelper({
          serviceAuthorityMode: options?.serviceAuthorityMode,
          hasRemoteWorkspaceIdentity: Boolean(context?.workspaceIdentity?.trim()),
          hasInjectedResolver: Boolean(options?.cuaProductMcpServerResolver),
          hasBuiltInCuaPlugin: isCuaEnabledForContext(context),
        }),
      shouldRetainCurrent: shouldRetainDefaultCuaProductHelper,
      create: () => createManagedDefaultCuaProductHelper(context),
    });
    return managed?.helper;
  };
  const isDefaultCuaProductHelperCurrent = (helper: DefaultCuaProductHelper): boolean =>
    defaultCuaProductHelperLifecycle.peek()?.helper === helper;
  // Lazy start: at boot, only probe the stable socket for an already-running
  // SDK-spawned Helper. Ping only, never spawn; 300ms budget. The result feeds
  // status display and PiP discovery; grants and onboarding keep explicit flows.
  const probeStableCuaHelperSocket = async (): Promise<string | null> => {
    const socketPath =
      process.platform === "win32" ? getStableCuaPipeName() : resolveBrokerSocketPath();
    try {
      const { createConnection } = await import("node:net");
      return await new Promise<string | null>((resolve) => {
        const socket = createConnection(socketPath);
        const finish = (value: string | null): void => {
          socket.destroy();
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), 300);
        socket.on("connect", () => {
          clearTimeout(timer);
          socket.write(`{"id":0,"method":"ping","params":{}}\n`);
          let buffer = "";
          socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            if (buffer.includes("\n")) {
              try {
                const nl = buffer.indexOf("\n");
                const reply = JSON.parse(buffer.slice(0, nl)) as { ok?: boolean };
                finish(reply.ok === true ? socketPath : null);
              } catch {
                finish(null);
              }
            }
          });
        });
        socket.on("error", () => {
          clearTimeout(timer);
          finish(null);
        });
      });
    } catch {
      return null;
    }
  };

  // On demand: spawn the standalone Helper (stable socket). Dev builds embed dev policy and pair
  // unsigned-launcher/external-escape argv so ad-hoc-signed parents pass the gate;
  // product builds carry no dev policy and sign naturally.
  // Then poll ping (5s/100ms): return the socket path or null.
  //
  // Dev detection uses upstream isCuaLocalDevelopmentRuntime (@zcode/zcode-cua/broker/server,
  // the same subpath already imported for buildHelperOpenArgs).
  //
  // Equivalence (not hardening): upstream is COMPILED_LOCAL_DEVELOPMENT_RUNTIME &&",
  // ZCODE_RUNTIME_ENV!=production; the constant is define-folded only in scripts/build-cua-helper-app.mjs
  // (Helper bundle). The host bundle lacks it, falling back to
  // process.env.NODE_ENV!=production, exactly what the copy encodes. In current packaging
  // they are token-equal; production gating comes from ZCODE_RUNTIME_ENV=production.
  //
  // Upstream would kill the drift: fold points, factors, and fail-closed direction in one place;
  // once the host bundle defines __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__ (Helper already does),
  // the compile-time gate engages with no edits here.

  const launchStandaloneCuaHelperForStatus = async (): Promise<string | null> => {
    if (process.platform !== "darwin") return null;
    const { existsSync } = await import("node:fs");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const socketPath = resolveBrokerSocketPath();
    const appPath = resolveStandaloneStatusLaunchCandidates(process.env).find((candidate) =>
      existsSync(candidate),
    );
    if (!appPath) return null;
    // Helper args come only from buildHelperOpenArgs; hand-rolling drifts.
    // Settings probes carry no PiP: no launcher-pid/pip-mode flags;
    // exit log .settings.exit.log; new args belong in HelperLaunchSpec.
    const args = buildHelperOpenArgs({
      appPath,
      socketPath,
      exitLogPath: `${socketPath}.settings.exit.log`,
      ...(isCuaLocalDevelopmentRuntime(process.env)
        ? { allowUnsignedLauncherLocalDev: true, allowExternalBrokerClientLocalDev: true }
        : {}),
    });
    try {
      await promisify(execFile)("/usr/bin/open", args, { timeout: 5_000 });
    } catch {
      // LaunchServices can accept yet stall; keep waiting on ping.
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await probeStableCuaHelperSocket();
      if (ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };

  const launchWindowsCuaHelperForStatus = async (): Promise<string | null> => {
    try {
      const managed = await getOrCreateDefaultCuaProductHelper(undefined);
      if (managed) void managed.host.start().catch(() => {});
    } catch {}
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await probeStableCuaHelperSocket();
      if (ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };

  // serviceAuthorityMode alone decides enabled and lifecycle wiring;
  // name it so startup diagnostics cannot drift from reality.
  const cuaPipSessionEnabled =
    process.platform === "darwin" && options?.serviceAuthorityMode === "desktop-local";
  const cuaPipSessionService = createCuaPipSessionService({
    enabled: cuaPipSessionEnabled,
    resolveCredentials: async () => {
      const host = defaultCuaProductHelperLifecycle.peek()?.helper.macPermissionHost;
      // PiP clients declare role=presentation; the Helper admits by the peer's signed id.
      if (host?.running && host.socketPath) {
        return {
          socketPath: host.socketPath,
        };
      }
      // Lazy: without a managed host, probe the stable socket (no spawn).
      const stable = await probeStableCuaHelperSocket();
      return stable ? { socketPath: stable } : undefined;
    },
  });
  // Log PiP delivery wiring at boot. In dev, zero PiP events arrived and neither
  // disabled nor unwired lifecycle (undefined tracker, no-op accept)
  // logs anything at runtime; this line distinguishes them at startup,
  // no CUA round trip needed. Scope cua-pip-session: its info reaches host logs.
  createServiceLogger("cua-pip-session").info(undefined, "[cua-pip-session] wiring resolved", {
    enabled: cuaPipSessionEnabled,
    platform: process.platform,
    serviceAuthorityMode: options?.serviceAuthorityMode ?? null,
    lifecycleWired: options?.serviceAuthorityMode === "desktop-local",
  });
  // macOS permission service: renderers query Helper state via host RPC and, after granting,
  // restart via the explicit entry. Restarts MUST use resolver.restart(), not bare host.restart(),
  // since the resolver reuses socket and token; a bare restart mints fresh credentials and strands
  // agents on the old transport.
  const cuaPermissionService: ICuaPermissionService = {
    async getStatus(
      workspacePath: string,
      workspaceIdentity?: string,
      queryOptions?: CuaPermissionStatusQueryOptions,
    ): Promise<CuaPermissionStatusResult> {
      if (process.platform !== "darwin" && process.platform !== "win32") {
        return {
          available: false,
          reason: "CUA permissions are only available on macOS and Windows.",
        };
      }
      const context = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
      // Toggling off gates future agents only; refreshes must not acquire and kill in-use Helpers.
      if (
        !shouldUseCuaPermissionService({
          cuaEnabled: isCuaEnabledForContext(context),
        })
      ) {
        return {
          available: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      // Lazy: queries never spawn. Managed host present (post-grant): full check;
      // else probe the stable socket; nothing means not-running (auto-start on first use).
      const peeked = defaultCuaProductHelperLifecycle.peek()?.helper;
      const helper = peeked && isDefaultCuaProductHelperCurrent(peeked) ? peeked : undefined;
      const host = helper ? helper.macPermissionHost : undefined;
      if (!host || !host.running) {
        // On demand: the settings query spawns the standalone Helper (stable socket,
        // no launcher-pid, 300s idle sleep, unmanaged) then queries truth over it.
        let stable = await probeStableCuaHelperSocket();
        if (!stable) {
          stable =
            process.platform === "darwin"
              ? await launchStandaloneCuaHelperForStatus()
              : await launchWindowsCuaHelperForStatus();
        }
        if (!stable) {
          return {
            available: false,
            reason:
              "ZCode Computer Use is not running; it will start automatically on first Computer Use use.",
            idle: true,
          } satisfies { available: false; reason: string; idle: true };
        }
        // Query truth on the standalone Helper directly (identity mode, no token).
        try {
          const { callBrokerMethod } = await import("@zcode/zcode-cua/broker/helperHealth");
          const report = await callBrokerMethod<{
            grant_owner: string;
            owner?: { display_name?: string };
            accessibility: CuaPermissionState;
            accessibility_probe_ok?: boolean;
            screen_recording: CuaPermissionState;
          }>({
            socketPath: stable,
            method: "permission_status",
            timeoutMs: 3000,
          });
          return {
            grantOwner: report.grant_owner,
            grantOwnerDisplayName: report.owner?.display_name ?? report.grant_owner,
            accessibility: report.accessibility,
            accessibilityProbeOk: report.accessibility_probe_ok === true,
            screenRecording: report.screen_recording,
            screenCaptureProbeOk: false,
          };
        } catch {
          return {
            available: false,
            reason: "ZCode Computer Use is starting up; retry in a moment.",
            idle: true,
          } satisfies { available: false; reason: string; idle: true };
        }
      }
      try {
        const report = await host.queryPermissionStatus();
        if (!helper || !isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        // Screen-recording truth needs a fresh process: revocations skip running Helpers,
        // which keep reporting pre-revoke granted; on failure fail-open to the report.
        const screenRecording = await resolveCuaScreenRecordingState(host, report.screen_recording);
        if (!isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        // Real capture probe: a granted TCC entry only means the database agrees; WindowServer may
        // still gate pixels. Only non-empty captured frames prove screen works end to end;
        // UI ready/auto-close keys off it. Fail closed on errors and timeouts.
        // Gate on the preflight state: denied means skip the capture.
        const screenCaptureProbeOk = await runCuaScreenCaptureReadinessProbe(
          host,
          screenRecording,
          queryOptions,
        );
        if (!isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        const reportedOwnerDisplayName =
          typeof report.owner?.display_name === "string" ? report.owner.display_name : undefined;
        return {
          grantOwner: report.grant_owner,
          grantOwnerDisplayName: reportedOwnerDisplayName ?? report.grant_owner,
          accessibility: report.accessibility,
          accessibilityProbeOk:
            report.accessibility_probe?.ok === true &&
            report.accessibility_probe?.classification === "functional",
          screenRecording,
          screenCaptureProbeOk,
        };
      } catch (error) {
        return {
          available: false,
          reason: `Could not read Computer Use Helper permission status: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
    async restartHelper(
      workspacePath: string,
      workspaceIdentity?: string,
      restartOptions?: CuaPermissionRestartOptions,
    ): Promise<CuaPermissionRestartResult> {
      if (process.platform !== "darwin") {
        return {
          ok: false,
          reason: "CUA permissions are only available on macOS.",
        };
      }
      const context = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
      // Like getStatus: never touch Helpers on disable, protecting live agent runtimes.
      if (
        !shouldUseCuaPermissionService({
          cuaEnabled: isCuaEnabledForContext(context),
        })
      ) {
        return {
          ok: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      // Restart via resolver.restart() to reuse transports; never via disposeWorkspace,
      // which would rebuild running agents.
      const helper = await getOrCreateDefaultCuaProductHelper(context);
      const resolver =
        helper && helper.macPermissionHost && isDefaultCuaProductHelperCurrent(helper)
          ? helper.resolver
          : undefined;
      if (!resolver) {
        return {
          ok: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      try {
        if (restartOptions?.reason === "permission_granted") {
          await resolver.restartAfterPermissionGrant(restartOptions.onboardingSessionId);
        } else {
          await resolver.restart();
        }
        if (!helper || !isDefaultCuaProductHelperCurrent(helper)) {
          return {
            ok: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: `Failed to restart ZCode Computer Use: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };
  // Dynamic-workflow user choice (launch.md): the local settings file is the only source, read per use;
  // desktop-attached remotes cannot read it, so desktop pushes
  // (zcodeAgentService.syncDynamicWorkflowUserMode); nothing injected here. Read failures follow.
  const resolveDynamicWorkflowUserMode = isDesktopAttachedRemote
    ? undefined
    : async () => (await settingService.get()).dynamicWorkflowMode;
  const codingPlanSubscriptionService = createCodingPlanSubscriptionService({
    apiClient,
    credentialService,
    ...(resolveDynamicWorkflowUserMode ? { resolveDynamicWorkflowUserMode } : {}),
    resolveOffPeakModelSelectionView: async () => {
      await providerRuntime.start();
      return buildOffPeakModelSelectionView(providerRuntime.registryService.getView());
    },
  });
  // The OffPeakTaskService singleton is built in the DI register IIFE (after the agent service);
  // a lazy holder binds it; offPeak/create only fires post-assembly.
  let offPeakTaskServiceForAgent: OffPeakTaskService | undefined;
  // Desktop-attached-remote assemblies expose no off-peak tools (unsupported there).
  const offPeakToolWiring =
    options?.serviceAuthorityMode === "desktop-attached-remote"
      ? {}
      : {
          resolveOffPeakClientConfig: () => codingPlanSubscriptionService.getOffPeakClientConfig(),
          resolveOffPeakTaskService: () => offPeakTaskServiceForAgent,
        };
  const zcodeAgentService = createZCodeAgentService({
    ...(agentAccountProviderConfigSource
      ? { accountProviderConfigSource: agentAccountProviderConfigSource }
      : {}),
    accountRequestAuthService,
    ...(modelSelectionReadinessSource ? { modelSelectionReadinessSource } : {}),
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    ...offPeakToolWiring,
    // Dynamic-workflow gating, unlike off-peak,
    // never trims by serviceAuthorityMode: SSH/WSL/Docker attached hosts
    // own their workspaces and serve workflows when enabled.
    resolveDynamicWorkflowClientConfig: () =>
      codingPlanSubscriptionService.getDynamicWorkflowClientConfig(),
    ...(resolveDynamicWorkflowUserMode ? { resolveDynamicWorkflowUserMode } : {}),
    forwardDynamicWorkflowUserMode: options?.forwardDynamicWorkflowUserMode,
    commandResolver: options?.zcodeAgentCommandResolver,
    presentationSurface: resolveZCodeAgentPresentationSurface({
      runtimeSurface: options?.agentTelemetry?.runtimeSurface,
      serviceAuthorityMode: options?.serviceAuthorityMode,
      desktopContextPromptEnabled,
    }),
    onAutomationManualRunRequested: options?.onAutomationManualRunRequested,
    // createLocalServices exposes a reporter hook, but legacy assemblies never forwarded it to
    // ZCodeAgentProcessManager, so hosts never reported spawn/exit and monitors
    // saw no agents and could not verify read-only-to-write reuse.
    processLifecycleReporter: options?.processLifecycleReporter,
    spawnFallbackCwd: options?.zcodeAgentSpawnFallbackCwd,
    // browser-use: the host-to-main bridge feeds the agent service's onRequest browserExecute route.
    browserControlExecutor: options?.browserControlExecutor,
    // Bot credentials belong to the granting host; remote servers never widen reads via local config.
    channelReplyExecutor: async (value) => {
      const request = channelReplyHostRequestSchema.parse(value);
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return channelReplyResultSchema.parse(
          await options.topicResourceRelayChannel(request).call("reply", request),
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop channel reply peer unavailable");
      const bots = services.getOptional(IBotsService);
      if (!bots?.replyToChannel) throw new Error("Bot channel reply unavailable");
      return bots.replyToChannel(request);
    },
    topicResourceExecutor: async (request, signal) => {
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return readTopicResourceFromRelay(
          options.topicResourceRelayChannel(request),
          request,
          signal,
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop topic resource peer unavailable");
      const bots = services.getOptional(IBotsService);
      if (!bots?.readTopicResource) throw new Error("Topic resource service is unavailable");
      return bots.readTopicResource({ ...request, signal });
    },
    topicResourceValidator: async (request, signal) => {
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return validateTopicResourceFromRelay(
          options.topicResourceRelayChannel(request),
          request,
          signal,
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop topic resource peer unavailable");
      const bots = services.getOptional(IBotsService);
      if (!bots?.validateTopicResource)
        throw new Error("Topic resource authorization is unavailable");
      return bots.validateTopicResource({ ...request, signal });
    },
    // Official server MCP identity: the host is the sole authority; agents ask over reverse calls.
    // Provider existence reads the real Model Selection View; no legacy snapshot restore.
    officialMcpAuthHeadersResolver: createOfficialMcpAuthHeadersResolver({
      accountRequestAuthService,
      credentialService,
      modelSelectionService: providerRuntime.modelSelection,
    }),
    // The host is the identity boundary: re-verify provenance/origin here, never trusting the agent
    // adapter fetch wrapper. Share the @zcode/shared check with the CLI to avoid forks.
    // Origin resolution reuses resolveCurrentZCodeEndpointOrigin, matching off-peak (settings override
    // included) or off-peak connects while official MCP fails.
    // Pass dev flags too or the host unilaterally rejects local testing.
    officialMcpTrustedOrigins: createOfficialMcpTrustedOriginRegistry({
      devTrustedOriginsRaw: process.env[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
      resolveZCodeApiOrigin: resolveCurrentZCodeEndpointOrigin,
    }),
    cuaOperationStateReporter: shouldEnableCuaOperationStateReporter({
      serviceAuthorityMode: options?.serviceAuthorityMode,
      hasReporter: Boolean(options?.cuaOperationStateReporter),
    })
      ? options?.cuaOperationStateReporter
      : undefined,
    // ZCode publishes turn/session facts only; panel terminal policy is the producer coordinator's call.
    ...(options?.serviceAuthorityMode === "desktop-local"
      ? {
          onCuaPipSessionLifecycle: (_workspace, event) => {
            void cuaPipSessionService.publishLifecycle(event);
          },
        }
      : {}),
    // Settings HTTP proxy/No Proxy/custom CA inject into agent env at spawn,
    // covering model API/MCP/Bash egress with the user's certs; changes apply on next agent start.
    resolveSpawnEnv: async (context) => {
      const [settings] = await Promise.all([settingService.get(), providerRuntime.start()]);
      // The local host prepares resolution; remote CLIs keep their own file loader and migration.
      if (!isDesktopAttachedRemote) await subagentsService.prepareRuntimeState(context);
      const agentNetwork =
        isDesktopAttachedRemote && options?.remoteAgentNetwork
          ? options.remoteAgentNetwork
          : {
              httpProxy: settings.httpProxy,
              noProxy: settings.httpProxyNoProxy,
            };
      const cuaPluginEnabled = isCuaEnabledForContext(context);
      let cuaProductHelperEnv: Record<string, string> = {};
      if (cuaPluginEnabled && (process.platform === "darwin" || process.platform === "win32")) {
        const brokerSocket =
          process.platform === "win32" ? getStableCuaPipeName() : resolveBrokerSocketPath();
        cuaProductHelperEnv = {
          [BROKER_SOCKET_ENV]: brokerSocket,
          [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: randomBytes(16).toString("hex"),
        };
        if (process.platform === "win32") {
          const recipe = await resolveStableCuaWinRecipe();
          if (recipe) {
            cuaProductHelperEnv["ZCODE_CUA_WIN_HELPER_RECIPE"] = JSON.stringify({
              ...recipe,
              hostPid: process.pid,
            });
          } else {
            cuaProductHelperEnv = {
              [BROKER_UNAVAILABLE_ENV]:
                "broker_unavailable: windows helper recipe could not be resolved",
            };
          }
        }
      }
      const telemetryEnv = getCapturedZCodeAgentTelemetryEnv();
      const telemetryConfigured = Boolean(
        telemetryEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || telemetryEnv.OTEL_EXPORTER_OTLP_ENDPOINT,
      );
      const telemetryProfile = telemetryConfigured
        ? await oauthCredentialRepo.loadActiveUserProfile().catch(() => null)
        : null;
      const telemetryDeviceMid = telemetryConfigured
        ? options?.agentTelemetry?.getDeviceMid?.()?.trim()
        : undefined;
      // The host is the sole legacy-migration writer. Await init before agent spawn so the worker
      // never sees a missing provider_config.json nor publishes a transient empty registry.
      await providerConfigRuntime.start();
      return {
        ...buildAgentRuntimeEnv({
          httpProxy: agentNetwork.httpProxy,
          noProxy: agentNetwork.noProxy,
          caCertPath: settings.httpProxyCaCertPath,
        }),
        // Mission continuation toggle (Desktop setting -> Host env -> Agent env).
        ...(missionContinuationEnabled ? { [ZCODE_MISSION_CONTINUATION_ENV_KEY]: "1" } : {}),
        // Hand the host-resolved authoritative origin (settings included) to the agent, or the agent's
        // env-derived input diverges on test env/custom endpoints and official MCP fails closed.
        ...buildAgentEndpointOriginEnv(await resolveCurrentZCodeEndpointOrigin()),
        // Inject broker socket/token into agent env so the builtin zcode-cua plugin's
        // computer-use MCP server can restore the token via __zcode-plugin-host and connect.
        ...cuaProductHelperEnv,
        ...buildAgentTelemetrySpawnEnv({
          deviceMid: telemetryDeviceMid,
          runtimeSurface: options?.agentTelemetry?.runtimeSurface ?? "remote_workspace_host",
          telemetryEnv,
          userId: telemetryProfile?.id,
        }),
        ...createNodeProviderRuntimePathEnv({
          // Built-in Active paths are per-endpoint; never read them via a synchronous fixed
          // getter. Agent spawn waits for this round's Endpoint Source to resolve and materialize.
          zcodeBuiltinFilePath: await providerConfigRuntime.resolveZCodeBuiltinActiveFilePath(),
          personalFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        }),
      };
    },
    ...(!isDesktopAttachedRemote
      ? { readSubagentRuntimeConfig: subagentsService.readRuntimeConfig }
      : {}),
    ...(isDesktopAttachedRemote
      ? { sessionRuntimePreferencesAuthority: "external" as const }
      : {
          sessionRuntimePreferencesAuthority: "local" as const,
          resolveSessionRuntimePreferences: async (scope) => {
            // Budgets are unified; optional remote config never gates local/phone shared-host sessions.
            const settings = await settingService.get();
            const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
            return {
              askUserQuestionAutoResolutionEnabled:
                settings.askUserQuestionAutoResolutionEnabled !== false,
              nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
              memoryEnabled: settings.memoryEnabled === true,
              modelContextBudgetStrategy,
              // user-execution consumes Shell only; the shared default is a compat placeholder with one
              // result schema and never overrides the strategy fixed at materialization.
              ...(scope === "user-execution" && settings.integratedTerminalShell
                ? { integratedTerminalShell: settings.integratedTerminalShell }
                : {}),
            };
          },
        }),
  });
  providerConnectivityAgentService = zcodeAgentService;
  // A brief Helper health-probe timeout must not reap agents mid-turn. The resolver defers restarts
  // to the next request/turn boundary; a dead broker fails the turn and recovers next request.
  hasActiveTurnRef = () => zcodeAgentService.hasActiveCuaOperationTurn();
  // The desktop-continuous UI subscribes to zcodeSessionService directly, bypassing the ZCode task
  // adapter mapServiceEvent path, so task_complete never hit sqlite and spinners never stopped.
  // Assemble a shared taskIndexRepo+syncer here: any session entry wakes the shadow
  // subscription and converges terminal state into sqlite.
  const zcodeTaskIndexSyncer = createZCodeTaskIndexSyncer({
    agentService: zcodeAgentService,
    taskIndexRepo,
  });
  // The plugin can be toggled at runtime. Do not let a previously created resolver continue
  // health-checking/restarting Helper after disable, and create it lazily after enable.
  // Dynamic resolver: isPluginEnabled and Helper creation share isCuaEnabledForContext (dev parity),
  // avoiding resolver-pass-through-with-built-helper splits in dev.
  const defaultCuaProductMcpServerResolver = createDynamicCuaProductMcpServerResolver({
    isPluginEnabled: (context) => isCuaEnabledForContext(context),
    getResolver: async () => {
      // peek-only: the resolver belongs to the managed host and returns undefined when absent (lazy starts
      // run via node_repl plus the stable socket, not this resolver); never acquire here.
      const helper = defaultCuaProductHelperLifecycle.peek()?.helper;
      return helper && isDefaultCuaProductHelperCurrent(helper) ? helper.resolver : undefined;
    },
    isResolverCurrent: (resolver) =>
      defaultCuaProductHelperLifecycle.peek()?.helper.resolver === resolver,
  });
  const cuaProductMcpServerResolver =
    options?.cuaProductMcpServerResolver ?? defaultCuaProductMcpServerResolver;
  const zcodeSessionService = createZCodeSessionService({
    agentService: zcodeAgentService,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    cuaProductMcpServerResolver,
  });
  const gitCommitMessageGenerator = new GitCommitMessageGenerator({
    currentModelProvider: {
      async readCurrentModel() {
        // The git sidecar belongs to the target environment; initial model reads the same Host View
        // instead of inferring model/reasoning from transient agent workspace state.
        return (await providerRuntime.modelSelection.getView()).preferredSelection ?? null;
      },
    },
    textGenerator: {
      async generateText(params) {
        return await zcodeAgentService.generateWorkspaceText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          selection: params.selection,
          prompt: params.prompt,
          querySource: params.querySource,
        });
      },
    },
    logger: createServiceLogger("git-commit-message"),
  });
  const gitService = createGitService({
    commitMessageGenerator: gitCommitMessageGenerator,
  });
  // The ZCode task service adapter provides the wrapper; the agent server owns core session state.
  const zcodeTaskService = createZCodeTaskServiceAdapter({
    zcodeAgentService,
    taskIndexRepo,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    settingService,
    cuaProductMcpServerResolver,
  });
  const botRemoteWorkspaceService = createBotRemoteWorkspaceService({
    parentPort: options?.parentPort,
    settingService,
    credentialService,
  });
  const oauthService = createOAuthService(credentialService, {
    apiClient,
    onProviderLogout: handleOAuthProviderLogout,
  });
  const zcodeJwtLogoutLogger = createServiceLogger("zcode-jwt-logout");
  zcodeJwtLogoutHandlerRef.current = (input, headers) => {
    // Conditional exits serialize dedupe already; never drop 401s arriving for newer credentials.
    void oauthService
      .logoutIfCurrentCredentialRequest(input, headers)
      .then((invalidated) => {
        // Post-classification a relogin may exist; broadcast expiry only for queue-cleaned sessions.
        if (invalidated) {
          void broadcastService.send({
            channel: ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
            payload: {},
          });
        }
      })
      .catch((error) => {
        zcodeJwtLogoutLogger.warn("ZCode JWT logout failed", { error });
      });
  };
  // Desktop hosts used to rescan Account Providers from the settings view, bypassing
  // Registry entitlement/executable facts and failing to pick one among many plans.
  // Off-peak services and host dispatch must share one Registry-backed resolver closure.
  const offPeakCredentialResolverDeps = {
    credentialService,
    accountRequestAuthService,
    resolveAccountProvider: async () => {
      await providerRuntime.start();
      // start cached first-ready; late/switched accounts need the Registry's latest completed snapshot.
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      const providers = snapshot.resolution.registryProviders.filter(
        (candidate) =>
          candidate.config.access.type === "zhipu-account" &&
          (candidate.config.access.mode === "individual-coding-plan" ||
            candidate.config.access.mode === "team-coding-plan"),
      );
      if (providers.length !== 1) return null;
      const provider = providers[0]!;
      const config = provider.config;
      const staticAccess = zcodeProviderAccountAccessSchema.parse(config.access.toJSON());
      const access = await accountRequestAuthService.resolveAccessCurrent(staticAccess);
      if (!access) return null;
      return {
        providerId: provider.providerId,
        access: zcodeAccountAccessSchema.parse(access),
        ...(config.api?.baseUrl ? { baseURL: config.api.baseUrl } : {}),
      };
    },
  };
  const buildOffPeakRequestAuthForTicket: OffPeakRequestAuthBuilder = async (ticketId) =>
    buildOffPeakRequestAuth({
      credentials: await resolveOffPeakCredentials(offPeakCredentialResolverDeps),
      ticketId,
    });
  const fileService = createFileService({
    workspaceFileSearchFilter: options?.workspaceFileSearchFilter,
  });
  const mediaPreviewService = createMediaPreviewService({
    fileService,
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
  });
  const conversationShareClient = new ConversationShareHttpClient({
    // Share runs always hit the real API; tests/mocks inject explicitly in unit tests or web fixtures,
    // never defaulting dev to in-memory mock-share links.
    apiClient,
    baseUrl: buildRuntimeZCodeApiUrl(process.env, "/api/v1"),
    tokenProvider: async (): Promise<string | null> => {
      const activeProvider = await oauthCredentialRepo.getActiveProvider();
      if (!activeProvider) {
        return null;
      }
      const tokenSet = await oauthCredentialRepo.loadTokenSet(activeProvider);
      return tokenSet?.zcodeJwtToken ?? tokenSet?.accessToken ?? null;
    },
  });
  const conversationShareService: IConversationShareServiceType = isDesktopAttachedRemote
    ? createUnsupportedConversationShareService({
        message: "Conversation publishing is not available for remote workspaces",
      })
    : new ConversationShareService({
        zcodeAgentService,
        zcodeSessionService,
        client: conversationShareClient,
        artifactSource: createLocalConversationShareArtifactSource(),
      });
  // Lazy factories (OffPeak etc.) each open tasks-index repos; collect them here
  // and register all into sharedSqliteRepos before returning
  const sqliteReposToClose: Array<{ close(): void }> = [];
  const marketingAssets = createMarketingAssetRegistry({
    allowLoopback: ZCODE_ENV === "test" || process.env.NODE_ENV === "development",
  });
  const services = new ServiceCollection()
    .register(
      IMarketingTouchService,
      createMarketingTouchService({
        apiClient,
        getToken: () => credentialService.load("zcodejwttoken"),
        getDeviceMid: () => options?.agentTelemetry?.getDeviceMid?.(),
        baseUrl: buildRuntimeZCodeApiUrl(process.env, "/"),
        appVersion: ZCODE_VERSION,
        onSnapshot: (snapshot) => marketingAssets.accept(snapshot),
      }),
    )
    .register(IFileService, fileService)
    .register(IMediaPreviewService, mediaPreviewService)
    .register(
      ICloudContentService,
      createCloudContentService({
        publishedAssets: marketingAssets,
        cacheRoot: join(getContentAppConfigDir(), "cache", "content-bundles", randomUUID()),
      }),
    )
    .register(IGitService, gitService)
    .register(IGitCheckpointService, gitCheckpointService)
    .register(ISystemService, systemService)
    .register(ITerminalService, createTerminalService({ settingService }))
    .register(ISettingService, settingService)
    .register(IOnboardingRecordService, onboardingRecordService)
    .register(ICredentialService, credentialService)
    .register(IBroadcastService, broadcastService)
    .register(IZCodeTaskService, zcodeTaskService)
    .register(IZCodeAgentService, zcodeAgentService)
    .register(IZCodeSessionService, zcodeSessionService)
    .register(ICuaPermissionService, cuaPermissionService)
    .register(ICuaPipSessionService, cuaPipSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(
      IBotsService,
      createBotsService({
        credentialService,
        zcodeTaskService,
        broadcastService,
        settingService,
        modelSelectionService: providerRuntime.modelSelection,
        remoteWorkspaceService: botRemoteWorkspaceService,
        // Remote and local bots read their own environment's Model Selection View.
        // Remote startup no longer polls legacy presets, avoiding a second candidate truth.
        runStartupBackgroundTasks: !isDesktopAttachedRemote,
      }),
    )
    .register(IFileWatcherService, createFileWatcherService())
    .register(IOAuthService, oauthService)
    .register(
      IUsageStatsService,
      createUsageStatsService({
        apiClient,
        accountRequestAuthService,
        credentialService,
        zcodeAgentService,
        officialMcpCredentialSource,
      }),
    )
    .register(ICodingPlanSubscriptionService, codingPlanSubscriptionService)
    .register(
      IClientConfigService,
      createClientConfigService({
        apiClient,
        resolveRequestContext: async () => ({
          endpointOrigin: await resolveCurrentZCodeEndpointOrigin(),
          appVersion: ZCODE_VERSION,
          platform: `${process.platform}-${process.arch}`,
        }),
      }),
    )
    .register(IClientScenesService, createClientScenesService({ apiClient }))
    .register(
      IOffPeakTaskService,
      (() => {
        // Off-peak orchestration (independent of the automation surface):
        // this collection owns the singleton; renderers connect via ProxyChannel and host dispatch gets the same instance.
        const offPeakLogger = createServiceLogger("off-peak");
        const resolveCredentials = () => resolveOffPeakCredentials(offPeakCredentialResolverDeps);
        const originResolver = createOffPeakOriginResolver({
          logger: offPeakLogger,
          resolveUpstream: () => resolveOffPeakMockUpstream(offPeakCredentialResolverDeps),
        });
        const offPeakTaskRepo = new OffPeakTaskRepo();
        // OffPeakTaskRepo also holds a tasks-index handle; collect it and register once services exist
        // (factories run during registration, before the services constant exists).
        sqliteReposToClose.push(offPeakTaskRepo);
        const offPeakTaskService = new OffPeakTaskService({
          repo: offPeakTaskRepo,
          client: createOffPeakServerClient({
            resolveOrigin: originResolver.resolveOrigin,
            resolveCredentials,
            logger: offPeakLogger,
          }),
          resolveCodingPlanSupport: () =>
            resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps),
          resolveTelemetryProviderName: async () =>
            resolveSafeTelemetryHostname(await originResolver.resolveOrigin()),
          resolveModelSelection: async (input) => {
            await providerRuntime.start();
            const support = await resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps);
            const providerId = support.supported
              ? OFF_PEAK_PROVIDER_IDS[support.providerFamily]
              : undefined;
            const provider = providerId
              ? providerRuntime.registryService
                  .getView()
                  .providers.find((candidate) => candidate.providerId === providerId)
              : undefined;
            const modelId = input.modelId ?? provider?.models[0]?.modelId;
            if (!provider || !modelId) {
              return {
                ok: false as const,
                validation: {
                  ok: false as const,
                  code: "provider-not-found" as const,
                  providerId: OFF_PEAK_PROVIDER_IDS.zai,
                },
              };
            }
            // Legacy rows carry no provider identity; reuse the account chain's adjudicated family,
            // never guessing Z.ai vs BigModel from registry/JSON order.
            const selection = {
              providerId: provider.providerId,
              modelId,
              ...(input.reasoningLevel
                ? { options: { reasoningLevel: input.reasoningLevel } }
                : {}),
            };
            const validation = providerRuntime.registryService.validateSelection(selection);
            return validation.ok
              ? { ok: true as const, selection }
              : { ok: false as const, validation };
          },
          logger: offPeakLogger,
          requestSchedulerWake: options?.onOffPeakSchedulerWakeRequested,
          stopRunningTask: async (params) => {
            await zcodeTaskService.stopGeneration({
              taskId: params.conversationId,
              workspacePath: params.workspacePath,
              ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            });
          },
          onDispose: () => {
            void originResolver.close().catch(() => undefined);
          },
        });
        offPeakTaskService.startSync();
        // Writeback forward ref for zcodeAgentService offPeak/create and offPeak/list handlers.
        offPeakTaskServiceForAgent = offPeakTaskService;
        return offPeakTaskService;
      })(),
    )
    .register(
      IHighspeedCardService,
      (() => {
        const origin = resolveRuntimeZCodeEndpointOrigin(process.env);
        const rawMockScenario = process.env.ZCODE_HIGHSPEED_MOCK_SCENARIO;
        const mockScenarios = new Set<HighspeedMockScenario>([
          "hit-fast",
          "miss",
          "hit-after-timeout",
          "existing-foreign-task-card",
          "expired-card",
        ]);
        const mockScenario = mockScenarios.has(rawMockScenario as HighspeedMockScenario)
          ? (rawMockScenario as HighspeedMockScenario)
          : null;
        const resolveHighspeedLoginHeaders = async (): Promise<Record<string, string>> => {
          const jwt = (await credentialService.load("zcodejwttoken"))?.trim() ?? "";
          if (!jwt) throw new Error("highspeed request requires zcode jwt");
          return { Authorization: /^Bearer\s/i.test(jwt) ? jwt : `Bearer ${jwt}` };
        };
        const transport = mockScenario
          ? createHighspeedMockTransport({ scenario: mockScenario })
          : createHighspeedHttpTransport({
              drawUrl: `${origin}/api/v1/highspeed/draw`,
              healthyBaseUrl: `${origin}/api/v1/highspeed/`,
              logger: createServiceLogger("highspeed"),
              drawHeaders: async () => {
                const credentials = await resolveOffPeakCredentials(offPeakCredentialResolverDeps, {
                  allowMockCredentials: false,
                });
                const codingPlanAuthorization =
                  (
                    await credentialService.load(`oauth:${credentials.providerFamily}:access_token`)
                  )?.trim() ?? "";
                return buildHighspeedCodingPlanAuthHeaders({
                  zcodeJwt: credentials.jwt,
                  codingPlanAuthorization,
                  targetType:
                    credentials.organizationId && credentials.projectId ? "TEAM" : "PERSONAL",
                  ...(credentials.organizationId
                    ? { organizationId: credentials.organizationId }
                    : {}),
                  ...(credentials.projectId ? { projectId: credentials.projectId } : {}),
                });
              },
              healthyHeaders: resolveHighspeedLoginHeaders,
            });
        return new HighspeedCardService({
          transport,
          inferenceMode: mockScenario ? "session-default" : "highspeed",
          // Rule 11: draws are Coding-Plan-only; mock passes for local verification.
          resolveCodingPlanSupported: mockScenario
            ? async () => true
            : async () =>
                (await resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps)).supported,
          // Rule 14: the session model must sit in the selected provider's catalog (built-in
          // config projection) before a new draw; mock passes locally.
          resolveModelCovered: mockScenario
            ? async () => true
            : async (providerId, modelId) => {
                const view = await providerRuntime.modelSelection.getView();
                const provider = view.providers.find((item) => item.providerId === providerId);
                return provider?.models.some((model) => model.modelId === modelId) ?? false;
              },
          // Highspeed shares the draw gateway and dual-JWT contract: it needs
          // zcode JWT + plan JWT + team header. The old zcode-JWT+card-id combo left entitlements
          // unchecked, hence 401 auth_failed. Reuse the draw's selected-connection
          // resolution so ZAI cards never hit the BigModel highspeed provider.
          resolveInferenceAuth: async () => {
            const credentials = await resolveOffPeakCredentials(offPeakCredentialResolverDeps, {
              allowMockCredentials: false,
            });
            const codingPlanAuthorization =
              (
                await credentialService.load(`oauth:${credentials.providerFamily}:access_token`)
              )?.trim() ?? "";
            return {
              zcodeJwt: credentials.jwt,
              family: credentials.providerFamily,
              codingPlanAuthorization,
              targetType: credentials.organizationId && credentials.projectId ? "TEAM" : "PERSONAL",
              ...(credentials.organizationId ? { organizationId: credentials.organizationId } : {}),
              ...(credentials.projectId ? { projectId: credentials.projectId } : {}),
            };
          },
        });
      })(),
    )
    .register(ISkillsService, skillsService)
    .register(ISkillSyncService, createSkillSyncService())
    .register(IMcpSyncService, mcpSyncService)
    .register(
      IGenUiService,
      createGenUiService({ registerSandbox: options?.registerPluginSandbox }),
    )
    .register(IPluginUiBridgeService, pluginUiBridgeService)
    .register(IPluginUiSamplingService, pluginUiSamplingService)
    .register(IPluginUiAppToolsService, pluginUiAppToolsService)
    // The MCP/plugin-management merge dropped the plugin-sync registration;
    // RemoteServiceAccess still calls it, timing out candidate enumeration.
    .register(IPluginSyncService, pluginSyncService)
    .register(IPluginsService, createPluginsService({ isDesktopRuntime: true }))
    // Thin settings-page plugin service: the host-side consumer of legacy plugins/* verbs.
    .register(IPluginManagementService, createPluginManagementService({ zcodeAgentService }))
    .register(ISubagentsService, subagentsService)
    .register(ICommandsService, createCommandsService({ isDesktopRuntime: true }))
    .register(
      IHooksService,
      createHooksService({
        grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
      }),
    )
    .register(IMemoryService, createMemoryService())
    .register(IOutputStyleService, createOutputStyleService())
    .register(ISettingsSyncService, createSettingsSyncService({ settingService }))
    .register(
      IFeedbackService,
      createFeedbackService({
        ...options?.feedback,
        apiClient,
        credentialService,
        oauthService,
      }),
    )
    .register(IPromptAttachmentTransferService, createLocalPromptAttachmentTransferService());

  // Register the lifecycle disposer even when disabled: the terminal fence must precede any late
  // setting/acquire; no-helper-yet never means no-owner. Dispose stops the host serially.
  registerManagedCuaHelperHostForDispose(services, {
    stop: async () => {
      await defaultCuaProductHelperLifecycle.dispose();
    },
  });
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);
  // Warmup queues only after the disposer registers: a throw mid-assembly must not orphan a
  // high-privilege Helper created later; immediate dispose lets the fence precede acquire.
  // Lazy start, no warmup: the SDK's first CUA call spawns the Helper (stable socket via
  // spawn env) or an explicit grant does. Zero resident Helpers at boot.

  accountRequestAuthServices.set(services, accountRequestAuthService);
  offPeakRequestAuthBuilders.set(services, buildOffPeakRequestAuthForTicket);

  providerRuntimes.set(services, providerRuntime);
  providerProvisioningSources.set(services, providerProvisioningSource);
  providerProvisioningTriggerDisposers.set(services, providerProvisioningDisposers);
  services
    .register(IProviderSettingsService, providerRuntime.providerSettings)
    .register(IModelSelectionService, providerRuntime.modelSelection);
  if (isDesktopAttachedRemote || options.providerProvisioningTargetEnabled === true) {
    services.register(
      IProviderProvisioningTargetService,
      createProviderProvisioningTarget({
        providerRuntime,
        personalRepository: providerConfigRuntime.personalRepository,
        accountProviderSource: accountProviderConfigSource,
        credentialService,
        settingService,
        personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        stateFilePath: join(resolveAppConfigDir(), "runtime", "provider", "provisioning.json"),
        listProvisioningCredentialKeys: () =>
          listProviderProvisioningCredentialKeys(resolveCredentialFilePath(resolveAppConfigDir())),
      }),
    );
  }
  const log = createServiceLogger("provider-runtime");
  void providerRuntime.start().then(
    () => {
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      log.info("Provider registry ready", {
        configRevision: snapshot.sourceRevisions.config,
        providerCount: snapshot.registry.providers.length,
      });
    },
    (error: unknown) => {
      log.error("Provider config facts initialization failed", error);
    },
  );

  // See sharedSqliteRepos: register every tasks-index handle for coordinated close.
  sqliteReposToClose.push(taskIndexRepo);
  sharedSqliteRepos.set(services, sqliteReposToClose);
  return services;
}

export function createTelemetryUserIdLoader(
  credentialService: Pick<ICredentialService, "load">,
): () => Promise<string> {
  const log = createServiceLogger("telemetry-user-id");
  return async () => {
    try {
      const activeProvider = (await credentialService.load("oauth:active_provider"))?.trim() ?? "";
      if (!activeProvider) {
        return "";
      }

      const rawUserInfo = await credentialService.load(`oauth:${activeProvider}:user_info`);
      return readTelemetryOAuthUserId(rawUserInfo);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      // Bugfix: telemetry is a read-only userId reporter and must not half-clean corrupt
      // credentials before the host OAuthService, or derived provider keys skip logout.
      log.warn(undefined, "skip telemetry user id: OAuth credential decrypt failed", error);
      return "";
    }
  };
}

/** Returns the current ZCode JWT for the event's account only; no caching, no mutation. */
export function createTelemetryAuthorizationLoader(
  credentialService: Pick<ICredentialService, "load">,
): (userId: string) => Promise<string | null> {
  return async (userId) => {
    if (!userId) return null;
    try {
      const provider = (await credentialService.load("oauth:active_provider"))?.trim();
      if (provider !== "zai" && provider !== "bigmodel") return null;
      const readUserId = async () =>
        readTelemetryOAuthUserId(await credentialService.load(`oauth:${provider}:user_info`));
      if ((await readUserId()) !== userId) return null;
      const jwt = (await credentialService.load("zcodejwttoken"))?.trim();
      // Logout/switch can land mid-read: never attach an old identity's token to another account's event.
      if (
        (await credentialService.load("oauth:active_provider"))?.trim() !== provider ||
        (await readUserId()) !== userId
      )
        return null;
      return jwt && /^[\x21-\x7e]+$/.test(jwt) ? `Bearer ${jwt}` : null;
    } catch {
      return null;
    }
  };
}

export function createTelemetryMarketingParamsLoader(
  credentialService: ICredentialService,
): () => Promise<import("@zcode/shared").OAuthLoginAttribution | null> {
  // Restored: a constant null lost saved channel attribution; the warehouse reads OAuth's truth.
  const repo = new OAuthCredentialRepo(credentialService);
  return () => repo.loadLoginAttribution();
}

function readTelemetryOAuthUserId(rawUserInfo: string | null): string {
  if (!rawUserInfo) {
    return "";
  }

  try {
    const parsed = JSON.parse(rawUserInfo) as {
      id?: unknown;
      user_id?: unknown;
    };
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
    return id.trim() || userId.trim();
  } catch {
    return "";
  }
}

export function disposeServiceResources(services: ServiceCollection): void {
  const content = services.getOptional(ICloudContentService);
  if (content && hasDisposeAllAndWait(content)) void content.disposeAllAndWait().catch(() => {});
  (
    services.getOptional(IGenUiService) as (IGenUiService & { dispose?(): void }) | undefined
  )?.dispose?.();
  // Bugfix: host exit never swept local services for cleanup,
  // leaving child-spawning services to process-exit timing and brief residue.
  // Call every local disposeAll here so app-exit mechanically reclaims all managed resources.
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(ISubagentsService),
    services.getOptional(IOffPeakTaskService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // Sync best-effort: stop managed Computer Use Helpers without awaiting the dispose path.
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    void managedCuaHelperHost.stop().catch(() => {});
  }
  // Close shared tasks-index handles (live handles make later dir cleanup EBUSY on Windows)
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  managedHostApiNetworkTransports.get(services)?.dispose();
}

export async function disposeServiceResourcesAndWait(services: ServiceCollection): Promise<void> {
  (
    services.getOptional(IGenUiService) as (IGenUiService & { dispose?(): void }) | undefined
  )?.dispose?.();
  // On app close the host waits out the agent tree graceful+force cleanup.
  // Sync dispose dropped force-kill timers, orphaning zcode-cli/app-server.
  const disposableServices = [
    services.getOptional(ICloudContentService),
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(ISubagentsService),
    services.getOptional(IOffPeakTaskService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAllAndWait(service)) {
      await service.disposeAllAndWait();
    } else if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // Await managed Helper exit (best-effort): long-lived privileged Helpers need explicit
  // shutdown, not launcher-pid watchdogs or process-exit luck.
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    await managedCuaHelperHost.stop().catch(() => {});
  }
  // Close shared tasks-index handles here too (async path mirrors disposeServiceResources).
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  await managedHostApiNetworkTransports
    .get(services)
    ?.disposeAndWait()
    .catch(() => {});
}
export { localRuntimeNetworkCapture } from "./zcode-agent/localRuntimeNetworkCapture.js";
