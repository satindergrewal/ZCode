import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { UpdateStatusDialogController } from "@/UpdateStatusDialogController.js";
import { UpdateReleaseNotesTooltip } from "@/UpdateReleaseNotesTooltip.js";
import { ArrowDownToLine, LoaderCircle } from "lucide-react";
import { formatUpdateReleaseDate, getLocalizedUpdateReleaseNotes } from "@/updateReleaseNotes.js";
import { resolveUpdateButtonResponsiveClasses } from "@/updateStatusButtonLayout.js";
import { deriveUpdateStatusViewModel } from "@/updateStatusModel.js";

export function UpdateStatusButton({
  platform,
  version,
  updateState,
  isMacDesktop = false,
  isWindowsDesktop = false,
  className,
}: {
  platform: IPlatformService;
  version: string | null;
  updateState: UpdateStatePayload | null;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  className?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const [dialogOpen, setDialogOpen] = useState(false);
  const releaseNotesCacheRef = useRef(
    new Map<
      string,
      {
        releaseDateLabel: string | null;
        releaseNotes: { title: string; markdown: string };
      }
    >(),
  );
  const { expandWidthClass, hideIconClass, revealTextClass } = resolveUpdateButtonResponsiveClasses(
    { isMacDesktop, isWindowsDesktop },
  );
  const updateStatusViewModel = deriveUpdateStatusViewModel({
    legacyReadyVersion: version,
    updateState,
  });
  const {
    dialogPhase,
    displayVersion,
    progressLabel,
    releaseNotesPayload: updateReleaseNotesPayload,
  } = updateStatusViewModel;
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
    if (!releaseNotesCacheKey || !localizedUpdateReleaseNotes) {
      return;
    }

    // Some platforms' download-complete event reliably carries only the version. The entry's
    // hover keeps caching the notes captured at discovery so the main entry behaves as before
    // now that the dialog moved out.
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
  // Once downloading, the dialog's job shifts from reading release notes to watching progress.
  // Notes would crowd the progress area and duplicate between button hover and dialog.
  const visibleUpdateReleaseNotes =
    dialogPhase === "downloading" ? null : restoredUpdateReleaseNotes;
  const handleOpenReleaseNotesExternalUrl = useCallback(
    (url: string) => platform.openExternal(url),
    [platform],
  );
  const handleUpdateEntryClick = useCallback(() => {
    if (platform.openUpdateStatusWindow) {
      void platform.openUpdateStatusWindow();
      return;
    }

    setDialogOpen(true);
  }, [platform]);

  if (!displayVersion) return null;

  // Dialog and button hover share one release-notes title so the feed's releaseName never
  // duplicates the body heading.
  const releaseNotesTitle = intl.formatMessage(
    { id: "updateReady.releaseNotesTitle" },
    { version: displayVersion },
  );
  const tooltipTitle =
    dialogPhase === "downloading"
      ? progressLabel
        ? intl.formatMessage(
            { id: "desktopMenu.help.downloadingUpdateProgress" },
            { progress: progressLabel },
          )
        : intl.formatMessage(
            { id: "desktopMenu.help.downloadingUpdateVersion" },
            { version: displayVersion },
          )
      : dialogPhase === "downloaded"
        ? intl.formatMessage({ id: "updateReady.tooltip" }, { version: displayVersion })
        : intl.formatMessage({ id: "updateAvailable.tooltip" }, { version: displayVersion });

  const readyButton = (
    <Button
      size={"xs"}
      variant={"secondary"}
      aria-label={tooltipTitle}
      onClick={handleUpdateEntryClick}
      className={cn(
        // Only the dialog goes neutral; the in-page entry keeps its success color so the header
        // status stays prominent. Auto-download never opens the window by itself, so the entry
        // must stay clickable to cancel from the window. The xs button's fixed h-5 and fixed
        // expanded width fit only the default font scale and clip when larger; switch to min-height
        // plus intrinsic width — compact by default, growing with the text.
        "h-auto min-h-5 gap-1 rounded-full py-0.5 font-medium leading-none text-ui-xs w-6 border-transparent bg-success text-success-foreground hover:bg-success/80 transition-all",
        dialogPhase !== "downloading" && expandWidthClass,
        className,
      )}
    >
      {dialogPhase === "downloading" ? (
        <LoaderCircle
          // The downloading state shows loading via the spinner; do not reuse the normal icon's expand/hide rule.
          className="size-3 shrink-0 animate-spin"
        />
      ) : (
        <ArrowDownToLine className={cn("size-3 shrink-0 inline", hideIconClass)} />
      )}
      {dialogPhase !== "downloading" ? (
        <span
          className={cn(
            "w-0 overflow-hidden absolute opacity-0 transition-all",
            ...revealTextClass,
          )}
        >
          {intl.formatMessage({ id: "updateReady.shortTitle" })}
        </span>
      ) : null}
    </Button>
  );

  const updateButton = visibleUpdateReleaseNotes ? (
    <UpdateReleaseNotesTooltip
      locale={locale}
      onOpenExternalUrl={handleOpenReleaseNotesExternalUrl}
      releaseDateLabel={restoredReleaseDate}
      releaseNotesMarkdown={visibleUpdateReleaseNotes.markdown}
      releaseNotesTitle={releaseNotesTitle}
    >
      {readyButton}
    </UpdateReleaseNotesTooltip>
  ) : (
    <ControlHintTooltip title={tooltipTitle} side="bottom">
      {readyButton}
    </ControlHintTooltip>
  );

  return (
    <>
      {updateButton}
      <UpdateStatusDialogController
        platform={platform}
        version={version}
        updateState={updateState}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}
