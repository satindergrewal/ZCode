/* eslint-disable max-lines -- the CUA page orchestrates the plugin master switch, two permission states and the post-grant recovery chain; split later. */
// Settings > Computer Use section:
// one master toggle enabling/disabling the zcode-cua plugin (with its MCP server and skill).
// On macOS, two permission rows (Accessibility / Screen Recording) with grant guidance and stale recovery.
// Reuses SettingsGroupCard / SettingsRow / SettingsBadge / Switch, matching the other sections.
//
// Helper permission state runs through useCuaPermissionStatus: event-driven (page enter / window focus / explicit refresh),
// one query each, no timed polling; state lives in a shared cache shared with the composer-entry button.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSettings } from "@/hooks/useSettingService.js";
import type { CuaOsSupport, CuaPermissionKind, RemoteTarget } from "@zcode/shared";
import {
  DesktopCommandIds,
  isRemoteWorkspaceIdentity,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
} from "@zcode/shared";
import { isCuaPermissionStatusAvailable, type CuaPermissionRestartOptions } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { Switch } from "@/components/ui/switch.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCuaPermissionStatus } from "@/hooks/useCuaPermissionStatus.js";
import {
  claimCuaPermissionReturnRecovery,
  completeCuaPermissionReturnRecovery,
  captureCuaPermissionReturnRecovery,
  createCuaPermissionReturnRecoveryState,
  isCuaPermissionReturnRecoveryCurrent,
  markCuaPermissionOnboardingOpened,
  shouldRestartHelperAfterCuaPermissionReturn,
  type CuaPermissionReturnRecoveryClaim,
} from "@/lib/cuaPermissionAction.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { SettingsBadge, SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { StatusDot, type StatusDotTone } from "@/settings/StatusDot.js";
import { supportsLocalMacCuaPermissionOnboarding } from "@/lib/cuaPlatform.js";
import { runAfterSuccessfulPluginEnabledChange } from "@/settings/pluginEnabledChange.js";
import { createCuaPermissionOnboardingOperationId } from "@/lib/cuaPermissionOnboardingOperation.js";
import { waitForAccessibilityNotStale } from "@/settings/cuaPermissionRestartVerify.js";
import { requiredCuaPermissionsForFreshStatus } from "@/settings/cuaPermissionPreparation.js";
import { ExternalLink } from "lucide-react";
import {
  isComputerUseRemoteOrLinux,
  resolveComputerUseAvailability,
} from "@/settings/computerUseAvailability.js";

interface ComputerUseSectionProps {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  // On the SSH-remote settings page workspacePath is the remote path; local Helper queries need the local workspace path.
  localWorkspacePath?: string | null;
}

