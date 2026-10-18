/* eslint-disable max-lines -- the command manager keeps list, form and external import together; splitting raises cross-state jump costs. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { CommandConfig, UserCommand, ZCodeCommand } from "@zcode/shared";
import { isPluginCommand, isUserCommand, ZCODE_COMMAND_AGENT_SOURCE } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useCommands } from "@/hooks/useCommands.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { CommandCard, isEditableUserCommand } from "@/settings/CommandCard.js";
import { CommandForm } from "@/settings/CommandForm.js";
import { getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import { CommandsImportDialog } from "@/settings/ExternalAgentImportDialog.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { groupCommandsByPlugin } from "@/settings/pluginManagedResourceGroups.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import { resolvePluginDisplayName } from "@/settings/pluginStoreListing.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import {
  selectCommandsForScope,
  selectPluginsForScope,
} from "@/settings/pluginCapabilityProjection.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  resolveCommandScopeRecovery,
  resolveCommandStorageTarget,
  shouldRefreshCurrentCommandList,
} from "@/settings/commandWorkspaceScope.js";

interface CommandsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  scopeFilter: "user" | "workspace";
  parentScopeKey: string;
  workspaceTabs: WorkspaceTabState[];
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
  onEditorOpenChange?: (open: boolean) => void;
  onFormScopeKeyChange?: (scopeKey: string | null) => void;
}

export function CommandsSection({
  workspacePath,
  workspaceIdentity,
  scopeFilter,
  parentScopeKey,
  workspaceTabs,
  searchQuery,
  onVisibleCountChange,
  onEditorOpenChange,
  onFormScopeKeyChange,
}: CommandsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();

  const currentWorkspaceKey = workspaceIdentity?.trim() || workspacePath || "";
  const currentWorkspaceTab = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === currentWorkspaceKey,
  );
  // The list receives workspacePath per scope target, but command/plugin services still come from the
  // active ServiceProvider, sending B's paths to A's remote host. Both resolve via the target,
  // pausing RPC until connected, never falling back to the active workspace's service.
  const listServiceResolution = useWorkspaceServicesResolution(
    currentWorkspaceTab?.workspacePath ?? workspacePath,
    currentWorkspaceTab?.remoteSessionId,
    currentWorkspaceTab?.workspaceIdentity ?? workspaceIdentity,
    currentWorkspaceTab?.remoteTarget,
  );
  const { commandsService, pluginManagementService, settingsSyncService } =
    listServiceResolution.services;

  const {
    commands,
    capability,
    loading,
    error,
    operatingCommandId,
    projectionMatchesTarget,
    refresh,
    deleteCommand,
    toggleCommand,
  } = useCommands({
    workspacePath: workspacePath ?? undefined,
    workspaceIdentity,
    commandsService,
    enabled: listServiceResolution.rpcReady,
  });

  const [showForm, setShowForm] = useState(false);
  const [editingCommand, setEditingCommand] = useState<UserCommand | null>(null);
  const [saving, setSaving] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [formScopeKey, setFormScopeKey] = useState(parentScopeKey);
  const formTargetWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === formScopeKey,
  );
  const formServiceTarget = formTargetWorkspace ?? currentWorkspaceTab;
  const formServiceResolution = useWorkspaceServicesResolution(
    formServiceTarget?.workspacePath ?? workspacePath,
    formServiceTarget?.remoteSessionId,
    formServiceTarget?.workspaceIdentity ?? workspaceIdentity,
    formServiceTarget?.remoteTarget,
  );
  const formServices = formServiceResolution.services;

  useEffect(() => {
    const recovery = resolveCommandScopeRecovery({
      editing: Boolean(editingCommand),
      scopeKey: formScopeKey,
      workspaceTabs,
    });
    if (recovery === "keep") return;
    // Never write to a closed workspace's path; create falls back to User, edit exits.
    if (recovery === "close-editor") {
      setEditingCommand(null);
      setShowForm(false);
      return;
    }
    setFormScopeKey("user");
  }, [editingCommand, formScopeKey, workspaceTabs]);

  const plugins = usePluginManagementStore((state) => state.plugins);
  const pluginStoreWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const pluginStoreWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const pluginConfigScope = usePluginManagementStore((state) => state.configScope);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);

  useEffect(() => {
    if (!workspacePath || !listServiceResolution.rpcReady) return;
    void initializePlugins({
      workspacePath,
      workspaceIdentity,
      configScope: scopeFilter,
      pluginService: pluginManagementService,
    });
  }, [
    initializePlugins,
    listServiceResolution.rpcReady,
    pluginManagementService,
    scopeFilter,
    workspaceIdentity,
    workspacePath,
  ]);

  const handleSave = useCallback(
    async (config: CommandConfig, scopeKey: string) => {
      setSaving(true);
      try {
        const { storageLevel, workspace: targetWorkspace } = resolveCommandStorageTarget(
          scopeKey,
          workspaceTabs,
        );
        const targetWorkspacePath =
          storageLevel === "project" ? targetWorkspace?.workspacePath : undefined;
        if (storageLevel === "project" && !targetWorkspacePath) {
          throw new Error("Selected Workspace is no longer available");
        }
        if (editingCommand) {
          await formServices.commandsService.updateCommandFile({
            agentSource: editingCommand.agentSource,
            commandId: editingCommand.id,
            config,
            oldFilePath: editingCommand.filePath,
            storageLevel,
            workspacePath: targetWorkspacePath,
          });
        } else {
          await formServices.commandsService.writeCommandFile({
            config,
            agentSource: ZCODE_COMMAND_AGENT_SOURCE,
            storageLevel,
            workspacePath: targetWorkspacePath,
          });
        }
        if (shouldRefreshCurrentCommandList(scopeKey, currentWorkspaceKey)) {
          await refresh();
        }
        setShowForm(false);
        setEditingCommand(null);
        setFormScopeKey("user");
      } catch (saveError) {
        const message = saveError instanceof Error ? saveError.message : String(saveError);
        if (message.includes("exists") || message.includes("already")) {
          toast(
            intl.formatMessage(
              { id: "forms.validation.fileExists" },
              { fileName: `${config.name.replace(/^\//, "")}.md` },
            ),
          );
        } else {
          toast(message);
        }
      } finally {
        setSaving(false);
      }
    },
    [
      currentWorkspaceKey,
      editingCommand,
      formServices.commandsService,
      intl,
      refresh,
      workspaceTabs,
    ],
  );

  const handleDelete = useCallback(
    async (command: ZCodeCommand) => {
      if (!isEditableUserCommand(command)) {
        return;
      }
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.commands.delete.title" }),
        description: intl.formatMessage(
          { id: "settings.commands.delete.description" },
          { name: command.name },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) {
        return;
      }
      try {
        await deleteCommand({
          agentSource: command.agentSource,
          commandId: command.id,
          filePath: command.filePath,
        });
        setEditingCommand(null);
        setShowForm(false);
      } catch (deleteError) {
        const message = deleteError instanceof Error ? deleteError.message : String(deleteError);
        toast(message);
      }
    },
    [confirmDialog, deleteCommand, intl],
  );

  const handleToggle = useCallback(
    async (command: ZCodeCommand, enabled: boolean) => {
      if (!isUserCommand(command)) {
        return;
      }
      try {
        await toggleCommand({
          agentSource: command.agentSource,
          commandId: command.id,
          filePath: command.filePath,
          enabled,
        });
      } catch (toggleError) {
        const message = toggleError instanceof Error ? toggleError.message : String(toggleError);
        toast(message);
      }
    },
    [toggleCommand],
  );

  const handleEdit = useCallback(
    (command: ZCodeCommand) => {
      if (!isEditableUserCommand(command)) {
        return;
      }
      setFormScopeKey(command.scope === "project" ? parentScopeKey : "user");
      setEditingCommand(command);
      setShowForm(false);
    },
    [parentScopeKey],
  );

  const handleAddNew = useCallback(() => {
    setFormScopeKey(parentScopeKey);
    setEditingCommand(null);
    setShowForm(true);
  }, [parentScopeKey]);

  const handleCancelForm = useCallback(() => {
    setFormScopeKey("user");
    setShowForm(false);
    setEditingCommand(null);
  }, []);

  const handleFormScopeKeyChange = useCallback(
    (scopeKey: string) => {
      setFormScopeKey(scopeKey);
      onFormScopeKeyChange?.(scopeKey);
    },
    [onFormScopeKeyChange],
  );

  // pluginManagementStore is a global singleton; the Plugins tab's PluginList and this page
  // initialize it alternately with different targets when effectiveCommandScopeKey differs from selectedScopeKey.
  // PluginList guards via storeKey!==targetKey; reuse the same pattern so plugin-contributed
  // command groups never briefly take another target's plugin projection.
  const pluginStoreMatchesTarget =
    (pluginStoreWorkspaceIdentity?.trim() || pluginStoreWorkspacePath || "") ===
      currentWorkspaceKey && pluginConfigScope === scopeFilter;
  const scopedPlugins = useMemo(
    () =>
      pluginStoreMatchesTarget ? selectPluginsForScope(plugins, installedPlugins, scopeFilter) : [],
    [installedPlugins, plugins, pluginStoreMatchesTarget, scopeFilter],
  );
  const scopedCommands = useMemo(
    () => selectCommandsForScope(commands, scopedPlugins, scopeFilter),
    [commands, scopeFilter, scopedPlugins],
  );
  const groupedCommands = useMemo(
    () => groupCommandsByPlugin(scopedCommands, searchQuery),
    [scopedCommands, searchQuery],
  );
  const filteredCommandCount = groupedCommands.local.length + groupedCommands.plugin.length;
  useEffect(() => {
    onVisibleCountChange?.(filteredCommandCount);
  }, [filteredCommandCount, onVisibleCountChange]);
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const pluginCommandGroups = useMemo(() => {
    const groups = new Map<string, typeof groupedCommands.plugin>();
    for (const command of groupedCommands.plugin) {
      const key = `${command.pluginName.trim()}@${command.pluginMarketplace.trim()}`;
      groups.set(key, [...(groups.get(key) ?? []), command]);
    }
    return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [groupedCommands.plugin]);
  const hasEmptySearchResult = Boolean(searchQuery.trim()) && filteredCommandCount === 0;
  const directInstalledCommandCount = scopedCommands.filter(isUserCommand).length;
  const hideInstalledGroup = Boolean(searchQuery.trim()) && groupedCommands.local.length === 0;

  const renderCommandList = (items: ZCodeCommand[]) => (
    <SettingsResourceList
      items={items}
      getKey={(command) => command.id}
      renderItem={(command) => (
        <CommandCard
          command={command}
          onEdit={isEditableUserCommand(command) ? handleEdit : undefined}
          onToggle={isUserCommand(command) ? handleToggle : undefined}
          isOperating={operatingCommandId === command.id}
          pluginIconItem={
            isPluginCommand(command)
              ? {
                  name: command.pluginName,
                  listing: pluginListingById.get(
                    `${command.pluginName.trim()}@${command.pluginMarketplace.trim()}`,
                  ),
                }
              : undefined
          }
        />
      )}
    />
  );

  const isFormView = showForm || editingCommand !== null;
  useEffect(() => {
    onEditorOpenChange?.(isFormView);
    onFormScopeKeyChange?.(isFormView ? formScopeKey : null);
    return () => {
      onEditorOpenChange?.(false);
      onFormScopeKeyChange?.(null);
    };
  }, [formScopeKey, isFormView, onEditorOpenChange, onFormScopeKeyChange]);
  if (isFormView) {
    return (
      <div className="space-y-6">
        <SettingsBreadcrumbReporter
          items={[
            {
              label: editingCommand?.name ?? intl.formatMessage({ id: "settings.commands.addNew" }),
            },
          ]}
          onSectionSelect={handleCancelForm}
        />
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-ui-xl font-semibold text-foreground">
              {editingCommand
                ? intl.formatMessage({ id: "settings.commands.edit" })
                : intl.formatMessage({ id: "settings.commands.addNew" })}
            </h3>
            <p className="text-ui-base text-foreground-subtle">
              {editingCommand
                ? intl.formatMessage({
                    id: "settings.commands.editDescription",
                  })
                : intl.formatMessage({
                    id: "settings.commands.addDescription",
                  })}
            </p>
          </div>

          <CommandForm
            initial={editingCommand ?? undefined}
            agentSource={editingCommand?.agentSource ?? ZCODE_COMMAND_AGENT_SOURCE}
            scopeKey={formScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={handleFormScopeKeyChange}
            onSave={handleSave}
            onCancel={handleCancelForm}
            onDelete={editingCommand ? handleDelete : undefined}
            saving={saving}
          />
        </div>
      </div>
    );
  }

  const headerActions = (
    <SettingsResourceHeaderActions
      onRefresh={() => void refresh()}
      onImport={() => setImportDialogOpen(true)}
      onNew={handleAddNew}
      importDisabled={!capability?.userScopeAvailable}
    />
  );

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {!listServiceResolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : loading || !projectionMatchesTarget ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasEmptySearchResult ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.plugin.commands.searchEmpty",
          })}
        />
      ) : (
        <div className="space-y-6">
          <section className={hideInstalledGroup ? "hidden" : "space-y-4"}>
            <SettingsResourceGroupHeader
              actions={headerActions}
              count={groupedCommands.local.length}
              title={intl.formatMessage({
                id: "settings.plugin.commands.installed",
              })}
            />
            {groupedCommands.local.length > 0 ? (
              renderCommandList(groupedCommands.local)
            ) : directInstalledCommandCount === 0 && !searchQuery.trim() ? (
              <PluginInstallEmptyState
                title={intl.formatMessage({
                  id: "settings.plugin.commands.emptyInstalledTitle",
                })}
                description={intl.formatMessage({
                  id: "settings.plugin.commands.emptyInstalledDescription",
                })}
                actions={
                  <Button type="button" variant="default" size="lg" onClick={handleAddNew}>
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    {intl.formatMessage({ id: "settings.create.action" })}
                  </Button>
                }
              />
            ) : null}
          </section>
          {pluginCommandGroups.map(([pluginId, items]) => (
            <section key={pluginId} className="space-y-4">
              <SettingsResourceGroupHeader
                count={items.length}
                title={resolvePluginDisplayName(
                  {
                    name: items[0]?.pluginName ?? pluginId,
                    listing: pluginListingById.get(pluginId),
                  },
                  locale,
                )}
              />
              {renderCommandList(items)}
            </section>
          ))}
        </div>
      )}
      <CommandsImportDialog
        open={importDialogOpen && listServiceResolution.rpcReady}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        settingsSyncService={settingsSyncService}
        onOpenChange={setImportDialogOpen}
        onImported={refresh}
      />
    </div>
  );
}
