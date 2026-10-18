/**
 * Hooks barrel export
 *
 * Every service/platform hook is exported from here.
 * Components reach services through hooks, never services.* or window.zcode.* directly.
 */

// Service context
export { ServiceProvider, useServices } from "./useServices.js";
export { useBaseWorkspaceServices, useWorkspaceServices } from "./useWorkspaceServices.js";

// Platform-operations context
export {
  PlatformProvider,
  usePlatform,
  useSelectDirectory,
  useConnectRemote,
} from "./usePlatform.js";

// File service
export { useReaddir } from "./useFileService.js";

// File watcher service
export { useWatchedReaddir } from "./useFileWatcherService.js";

// System service
export { useSystemInfo, useIntranetProbe } from "./useSystemService.js";
export { useWorkspaceHomePath } from "./useWorkspaceHomePath.js";

// Terminal service
export { useTerminal } from "./useTerminalService.js";

// Settings service
export { useSettings, useRecentProjects } from "./useSettingService.js";
export { useSkills } from "./useSkills.js";
export { usePlugins } from "./usePlugins.js";

// Onboarding record service (local persistence, uploaded to the server later)
export { useOnboardingRecordService } from "./useOnboardingRecordService.js";

// Generic confirm dialog
export { useConfirmDialog } from "./useConfirmDialog.js";
export { useAlertDialog } from "./useAlertDialog.js";

// Credentials service
export { useCredentials, useAuthToken } from "./useCredentials.js";
export { useZCodeAgentService } from "./useZCodeAgentService.js";

// Git pane
export { useGitAutoRefresh } from "./useGitAutoRefresh.js";
export { useGitRepository } from "./useGitRepository.js";
export { useGitActions } from "./useGitActions.js";
// Workspace provider configuration paths
export { useTaskNativeSessionLogFile } from "./useTaskNativeSessionLogFile.js";
export { useTaskSessionFilePath } from "./useTaskSessionFilePath.js";
export { useUsageStats } from "./useUsageStats.js";
