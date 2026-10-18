import type { IPlatformService, Locale, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { UpdateStatusDialogController } from "@/UpdateStatusDialogController.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";

export function UpdateStatusWindowRoot({
  platform,
  initialLocale,
  onRequestClose,
}: {
  platform: IPlatformService;
  initialLocale: Locale;
  onRequestClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null);
  const [readyVersion, setReadyVersion] = useState<string | null>(null);
  const revisionRef = useRef(0);
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        onRequestClose();
      }
    },
    [onRequestClose],
  );

  useEffect(() => {
    const disposers: Array<() => void> = [];
    const eventRevision = () => {
      revisionRef.current += 1;
      return revisionRef.current;
    };

    // The standalone update window lacks the main window's app chrome state, so it must fetch
    // one getUpdateState snapshot itself; the revision guard keeps older snapshots from
    // overriding later live events.
    const snapshotRevision = revisionRef.current;
    void platform.getUpdateState?.().then((payload) => {
      if (revisionRef.current !== snapshotRevision) {
        return;
      }
      setUpdateState(payload);
    });

    disposers.push(
      platform.onUpdateStateChanged?.((payload) => {
        eventRevision();
        setUpdateState(payload);
      }) ?? (() => {}),
    );
    disposers.push(
      platform.onUpdateReady((version) => {
        setReadyVersion(version);
      }),
    );
    disposers.push(
      platform.onApplicationLocaleChanged?.((nextLocale) => {
        setLocale(nextLocale);
      }) ?? (() => {}),
    );

    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, [platform]);

  return (
    <div className="min-h-screen bg-transparent text-foreground">
      {/* The standalone update window has no workspace setting/broadcast service and cannot rely
          on the startup locale alone. Main pushes the resolved locale after the main window
          switches; remount the provider so dialog copy follows live. */}
      <ZCodeIntlProvider key={locale} initialLocale={locale}>
        <UpdateStatusDialogController
          platform={platform}
          version={readyVersion}
          updateState={updateState}
          open={open}
          onOpenChange={handleOpenChange}
          edgeToEdge
          showOverlay={false}
        />
        <ConfirmDialogHost />
      </ZCodeIntlProvider>
    </div>
  );
}
