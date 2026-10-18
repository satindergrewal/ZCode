import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { UpdateStatusDialog } from "@/UpdateStatusDialog.js";
import { formatUpdateReleaseDate, getLocalizedUpdateReleaseNotes } from "@/updateReleaseNotes.js";
import {
  deriveUpdateStatusViewModel,
  isUpdateActionCompleted,
  type UpdateActionInFlight,
  type UpdateStatusViewModel,
} from "@/updateStatusModel.js";

export function UpdateStatusDialogController({
  platform,
  version,
  updateState,
  open,
  onOpenChange,
  edgeToEdge = false,
  showOverlay = true,
}: {
  platform: IPlatformService;
  version: string | null;
  updateState: UpdateStatePayload | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  edgeToEdge?: boolean;
  showOverlay?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const [autoDownloadAndInstallUpdates, setAutoDownloadAndInstallUpdates] = useState(false);
  const [updateActionInFlight, setUpdateActionInFlightState] = useState<UpdateActionInFlight>(null);
  const updateActionInFlightRef = useRef<typeof updateActionInFlight>(null);
  const releaseNotesCacheRef = useRef(
    new Map<
      string,
      {
        releaseDateLabel: string | null;
        releaseNotes: { title: string; markdown: string };
      }
    >(),
  );
  const setUpdateActionInFlight = useCallback((nextAction: typeof updateActionInFlight) => {
    updateActionInFlightRef.current = nextAction;
    setUpdateActionInFlightState(nextAction);
  }, []);
  const updateStatusViewModel = deriveUpdateStatusViewModel({
    legacyReadyVersion: version,
    updateState,
  });
  const lastVisibleUpdateStatusViewModelSelection = useRef<UpdateStatusViewModel | null>(null);
  const renderedUpdateStatusViewModel =
    updateStatusViewModel.displayVersion || updateActionInFlight === null
      ? updateStatusViewModel
      : (lastVisibleUpdateStatusViewModelSelection.current ?? updateStatusViewModel);
  const {
    dialogPhase,
    displayVersion,
    progressLabel,
    progressValue,
    releaseNotesPayload: updateReleaseNotesPayload,
    skippableVersion,
  } = renderedUpdateStatusViewModel;
  const localizedUpdateReleaseNotes = getLocalizedUpdateReleaseNotes(
    updateReleaseNotesPayload,
    locale,
  );
  const formattedReleaseDate = formatUpdateReleaseDate(
    updateReleaseNotesPayload?.releaseDate,
    locale,
  );
  const releaseNotesCacheKey = displayVersion ? `${locale}:${displayVersion}` : null;

  useEffect(() => {
    if (!updateStatusViewModel.displayVersion) {
      return;
    }

    // Real download progress arrives via async broadcasts from main. Transitional version-less
    // checking/idle states must not return null and unmount the open dialog; while a command is
    // in flight reuse the last visible model until a progress state lands.
    lastVisibleUpdateStatusViewModelSelection.current = updateStatusViewModel;
  }, [updateStatusViewModel]);

  useEffect(() => {
    let disposed = false;

    const refreshAutoUpdatePreferences = () => {
      void platform
        .getAutoUpdatePreferences?.()
        .then((preferences) => {
          if (!disposed) {
            setAutoDownloadAndInstallUpdates(preferences.autoDownloadAndInstallUpdates);
          }
        })
        .catch(() => {
          if (!disposed) {
            setAutoDownloadAndInstallUpdates(false);
          }
        });
    };

    refreshAutoUpdatePreferences();
    const disposeSettingsChanged =
      platform.onSettingsChanged?.(refreshAutoUpdatePreferences) ?? (() => {});

    return () => {
      disposed = true;
      disposeSettingsChanged();
    };
  }, [platform]);

  useEffect(() => {
    if (!releaseNotesCacheKey || !localizedUpdateReleaseNotes) {
      return;
    }

    // Downloading hides the release notes, but electron-updater's update-downloaded event only
    // reliably carries the version on some platforms. Cache the current notes so they can be
    // shown again after the download even if ready lacks releaseNotes.
    releaseNotesCacheRef.current.set(releaseNotesCacheKey, {
      releaseDateLabel: formattedReleaseDate,
      releaseNotes: localizedUpdateReleaseNotes,
    });
    if (releaseNotesCacheRef.current.size > 8) {
      const oldestCacheKey = releaseNotesCacheRef.current.keys().next().value;
      if (oldestCacheKey) {
        releaseNotesCacheRef.current.delete(oldestCacheKey);
      }
    }
  }, [formattedReleaseDate, localizedUpdateReleaseNotes, releaseNotesCacheKey]);

  const cachedReleaseNotes = releaseNotesCacheKey
    ? releaseNotesCacheRef.current.get(releaseNotesCacheKey)
    : undefined;
  const restoredUpdateReleaseNotes =
    localizedUpdateReleaseNotes ?? cachedReleaseNotes?.releaseNotes ?? null;
  const restoredReleaseDate = formattedReleaseDate ?? cachedReleaseNotes?.releaseDateLabel ?? null;
  const visibleUpdateReleaseNotes =
    dialogPhase === "downloading" ? null : restoredUpdateReleaseNotes;
  const handleOpenReleaseNotesExternalUrl = useCallback(
    (url: string) => platform.openExternal(url),
    [platform],
  );
  const handleDownloadUpdate = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    // When electron-updater hits the local cache, main broadcasts update-downloaded directly.
    // The renderer must not optimistically flip to downloading around the IPC ACK — that flashes
    // a meaningless 0%. Lock the button only; the phase follows main's broadcasts.
    setUpdateActionInFlight("download");
    try {
      await platform.downloadUpdate();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [platform, setUpdateActionInFlight]);
  const handleAutoDownloadAndInstallUpdatesChange = useCallback(
    async (enabled: boolean) => {
      setAutoDownloadAndInstallUpdates(enabled);
      await platform.setAutoDownloadAndInstallUpdates?.(enabled);
      if (enabled && updateState?.kind === "update-available") {
        // Checking auto-download in the update-available dialog means this version too. Trigger
        // the same download entry; the real download, cache hits and broadcasts stay main's call.
        await handleDownloadUpdate();
      }
    },
    [handleDownloadUpdate, platform, updateState?.kind],
  );
  const handleCancelDownload = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    setUpdateActionInFlight("cancel");
    try {
      await platform.cancelUpdateDownload();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [platform, setUpdateActionInFlight]);
  const handleSkipUpdate = useCallback(async () => {
    if (!skippableVersion || updateActionInFlightRef.current) {
      return;
    }
    setUpdateActionInFlight("skip");
    try {
      await platform.skipUpdateVersion(skippableVersion);
      onOpenChange(false);
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [onOpenChange, platform, setUpdateActionInFlight, skippableVersion]);
  const handleRestartUpdate = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    const activity = await platform.getDesktopSessionActivity?.();
    const runningTaskCount = activity?.runningAgentSessionCount ?? 0;
    if (runningTaskCount > 0) {
      const confirmed = await requestConfirmation({
        title: intl.formatMessage(
          { id: "updateReady.confirm.title" },
          {
            version: displayVersion ?? "",
          },
        ),
        description: intl.formatMessage({
          id: "updateReady.confirm.description",
        }),
        confirmLabel: intl.formatMessage({ id: "updateReady.confirm.ok" }),
        cancelLabel: intl.formatMessage({ id: "updateReady.confirm.cancel" }),
      });
      if (!confirmed) {
        return;
      }
    }

    // Restart-and-install used to be fire-and-forget: the renderer closed the dialog right
    // after the IPC. In dev/mock, when the updater never takes over, the dialog vanishing reads
    // as a dead button.
    setUpdateActionInFlight("restart");
    try {
      await platform.quitAndInstallUpdate();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [displayVersion, intl, platform, requestConfirmation, setUpdateActionInFlight]);

  useEffect(() => {
    if (!displayVersion && updateState !== null) {
      onOpenChange(false);
    }
  }, [displayVersion, onOpenChange, updateState]);

  useEffect(() => {
    if (!updateActionInFlight) {
      return;
    }

    if (isUpdateActionCompleted(updateActionInFlight, updateState)) {
      setUpdateActionInFlight(null);
      return;
    }

    // Quit preparation and the Windows installer handoff can exceed 5s; the old shared ACK
    // timer re-enabled restart-to-update before the app exited, reading as failure and inviting
    // repeat clicks. Success stays pending until exit; only a rejected IPC restores the button
    // via the caller's catch.
    if (updateActionInFlight === "restart") {
      if (updateState !== null && updateState.kind !== "update-downloaded") {
        // Main broadcasts error/idl if quit prep fails. Even if the IPC rejection is lost to
        // window teardown, once state leaves ready the button must release — never eternal pending.
        setUpdateActionInFlight(null);
      }
      return;
    }

    // Download/cancel IPC ACKs immediately; truth arrives via later broadcasts. Lock the button
    // against double clicks, with a short-timeout fallback so a lost broadcast or main no-op
    // never wedges the UI.
    const timeout = globalThis.setTimeout(() => {
      setUpdateActionInFlight(null);
    }, 1500);

    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, [setUpdateActionInFlight, updateActionInFlight, updateState?.kind]);

  if (!displayVersion) return null;

  const releaseDateLabel = restoredReleaseDate
    ? intl.formatMessage({ id: "updateDialog.releaseDate" }, { date: restoredReleaseDate })
    : null;

  return (
    <UpdateStatusDialog
      autoDownloadAndInstallUpdates={autoDownloadAndInstallUpdates}
      displayVersion={displayVersion}
      edgeToEdge={edgeToEdge}
      intl={intl}
      isUpdateActionPending={updateActionInFlight !== null}
      localizedUpdateReleaseNotes={visibleUpdateReleaseNotes}
      onAutoDownloadAndInstallUpdatesChange={handleAutoDownloadAndInstallUpdatesChange}
      onCancelDownload={handleCancelDownload}
      onDownloadUpdate={handleDownloadUpdate}
      onOpenChange={onOpenChange}
      onOpenReleaseNotesExternalUrl={handleOpenReleaseNotesExternalUrl}
      onRestartUpdate={handleRestartUpdate}
      onSkipUpdate={handleSkipUpdate}
      open={open}
      phase={dialogPhase}
      progressLabel={progressLabel}
      progressValue={progressValue}
      releaseDateLabel={releaseDateLabel}
      showOverlay={showOverlay}
      skippableVersion={skippableVersion}
    />
  );
}