export function ComputerUseSection({
  isDesktop = false,
  isMacDesktop,
  isWindowsDesktop = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  localWorkspacePath,
}: ComputerUseSectionProps) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const platform = usePlatform();
  const pluginManagementService = services.pluginManagementService;
  // cuaPermissionService is optional in main (remote hosts have no CUA); every handler below early-returns when missing.
  const cuaPermissionService = services.cuaPermissionService;
  const isLocalWorkspace =
    !remoteSessionId &&
    !remoteTarget &&
    !(workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim()));
  // Windows reuses only the master switch; TCC permissions, helper state and extra settings are macOS capabilities.
  const supportsLocalMacWorkspace =
    !isWindowsDesktop &&
    (isMacDesktop ?? supportsLocalMacCuaPermissionOnboarding(platform)) &&
    isLocalWorkspace;
  const supportsLocalWindowsWorkspace = isWindowsDesktop && isLocalWorkspace;
  const supportsComputerUseSettings = supportsLocalMacWorkspace || supportsLocalWindowsWorkspace;
  const availability = resolveComputerUseAvailability({
    isDesktop: isDesktop || isWindowsDesktop || supportsLocalMacWorkspace,
    isMacDesktop: isMacDesktop || supportsLocalMacWorkspace,
    isWindowsDesktop,
    remoteSessionId,
    remoteTarget,
    workspaceIdentity,
  });
  // CUA permissions are local-macOS state; only the full macOS page needs the Helper workspace path.
  const path = supportsLocalMacWorkspace ? (localWorkspacePath ?? workspacePath) : null;
  // Render from settled only: fresh falls back to false at every query start, and following it makes the grant button's copy
  // flip between verifying and terminal states, jumping width.
  const { status, settled, refresh } = useCuaPermissionStatus(path ?? null, workspaceIdentity);
  const availableStatus = status && isCuaPermissionStatusAvailable(status) ? status : null;

  // macOS version floor: on older systems LaunchServices rejects the Helper with -10825, appearing as grants that never respond.
  // Query the main-process verdict once (GetCuaOsSupport); below the floor, render the notice card and hide the grant actions.
  // Query failure counts as no floor and never blocks the page; useCuaPermissionStatus polling stays, only the entry hides.
  const [osSupport, setOsSupport] = useState<CuaOsSupport | null>(null);
  useEffect(() => {
    if (!supportsLocalMacWorkspace || typeof platform.executeDesktopCommand !== "function") return;
    let cancelled = false;
    void platform
      .executeDesktopCommand(DesktopCommandIds.GetCuaOsSupport)
      .then((result) => {
        if (!cancelled) setOsSupport(result as CuaOsSupport);
      })
      .catch(() => {
        /* query failed: treat as no floor, never block the page */
      });
    return () => {
      cancelled = true;
    };
  }, [supportsLocalMacWorkspace, platform]);

  const macOsBelowCuaFloor = osSupport?.kind === "macos-below-minimum";

  // Master switch = zcode-cua plugin enabled state (from the plugin store; toggling enables/disables plugin + MCP + skill).
  const plugins = usePluginManagementStore((state) => state.plugins);
  const setPluginEnabled = usePluginManagementStore((state) => state.setEnabled);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const cuaPlugin = plugins.find((plugin) => plugin.id === ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  const cuaEnabled = cuaPlugin?.enabled ?? false;
  const cuaToggling = togglingPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID;

  const initRef = useRef(false);
  useEffect(() => {
    if (
      initRef.current ||
      !supportsComputerUseSettings ||
      !workspacePath ||
      !pluginManagementService
    )
      return;
    initRef.current = true;
    // Reuse the Plugins section's init path so the store has zcode-cua's enabled state.
    void initializePlugins({
      workspacePath,
      workspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [
    supportsComputerUseSettings,
    workspacePath,
    workspaceIdentity,
    pluginManagementService,
    initializePlugins,
  ]);

  const [restarting, setRestarting] = useState(false);
  // Restart single-flight: the grant-return callback, double click and manual button share one operation; no concurrent broker rotations.
  const restartPromiseRef = useRef<Promise<boolean> | null>(null);
  const pendingGrantSessionIdRef = useRef<string | undefined>(undefined);
  const returnRecoveryRef = useRef(createCuaPermissionReturnRecoveryState());
  useEffect(() => {
    returnRecoveryRef.current = createCuaPermissionReturnRecoveryState(
      workspaceIdentity?.trim() || path || "<none>",
    );
    pendingGrantSessionIdRef.current = undefined;
  }, [path, workspaceIdentity]);
  // Still stale after the Helper restart -> show the Restart ZCode fallback; self-clears when accessibility turns granted.
  const [verifyTimedOut, setVerifyTimedOut] = useState(false);
  // Unmount guard: skip setState when the component unmounted during fetch/restart/toggle.
  const mountedRef = useRef(true);
  const pluginToggleGenerationRef = useRef(0);
  const pluginToggleContextKey = [
    workspacePath ?? "",
    workspaceIdentity ?? "",
    localWorkspacePath ?? "",
    remoteSessionId ?? "",
    remoteTarget ? "remote" : "local",
  ].join("\u0000");
  const pluginToggleContextKeyRef = useRef(pluginToggleContextKey);
  pluginToggleContextKeyRef.current = pluginToggleContextKey;
  const helperContextKey = [path ?? "", workspaceIdentity?.trim() ?? ""].join("\u0000");
  const helperContextKeyRef = useRef(helperContextKey);
  helperContextKeyRef.current = helperContextKey;
  const activeOnboardingOperationIdRef = useRef<string | null>(null);
  const permissionStatusCheckTokenRef = useRef<symbol | null>(null);
  const platformRef = useRef(platform);
  platformRef.current = platform;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pluginToggleGenerationRef.current += 1;
      permissionStatusCheckTokenRef.current = null;
      const operationId = activeOnboardingOperationIdRef.current;
      activeOnboardingOperationIdRef.current = null;
      if (operationId) {
        platformRef.current.cancelCuaPermissionOnboarding?.(operationId);
      }
    };
  }, []);

  // The same page instance switching workspaces must also exit the old participant, or the old call's return restores the wrong Helper.
  useEffect(
    () => () => {
      permissionStatusCheckTokenRef.current = null;
      const operationId = activeOnboardingOperationIdRef.current;
      activeOnboardingOperationIdRef.current = null;
      if (operationId) {
        platformRef.current.cancelCuaPermissionOnboarding?.(operationId);
      }
    },
    [path, workspaceIdentity],
  );

  const onRestart = useCallback(
    (
      targetPath = path,
      targetWorkspaceIdentity = workspaceIdentity,
      restartOptions?: CuaPermissionRestartOptions,
    ): Promise<boolean> => {
      if (!targetPath || !services || !cuaPermissionService) return Promise.resolve(false);
      if (restartPromiseRef.current) return restartPromiseRef.current;
      const targetContextKey = [targetPath, targetWorkspaceIdentity?.trim() ?? ""].join("\u0000");
      if (helperContextKeyRef.current === targetContextKey) {
        setVerifyTimedOut(false);
      }
      setRestarting(true);
      const operation = (async (): Promise<boolean> => {
        let queuedActiveProbe = false;
        try {
          const result = await cuaPermissionService.restartHelper(
            targetPath,
            targetWorkspaceIdentity,
            restartOptions,
          );
          if (!result.ok && mountedRef.current) {
            toast(
              intl.formatMessage(
                { id: "cuaPermission.modal.restartFailed" },
                { error: result.reason ?? "unknown error" },
              ),
            );
            return false;
          }
          if (!result.ok) return false;

          // A healthy helper socket does not mean tccd state has propagated; short-poll to confirm the stale clears.
          const stillStale = await waitForAccessibilityNotStale(() =>
            cuaPermissionService.getStatus(targetPath, targetWorkspaceIdentity),
          );
          // The workspace may switch mid-grant; the old op still finishes its side effects but must not pollute the new page's upgrade hint.
          if (mountedRef.current && helperContextKeyRef.current === targetContextKey) {
            setVerifyTimedOut(stillStale);
            // Background permission polls stay read-only; real screen capture only follows explicit grant-return/restart.
            // Restart single-flight already merged same-Helper recoveries; schedule one proactive probe here;
            // the hook keeps merging focus/refresh so macOS privacy capture never double-triggers.
            refresh({ includeFunctionalProbes: true });
            queuedActiveProbe = true;
          }
          return true;
        } catch (error) {
          if (mountedRef.current) {
            toast(
              intl.formatMessage(
                { id: "cuaPermission.modal.restartFailed" },
                {
                  error: error instanceof Error ? error.message : String(error),
                },
              ),
            );
          }
          return false;
        } finally {
          restartPromiseRef.current = null;
          if (mountedRef.current) {
            setRestarting(false);
            // The failure path stays read-only refresh; success scheduled exactly one proactive probe on the current workspace.
            if (!queuedActiveProbe) refresh();
          }
        }
      })();
      restartPromiseRef.current = operation;
      return operation;
    },
    [path, workspaceIdentity, services, refresh, intl],
  );

  const applyPendingGrant = useCallback(
    async (
      expectedClaim?: CuaPermissionReturnRecoveryClaim,
      target?: { workspacePath: string; workspaceIdentity?: string },
      onboardingSessionId?: string,
    ): Promise<boolean> => {
      const claim = expectedClaim ?? captureCuaPermissionReturnRecovery(returnRecoveryRef.current);
      if (!claim || !isCuaPermissionReturnRecoveryCurrent(claim.state, claim)) {
        return false;
      }
      // If a restart is already running pre-grant, wait it out, then start a Helper that truly postdates the grant.
      const existing = restartPromiseRef.current;
      if (existing) await existing;
      if (!isCuaPermissionReturnRecoveryCurrent(claim.state, claim)) return false;
      // Grant started on A, switched to B: the result still belongs to A's runtime on this renderer/host. Use the identity
      // captured at click for the required restart; only display refreshes follow current props, never dropping side effects on generation change.
      const ok = await onRestart(target?.workspacePath, target?.workspaceIdentity, {
        reason: "permission_granted",
        ...((onboardingSessionId ?? pendingGrantSessionIdRef.current)
          ? {
              onboardingSessionId: onboardingSessionId ?? pendingGrantSessionIdRef.current,
            }
          : {}),
      });
      completeCuaPermissionReturnRecovery(claim, ok);
      return ok;
    },
    [onRestart],
  );

  // Fallback: still stale after Helper restarts, one click restarts ZCode (same RelaunchApp as OAuth sign-out).
  // The fresh ZCode process cleanly re-launches the Helper, bypassing a restart mechanism stuck in this process (orphans/sockets/state).
  const onRelaunchApp = useCallback(async () => {
    if (typeof platform.executeDesktopCommand !== "function") return;
    await platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp);
  }, [platform]);

  const onTogglePlugin = useCallback(
    async (next: boolean) => {
      if (!pluginManagementService) return;
      const operationGeneration = ++pluginToggleGenerationRef.current;
      const operationContextKey = pluginToggleContextKey;
      // Toggling zcode-cua enables/disables its MCP server and skill together.
      const completed = await runAfterSuccessfulPluginEnabledChange({
        submit: () => setPluginEnabled(ZCODE_CUA_OFFICIAL_PLUGIN_ID, next, pluginManagementService),
        isCurrent: () =>
          mountedRef.current &&
          pluginToggleGenerationRef.current === operationGeneration &&
          pluginToggleContextKeyRef.current === operationContextKey,
        onSuccess: () => {
          if (supportsLocalMacWorkspace) {
            // Permission state and the manual grant entry live only on the macOS Computer Use page. Enabling must not auto-open
            // the macOS Permissions modal; refresh state instead, never interrupting the user's flow.
            refresh();
          }
          if (!next) {
            toast(intl.formatMessage({ id: "settings.computerUse.disabledToast" }));
          }
        },
      });
      if (!completed && mountedRef.current) {
        const message = usePluginManagementStore.getState().error;
        if (message) {
          toast(message);
        }
      }
    },
    [
      path,
      pluginManagementService,
      pluginToggleContextKey,
      refresh,
      setPluginEnabled,
      supportsLocalMacWorkspace,
      intl,
    ],
  );

  // Open macOS System Settings to grant the specific permission (Accessibility / Screen Recording).
  const openPermissionSettings = useCallback(
    async (initialPermission: CuaPermissionKind): Promise<void> => {
      if (
        typeof platform.openCuaPermissionOnboarding !== "function" ||
        activeOnboardingOperationIdRef.current ||
        permissionStatusCheckTokenRef.current
      ) {
        return;
      }
      const checkToken = Symbol("cua-permission-status-check");
      permissionStatusCheckTokenRef.current = checkToken;
      const operationContextKey = helperContextKey;
      let operationId: string | null = null;
      const recoveryState = returnRecoveryRef.current;
      const recoveryTarget = path
        ? {
            workspacePath: path,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          }
        : null;
      try {
        if (!path || !cuaPermissionService) {
          toast(intl.formatMessage({ id: "cuaPermission.modal.unavailable" }));
          return;
        }
        // Row buttons once trusted lastKnown; a grant completed in another window or an in-flight refresh
        // still opened a stale pane. Re-query on the click edge, admitting only the exact denied/stale item.
        let currentStatus = await cuaPermissionService.getStatus(path, workspaceIdentity, {
          includeFunctionalProbes: false,
        });
        // After returning from System Settings the app restarts the Helper before new TCC grants read; in that window queries
        // return unavailable (clicking right after granting degrades the precheck to cannot-confirm-yet
        // instead of granted). Retry unavailable twice at 2s; once the Helper is ready it resolves to granted
        // or a real missing-permission branch; guards failing meanwhile (unmount/double click/context switch) give up, no more retries.
        for (
          let attempt = 0;
          attempt < 2 && !isCuaPermissionStatusAvailable(currentStatus);
          attempt += 1
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          if (
            !mountedRef.current ||
            permissionStatusCheckTokenRef.current !== checkToken ||
            helperContextKeyRef.current !== operationContextKey ||
            returnRecoveryRef.current !== recoveryState
          ) {
            return;
          }
          currentStatus = await cuaPermissionService.getStatus(path, workspaceIdentity, {
            includeFunctionalProbes: false,
          });
        }
        // A concurrent commit may already hold the A-to-B workspace update while passive effects have not cleaned up A.
        // The render-phase context ref is the only reliable invalidation in that window; yield one macrotask before deciding,
        // so a late A state never opens the native settings pane for B.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (
          !mountedRef.current ||
          permissionStatusCheckTokenRef.current !== checkToken ||
          helperContextKeyRef.current !== operationContextKey ||
          returnRecoveryRef.current !== recoveryState
        ) {
          return;
        }
        if (
          !isCuaPermissionStatusAvailable(currentStatus) ||
          !requiredCuaPermissionsForFreshStatus(currentStatus).includes(initialPermission)
        ) {
          const permissionState = isCuaPermissionStatusAvailable(currentStatus)
            ? initialPermission === "accessibility"
              ? currentStatus.accessibility
              : currentStatus.screenRecording
            : null;
          toast(
            intl.formatMessage({
              id:
                permissionState === "granted"
                  ? "cuaPermission.grantAlreadySatisfied"
                  : "cuaPermission.modal.unavailable",
            }),
          );
          refresh();
          return;
        }
        operationId = createCuaPermissionOnboardingOperationId();
        activeOnboardingOperationIdRef.current = operationId;
        const result = await platform.openCuaPermissionOnboarding({
          initialPermission,
          operationId,
          requiredPermissions: [initialPermission],
        });
        if (
          !mountedRef.current ||
          activeOnboardingOperationIdRef.current !== operationId ||
          helperContextKeyRef.current !== operationContextKey
        ) {
          return;
        }
        if (shouldRestartHelperAfterCuaPermissionReturn(result)) {
          markCuaPermissionOnboardingOpened(recoveryState);
          pendingGrantSessionIdRef.current = result.sessionId;
          const claim = claimCuaPermissionReturnRecovery(recoveryState);
          if (claim && recoveryTarget) {
            void applyPendingGrant(claim, recoveryTarget, result.sessionId);
          }
        } else if (result?.success && result.returnedFromSettings) {
          // Repeated joins of the main session from one renderer just refresh; each window gets its own host recovery.
          refresh();
        }
        if (result?.success === false && !result.canceled) {
          toast(
            intl.formatMessage(
              { id: "chat.cuaPermission.openFailed" },
              { error: result.error ?? "unknown error" },
            ),
          );
        }
      } catch (error) {
        if (
          mountedRef.current &&
          permissionStatusCheckTokenRef.current === checkToken &&
          helperContextKeyRef.current === operationContextKey
        ) {
          toast(
            operationId
              ? intl.formatMessage(
                  { id: "chat.cuaPermission.openFailed" },
                  {
                    error: error instanceof Error ? error.message : String(error),
                  },
                )
              : intl.formatMessage({ id: "cuaPermission.modal.unavailable" }),
          );
        }
      } finally {
        if (permissionStatusCheckTokenRef.current === checkToken) {
          permissionStatusCheckTokenRef.current = null;
        }
        if (operationId && activeOnboardingOperationIdRef.current === operationId) {
          activeOnboardingOperationIdRef.current = null;
        }
      }
    },
    [platform, path, services, workspaceIdentity, intl, applyPendingGrant, refresh],
  );

  const onManualRestart = useCallback((): void => {
    void (returnRecoveryRef.current.pending ? applyPendingGrant() : onRestart());
  }, [applyPendingGrant, onRestart]);

  // Self-healing: once accessibility reads granted in any later query, clear the Restart ZCode fallback (problem solved).
  useEffect(() => {
    if (availableStatus?.accessibility === "granted") setVerifyTimedOut(false);
  }, [availableStatus?.accessibility]);

  const renderGrantDetail = (kind: CuaPermissionKind, labelId: string): ReactNode => {
    if (typeof platform.openCuaPermissionOnboarding !== "function") return null;
    return (
      <Button
        type="button"
        variant="link"
        size="sm"
        className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
        aria-label={intl.formatMessage({ id: labelId })}
        title={intl.formatMessage({ id: labelId })}
        disabled={!settled}
        onClick={() => void openPermissionSettings(kind)}
      >
        <ExternalLink className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">
          {intl.formatMessage({
            id: settled ? labelId : "cuaPermission.status.verifying",
          })}
        </span>
      </Button>
    );
  };

  // Permission state -> { dot tone, label }, one source for both (granted green / stale yellow / denied red / unknown gray).
  // TCC granted pins the granted display; the functional probe only gates runtime readiness and
  // no longer flips the display to verifying on every poll (ending the granted-verifying flip-flop).
  const statusView = (
    state: "granted" | "stale" | "denied" | "unknown" | undefined,
  ): { tone: StatusDotTone; text: string } => {
    if (state === "granted") {
      return {
        tone: "green",
        text: intl.formatMessage({ id: "cuaPermission.status.granted" }),
      };
    }
    if (state === "stale") {
      // Legacy-Helper compat only: process lag or an old ad-hoc CDHash row; offer both restart and re-grant.
      return {
        tone: "amber",
        text: intl.formatMessage({ id: "cuaPermission.status.stale" }),
      };
    }
    if (state === "denied") {
      return {
        tone: "red",
        text: intl.formatMessage({ id: "cuaPermission.status.missing" }),
      };
    }
    return {
      tone: "muted",
      text: intl.formatMessage({ id: "cuaPermission.status.unknown" }),
    };
  };

  // A legacy Helper's stale may be process cache or an old ad-hoc CDHash; restart and verify first, and on failure keep
  // both the re-grant entry and the Restart ZCode fallback, never reading a single-restart-unfixable state as solved.
  const renderRestartDetail = (): ReactNode => (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={restarting || !path}
        onClick={onManualRestart}
      >
        {restarting
          ? intl.formatMessage({ id: "cuaPermission.modal.restarting" })
          : intl.formatMessage({ id: "cuaPermission.modal.restartButton" })}
      </Button>
      {verifyTimedOut && !restarting ? (
        <div className="flex flex-col items-start gap-1">
          <span className="text-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "cuaPermission.modal.relaunchAppHint" })}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void onRelaunchApp()}>
            {intl.formatMessage({
              id: "cuaPermission.modal.relaunchAppButton",
            })}
          </Button>
        </div>
      ) : null}
    </div>
  );

  // Both permissions' status views (dot tone + label) from one source, so text and color never diverge.
  const acc = statusView(availableStatus?.accessibility);
  const screenPerm = statusView(availableStatus?.screenRecording);

  // Visibility of the composer-entry toggle. The hidden flag writes via useSettings().update
  // (a direct settingService call persists without refreshing the shared snapshot, which the composer button reads).
  // Optimistic local toggle; roll back with a notice on failure.
  const { settings: appSettings, update: updateAppSettings } = useSettings();
  const [composerEntryHiddenOverride, setComposerEntryHiddenOverride] = useState<boolean | null>(
    null,
  );
  const [composerEntrySaving, setComposerEntrySaving] = useState(false);
  // Hidden by default, same rule as useCuaComposerEntry: only an explicit false counts as shown.
  // Both sides must agree, or the settings switch's state diverges from the composer button's real visibility.
  const persistedComposerEntryHidden = appSettings?.computerUseComposerEntryHidden !== false;
  const composerEntryVisible = !(composerEntryHiddenOverride ?? persistedComposerEntryHidden);
  useEffect(() => {
    if (composerEntryHiddenOverride === null) return;
    if (persistedComposerEntryHidden === composerEntryHiddenOverride) {
      setComposerEntryHiddenOverride(null);
    }
  }, [composerEntryHiddenOverride, persistedComposerEntryHidden]);
  const onToggleComposerEntry = useCallback(
    async (visible: boolean) => {
      const nextHidden = !visible;
      setComposerEntryHiddenOverride(nextHidden);
      setComposerEntrySaving(true);
      try {
        await updateAppSettings({ computerUseComposerEntryHidden: nextHidden });
      } catch (error) {
        if (mountedRef.current) {
          setComposerEntryHiddenOverride(null);
          toast(
            intl.formatMessage(
              { id: "settings.computerUse.composerEntry.saveFailed" },
              { error: error instanceof Error ? error.message : String(error) },
            ),
          );
        }
      } finally {
        if (mountedRef.current) setComposerEntrySaving(false);
      }
    },
    [intl, updateAppSettings],
  );

  // Product rule: while denied, the status badge itself is clickable,
  // equivalent to Open System Settings; granted/stale/unknown stay display-only.
  const renderPermissionBadge = (
    kind: CuaPermissionKind,
    view: { tone: StatusDotTone; text: string },
    state: "granted" | "stale" | "denied" | "unknown" | undefined,
  ): ReactNode => {
    const clickable = state === "denied";
    const badge = (
      <SettingsBadge>
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={view.tone} />
          {view.text}
        </span>
      </SettingsBadge>
    );
    if (!clickable) return badge;
    return (
      <button
        type="button"
        className="cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={view.text}
        onClick={() => void openPermissionSettings(kind)}
      >
        {badge}
      </button>
    );
  };

  if (!supportsComputerUseSettings) {
    // On remote/Linux a bare null return would leave a title-only page reading as a load failure.
    // Keep the entry, state the capability boundary, and render no control that writes local CUA state.
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-ui-base text-warning">
        <p className="font-medium">
          {intl.formatMessage({ id: "settings.computerUse.unsupported.title" })}
        </p>
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id: isComputerUseRemoteOrLinux(availability)
              ? availability.kind === "local-linux"
                ? "settings.computerUse.unsupported.linuxDescription"
                : "settings.computerUse.unsupported.remoteDescription"
              : "settings.computerUse.unsupported.remoteDescription",
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Master switch: enable/disable the zcode-cua plugin (with its MCP + skill) */}
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.computerUse.toggleLabel" })}
          description={intl.formatMessage({
            id: "settings.computerUse.toggleDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.computerUse.toggleLabel",
              })}
              checked={cuaEnabled}
              disabled={cuaToggling || !workspacePath}
              onCheckedChange={(checked) => void onTogglePlugin(checked)}
            />
          }
        />
        Visibility toggle for the composer entry: off persists a hidden marker that neither restarts
        nor upgrades heal. It only gates the button's render, never the plugin state or running
        tasks. With Computer Use off the button never renders (cuaComposerEntryState's plugin gate),
        so the switch greys out with copy explaining the precondition; a clickable switch with no
        visible effect reads as broken.
        <SettingsRow
          label={intl.formatMessage({ id: "settings.computerUse.composerEntry.label" })}
          description={intl.formatMessage({
            id: cuaEnabled
              ? "settings.computerUse.composerEntry.description"
              : "settings.computerUse.composerEntry.requiresEnabled",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.computerUse.composerEntry.label",
              })}
              checked={composerEntryVisible}
              disabled={composerEntrySaving || !cuaEnabled}
              onCheckedChange={(checked) => void onToggleComposerEntry(checked)}
            />
          }
        />
      </SettingsGroupCard>

      {/* While CUA is disabled hide the permission config below, master switch only; no wall of disabled rows. */}
      {cuaEnabled && supportsLocalMacWorkspace ? (
        <>
          Below the Helper's promised macOS floor, grants cannot complete (LaunchServices rejects
          the Helper with -10825); the whole card becomes an upgrade notice.
          {macOsBelowCuaFloor ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              <p className="font-medium">
                {intl.formatMessage(
                  { id: "cuaPermission.osFloorTitle" },
                  {
                    minimum: osSupport?.minimumMacOs ?? "12.0",
                    current: osSupport?.currentMacOs ?? "12 or below",
                  },
                )}
              </p>
              <p>{intl.formatMessage({ id: "cuaPermission.osFloorDescription" })}</p>
            </div>
          ) : null}
          {/* macOS permission guidance stays in Settings; CUA actions and tool approvals no longer auto-pop the permission modal. */}
          {!macOsBelowCuaFloor ? (
            <SettingsGroupCard>
              <SettingsRow
                controlLayout="wide"
                label={intl.formatMessage({
                  id: "cuaPermission.perm.accessibility",
                })}
                description={intl.formatMessage({
                  id: "cuaPermission.perm.accessibility.purpose",
                })}
                control={renderPermissionBadge(
                  "accessibility",
                  acc,
                  availableStatus?.accessibility,
                )}
                detail={
                  availableStatus?.accessibility === "granted"
                    ? undefined
                    : availableStatus?.accessibility === "stale"
                      ? renderRestartDetail()
                      : renderGrantDetail("accessibility", "chat.cuaPermission.openAccessibility")
                }
              />
              <SettingsRow
                controlLayout="wide"
                label={intl.formatMessage({
                  id: "cuaPermission.perm.screenRecording",
                })}
                description={intl.formatMessage({
                  id: "cuaPermission.perm.screenRecording.purpose",
                })}
                control={renderPermissionBadge(
                  "screen_recording",
                  screenPerm,
                  availableStatus?.screenRecording,
                )}
                detail={
                  availableStatus?.screenRecording === "granted"
                    ? undefined
                    : renderGrantDetail(
                        "screen_recording",
                        "chat.cuaPermission.openScreenRecording",
                      )
                }
              />
            </SettingsGroupCard>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
