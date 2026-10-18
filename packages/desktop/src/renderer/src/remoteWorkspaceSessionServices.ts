import type { IServiceAccessor } from "@zcode/services";

export function buildRemoteWorkspaceSessionServices(
  baseServices: IServiceAccessor,
  remoteServices: IServiceAccessor,
): IServiceAccessor {
  return {
    ...baseServices,
    fileService: remoteServices.fileService,
    mediaPreviewService: remoteServices.mediaPreviewService,
    gitService: remoteServices.gitService,
    gitCheckpointService: remoteServices.gitCheckpointService,
    systemService: remoteServices.systemService,
    terminalService: remoteServices.terminalService,
    // Remote attachments must be uploaded/path-rewritten by the current workspace host; local services would
    // hand desktop absolute paths to the SSH/WSL/Docker CLI, leaving attachments unreadable.
    promptAttachmentTransferService: remoteServices.promptAttachmentTransferService,
    // MCP/plugin status checks run on the zcodeAgentService control-plane app-server.
    // Reusing the local base service for SSH would check remote MCP config in the local app-server, whose
    // PATH/cwd are not the remote environment; sync would keep reporting spawn npx ENOENT.
    zcodeAgentService: remoteServices.zcodeAgentService,
    zcodeTaskService: remoteServices.zcodeTaskService,
    zcodeSessionService: remoteServices.zcodeSessionService,
    // Share uses local login/API, but Rows and files must bind to the current remote connection scope.
    conversationShareService: remoteServices.conversationShareService,
    fileWatcherService: remoteServices.fileWatcherService,
    // Provider/model facts belong to the target Environment; merge spreading baseServices first must not fall back to local.
    modelSelectionService: remoteServices.modelSelectionService,
    providerSettingsService: remoteServices.providerSettingsService,
    // SSH/Docker project skills/plugins/commands dirs live on the remote filesystem.
    // The old local-base path scanned locally with a remote workspacePath, so project-level features read nothing.
    skillsService: remoteServices.skillsService,
    // Remote skill sync imports must write the SSH host's ~/.zcode/skills.
    // On the base service the UI reports success while files land in the local ~/.zcode/skills.
    skillSyncService: remoteServices.skillSyncService,
    // Remote MCP sync imports must write the SSH host's ~/.zcode/cli/config.json.
    // Like skillSyncService, route via the remote service; never write remote config into the local user dir.
    mcpSyncService: remoteServices.mcpSyncService,
    // Remote plugin sync writes the SSH host's ~/.zcode/plugins and plugins.dirs;
    // like skills/MCP it must go through the remote service, not the local base.
    pluginSyncService: remoteServices.pluginSyncService,
    pluginsService: remoteServices.pluginsService,
    // Settings plugin management likewise targets the remote pluginsService (plugin dirs are remote).
    pluginManagementService: remoteServices.pluginManagementService,
    commandsService: remoteServices.commandsService,
    // SSH/Docker workspace hook declarations, trust state, and pending reviews live on the remote filesystem.
    // hooksService must override the local base service, else remote paths scan the local FS and
    // pending remote hooks become unreadable.
    // Hook load/save and grantWorkspaceHookTrust must both target the remote host.
    hooksService: remoteServices.hooksService,
  };
}

export function buildServerRemoteWorkspaceSessionServices(
  _baseServices: IServiceAccessor,
  remoteServices: IServiceAccessor,
): IServiceAccessor {
  // A server-remote connection attaches to a fully running ZCode server; workspace/runtime/
  // model-provider state is the server's word, and the local renderer keeps only window and UI
  // shell state.
  return remoteServices;
}
