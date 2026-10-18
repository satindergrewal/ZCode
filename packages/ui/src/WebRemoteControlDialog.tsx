import { memo, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
/* eslint-disable max-lines -- the web remote dialog owns startup, status polling, QR, and error copy; split once stable. */
import type { BotProvider, WebRemoteControlFailure, WebRemoteControlStatus } from "@zcode/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";
import {
  Bot as BotIcon,
  CopyIcon,
  LoaderCircle,
  MonitorSmartphone,
  RefreshCw,
  Smartphone,
  Unplug,
  XIcon,
} from "lucide-react";
import { BotsDialog } from "@/BotsDialog.js";
import { ProviderIcon } from "@/BotsDialog/shared.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getBotProviderRegionTagLabelId } from "@/botsUi.js";

type RemoteControlBotProvider = Extract<BotProvider, "weixin" | "feishu" | "lark" | "telegram">;

const REMOTE_CONTROL_BOT_ENTRIES: Array<{
  provider: RemoteControlBotProvider;
}> = [
  { provider: "weixin" },
  { provider: "feishu" },
  { provider: "lark" },
  { provider: "telegram" },
];

export function isSameWebRemoteControlTarget(
  status: WebRemoteControlStatus,
  workspacePath: string,
  workspaceIdentity?: string,
  remoteSessionId?: string,
): boolean {
  if (status.status === "idle" || status.status === "error") {
    return false;
  }

  // Bugfix: treating any sessionId presence as the same target reused stale sessions from other workspaces,
  // leaving the dialog stuck in starting on open.
  // Compare workspaceKey (identity first) + remoteSessionId strictly; session and target stay 1:1.
  const statusWorkspacePath = status.workspacePath?.trim();
  if (!statusWorkspacePath) {
    return false;
  }

  const expectedWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath,
    workspaceIdentity,
  });
  const statusWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath: statusWorkspacePath,
    workspaceIdentity: status.workspaceIdentity,
  });
  if (statusWorkspaceKey !== expectedWorkspaceKey) {
    return false;
  }

  const expectedRemoteSessionId = remoteSessionId?.trim() || undefined;
  const statusRemoteSessionId = status.remoteSessionId?.trim() || undefined;
  if (statusRemoteSessionId !== expectedRemoteSessionId) {
    return false;
  }

  return Boolean(status.windowControlSessionId ?? status.sessionId);
}

export function isReusableWebRemoteControlSession(status: WebRemoteControlStatus): boolean {
  if (status.status === "idle" || status.status === "error") {
    return false;
  }

  // Bugfix: the desktop dialog only inspects a window-level entry; a mismatch between the desktop
  // workspace and the phone-bridged one must not restart the relay, or the phone gets a
  // desktop-disconnected push. Only connected sessions span workspaces, so a stale QR never
  // drags a new scanner into the old default workspace.
  return Boolean(status.mobileConnected && (status.windowControlSessionId ?? status.sessionId));
}

function getStatusLabel(
  status: WebRemoteControlStatus,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  switch (status.status) {
    case "starting":
      return formatMessage({ id: "webRemoteControl.status.starting" });
    case "running":
      return formatMessage({ id: "webRemoteControl.status.running" });
    case "connecting":
      return formatMessage({ id: "webRemoteControl.status.connecting" });
    case "active":
      return formatMessage({ id: "webRemoteControl.status.active" });
    case "error":
      return formatMessage({ id: "webRemoteControl.status.error" });
    default:
      return formatMessage({ id: "webRemoteControl.status.idle" });
  }
}

function getStatusDetail(
  status: WebRemoteControlStatus,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  switch (status.status) {
    case "starting":
      return formatMessage({ id: "webRemoteControl.statusDetail.starting" });
    case "running":
      return formatMessage({ id: "webRemoteControl.statusDetail.running" });
    case "connecting":
      return formatMessage({ id: "webRemoteControl.statusDetail.connecting" });
    case "active":
      return formatMessage({ id: "webRemoteControl.statusDetail.active" });
    case "error":
      return formatMessage({ id: "webRemoteControl.statusDetail.error" });
    default:
      return formatMessage({ id: "webRemoteControl.statusDetail.idle" });
  }
}

function getStatusDotClassName(status: WebRemoteControlStatus): string {
  if (status.status === "error") {
    return "bg-destructive";
  }
  if (status.status === "active") {
    return "bg-success";
  }
  if (status.status === "idle") {
    return "bg-border";
  }
  return "bg-warning";
}

export function getWebRemoteControlStatusTagLabel(
  status: WebRemoteControlStatus,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  const deviceName =
    status.mobileDeviceInfo?.browserPlatform?.trim() || status.mobileDeviceInfo?.name?.trim();

  if (deviceName) {
    return deviceName;
  }

  if (status.mobileConnected) {
    return formatMessage({ id: "webRemoteControl.statusTag.phone" });
  }

  if (status.status === "idle") {
    return formatMessage({ id: "webRemoteControl.status.idle" });
  }

  if (status.status === "error") {
    return formatMessage({ id: "webRemoteControl.status.error" });
  }

  return formatMessage({ id: "webRemoteControl.statusTag.ready" });
}

function isSameWebRemoteControlStatus(
  left: WebRemoteControlStatus,
  right: WebRemoteControlStatus,
): boolean {
  return (
    left.status === right.status &&
    left.sessionId === right.sessionId &&
    left.windowControlSessionId === right.windowControlSessionId &&
    left.deviceToken === right.deviceToken &&
    left.expiresAt === right.expiresAt &&
    left.mobileConnected === right.mobileConnected &&
    left.mobileDeviceInfo?.updatedAt === right.mobileDeviceInfo?.updatedAt &&
    left.mobileDeviceInfo?.userAgent === right.mobileDeviceInfo?.userAgent &&
    left.mobileDeviceInfo?.viewport?.width === right.mobileDeviceInfo?.viewport?.width &&
    left.mobileDeviceInfo?.viewport?.height === right.mobileDeviceInfo?.viewport?.height &&
    left.qrUrl === right.qrUrl &&
    left.connectUrl === right.connectUrl &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.remoteSessionId === right.remoteSessionId &&
    left.error === right.error &&
    left.failure?.reason === right.failure?.reason &&
    left.failure?.message === right.failure?.message
  );
}

function getFailureDescription(
  failure: WebRemoteControlFailure | undefined,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string | null {
  if (!failure) {
    return null;
  }

  switch (failure.reason) {
    case "session-not-found":
      return formatMessage({ id: "webRemoteControl.failure.sessionNotFound" });
    case "session-expired":
      return formatMessage({ id: "webRemoteControl.failure.sessionExpired" });
    case "session-conflict":
      if (failure.message?.toLowerCase().includes("kicked")) {
        return formatMessage({ id: "webRemoteControl.failure.kicked" });
      }
      return formatMessage({ id: "webRemoteControl.failure.sessionConflict" });
    case "workspace-closed":
      return formatMessage({ id: "webRemoteControl.failure.workspaceClosed" });
    case "desktop-disconnected":
      return formatMessage({
        id: "webRemoteControl.failure.desktopDisconnected",
      });
    case "invalid-mobile-connection":
      return formatMessage({
        id: "webRemoteControl.failure.invalidMobileConnection",
      });
    case "desktop-bootstrap-timeout":
      return formatMessage({
        id: "webRemoteControl.failure.desktopBootstrapTimeout",
      });
    case "connection-recovery-timeout":
      return formatMessage({
        id: "webRemoteControl.failure.connectionRecoveryTimeout",
      });
    case "relay-unavailable":
      return formatMessage({ id: "webRemoteControl.failure.relayUnavailable" });
    case "unsupported-action":
      return formatMessage({
        id: "webRemoteControl.failure.unsupportedAction",
      });
    case "unexpected-error":
      return formatMessage({ id: "webRemoteControl.failure.unexpectedError" });
  }
}

export const WebRemoteControlDialog = memo(function WebRemoteControlDialogComponent({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}) {
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<WebRemoteControlStatus>({
    status: "idle",
  });
  const [loading, setLoading] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [botsDialogOpen, setBotsDialogOpen] = useState(false);
  const [botEntryProvider, setBotEntryProvider] = useState<RemoteControlBotProvider | null>(null);

  const statusLabel = useMemo(
    () => getStatusLabel(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const statusDetail = useMemo(
    () => getStatusDetail(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const failureDescription = useMemo(
    () => getFailureDescription(status.failure, intl.formatMessage),
    [intl.formatMessage, status.failure],
  );
  const statusTagLabel = useMemo(
    () => getWebRemoteControlStatusTagLabel(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const statusDotClassName = getStatusDotClassName(status);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    const syncWebRemoteControlStatus = async () => {
      setLoading(true);

      try {
        const currentStatus = await platform.getWebRemoteControlStatus();
        let nextStatus: WebRemoteControlStatus;
        if (
          isSameWebRemoteControlTarget(
            currentStatus,
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
          ) ||
          isReusableWebRemoteControlSession(currentStatus)
        ) {
          nextStatus = currentStatus;
        } else {
          const startResult = await platform.startWebRemoteControl({
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
            initialTaskId,
          });
          // Tolerate platform impls still returning cancelled; desktop adds no native confirm anymore.
          nextStatus = startResult.status === "cancelled" ? { status: "idle" } : startResult;
        }
        // Bugfix: the phone default theme is dark and the QR URL no longer carries theme;
        // drop theme from start args so desktop theming stays out of the remote path.

        if (!cancelled) {
          setStatus(nextStatus);
          logger.info("[WebRemoteControlDialog] web remote control state synced", {
            workspacePath,
            workspaceIdentity: workspaceIdentity ?? "none",
            remoteSessionId: remoteSessionId ?? "none",
            initialTaskId: initialTaskId ?? "none",
            status: nextStatus.status,
            sessionId: nextStatus.sessionId ?? "none",
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled) {
          setStatus({
            status: "error",
            workspacePath,
            remoteSessionId,
            error: message,
          });
          toast(intl.formatMessage({ id: "webRemoteControl.startFailed" }, { error: message }));
        }
        logger.error("[WebRemoteControlDialog] failed to start web remote control", {
          workspacePath,
          workspaceIdentity: workspaceIdentity ?? "none",
          remoteSessionId: remoteSessionId ?? "none",
          initialTaskId: initialTaskId ?? "none",
          error: message,
        });
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void syncWebRemoteControlStatus();

    return () => {
      cancelled = true;
    };
  }, [intl, open, platform, remoteSessionId, workspaceIdentity, workspacePath, initialTaskId]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    const pollWebRemoteControlStatus = async () => {
      try {
        const nextStatus = await platform.getWebRemoteControlStatus();
        if (cancelled) {
          return;
        }

        const shouldApplyStatus =
          isSameWebRemoteControlTarget(
            nextStatus,
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
          ) ||
          isReusableWebRemoteControlSession(nextStatus) ||
          nextStatus.status === "idle" ||
          nextStatus.status === "error";
        if (!shouldApplyStatus) {
          return;
        }

        setStatus((currentStatus) =>
          isSameWebRemoteControlStatus(currentStatus, nextStatus) ? currentStatus : nextStatus,
        );
      } catch {
        // Bugfix: web remote state changes happen main/relay-side, so a sync-on-open
        // dialog stalls in waiting.
        // Poll lightly; swallow one-off failures to stay out of the user's way.
      }
    };

    const intervalId = window.setInterval(() => {
      void pollWebRemoteControlStatus();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [open, platform, remoteSessionId, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!status.qrUrl) {
      setQrDataUrl(null);
      return;
    }

    let cancelled = false;
    setQrDataUrl(null);

    void QRCode.toDataURL(status.qrUrl, {
      margin: 1,
      width: 320,
    })
      .then((dataUrl: string) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[WebRemoteControlDialog] failed to generate QR code", message);
      });

    return () => {
      cancelled = true;
    };
  }, [status.qrUrl]);

  const handleCopyLink = async () => {
    if (!status.connectUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(status.connectUrl);
      toast(intl.formatMessage({ id: "webRemoteControl.copyLink.copied" }));
      logger.info("[WebRemoteControlDialog] web remote control link copied", {
        workspacePath,
        remoteSessionId: remoteSessionId ?? "none",
        sessionId: status.sessionId ?? "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.copyLinkFailed" }, { error: message }));
      logger.error("[WebRemoteControlDialog] failed to copy web remote control link", message);
    }
  };

  const handleRefreshQr = async () => {
    // Bugfix: a QR refresh invalidates any sid/hash link already copied or scanned.
    // The button sits beside copy-link, so guard regeneration behind a confirm dialog.
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "webRemoteControl.refreshQr.confirmTitle" }),
      description: intl.formatMessage({
        id: "webRemoteControl.refreshQr.confirmDescription",
      }),
      confirmLabel: intl.formatMessage({ id: "webRemoteControl.refreshQr" }),
    });
    if (!confirmed) {
      return;
    }

    setLoading(true);
    try {
      const nextStatus = await platform.refreshWebRemoteControlPairing({
        workspacePath,
        workspaceIdentity,
        remoteSessionId,
        initialTaskId,
      });
      if (nextStatus.status === "cancelled") {
        // Tolerate cancellable platform impls: keep the running state, no success/failure feedback.
        return;
      }
      // Bugfix: a leaked old QR carries sid/hash; repainting only bumps the timestamp.
      // Reset via the platform layer so main clears pairing material and re-registers the device.
      setStatus(nextStatus);
      toast(intl.formatMessage({ id: "webRemoteControl.refreshQr.success" }));
      logger.info("[WebRemoteControlDialog] web remote control QR refreshed", {
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? "none",
        remoteSessionId: remoteSessionId ?? "none",
        initialTaskId: initialTaskId ?? "none",
        sessionId: nextStatus.sessionId ?? "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.refreshQr.failed" }, { error: message }));
      logger.error("[WebRemoteControlDialog] failed to refresh web remote control QR", {
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? "none",
        remoteSessionId: remoteSessionId ?? "none",
        initialTaskId: initialTaskId ?? "none",
        error: message,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await platform.stopWebRemoteControl();
      setStatus({ status: "idle" });
      onOpenChange(false);
      toast(intl.formatMessage({ id: "webRemoteControl.stopSuccess" }));
      logger.info("[WebRemoteControlDialog] web remote control closed", {
        workspacePath,
        remoteSessionId: remoteSessionId ?? "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.stopFailed" }, { error: message }));
      logger.error("[WebRemoteControlDialog] failed to close web remote control", message);
    } finally {
      setLoading(false);
    }
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    logger.info("[WebRemoteControlDialog] dialog open state changed", {
      workspacePath,
      remoteSessionId: remoteSessionId ?? "none",
      nextOpen,
    });
    onOpenChange(nextOpen);
  };

  const handleDismiss = () => {
    logger.info("[WebRemoteControlDialog] header close clicked", {
      workspacePath,
      remoteSessionId: remoteSessionId ?? "none",
      sessionId: status.sessionId ?? "none",
      status: status.status,
    });
    handleDialogOpenChange(false);
  };

  const handleOpenBotEntry = (provider: RemoteControlBotProvider) => {
    setBotEntryProvider(provider);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlDialog] Open Bot Channel config entry", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
      provider,
    });
  };

  const handleOpenBotsDialog = () => {
    setBotEntryProvider(null);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlDialog] Open Bots config entry", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent
          showCloseButton={false}
          // Bugfix: this dialog used to run wider/closer to the edge than Remote Connect,
          // making the QR/bot-channel content feel off-layer. Reuse the Remote Connect outer size
          // without forcing full height; content sizing keeps the window from looking hollow.
          className="max-h-[calc(100vh-6rem)] max-w-4xl gap-0 overflow-hidden rounded-2xl p-0"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            // Bugfix: this dialog sits near the desktop window top, where the default close lands in
            // the Electron drag region and misses clicks. Close via explicit click and mark the
            // button no-drag so the top-right close always hits.
            // Bugfix: clickable controls in the remote overlay had no pointer cursor and did not
            // read as interactive on desktop hover. Enablement gets the pointer; disabled keeps
            // the Button disabled semantics.
            className="absolute top-2 right-2 enabled:cursor-pointer [app-region:no-drag]"
            onClick={handleDismiss}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
          <div
            data-testid="web-remote-control-dialog-scroll"
            className="max-h-[calc(100vh-6rem)] min-h-0 overflow-y-auto p-5"
          >
            <DialogHeader className="space-y-2 pr-8">
              <div className="flex items-center gap-2">
                <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-primary">
                  <MonitorSmartphone className="size-5" />
                </div>
                <div className="space-y-1">
                  <DialogTitle>{intl.formatMessage({ id: "webRemoteControl.title" })}</DialogTitle>
                  <DialogDescription>
                    {intl.formatMessage({ id: "webRemoteControl.description" })}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div
              data-testid="web-remote-control-main-grid"
              className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1.45fr)_minmax(300px,1fr)]"
            >
              <section
                data-testid="web-remote-control-scan-card"
                className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4"
              >
                <div className="mb-4 flex items-start gap-2">
                  <Smartphone className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                  <div className="min-w-0 space-y-1">
                    <div className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({
                        id: "webRemoteControl.mobileQr.title",
                      })}
                    </div>
                    <p className="text-ui-base/relaxed text-foreground-subtle">
                      {intl.formatMessage({
                        id: "webRemoteControl.mobileQr.description",
                      })}
                    </p>
                  </div>
                </div>
                <div
                  data-testid="web-remote-control-connection-card"
                  className="mb-3 rounded-lg bg-surface px-3 py-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="text-ui-base font-medium text-foreground">
                          {statusLabel}
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5 rounded-full bg-card px-2 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                          <span
                            className={`size-1.5 shrink-0 rounded-full ${statusDotClassName}`}
                          />
                          <span className="truncate">{statusTagLabel}</span>
                        </div>
                      </div>
                      <div className="text-ui-base/relaxed text-foreground-subtle">
                        {statusDetail}
                      </div>
                    </div>
                    {loading ? (
                      <LoaderCircle className="size-4 animate-spin text-foreground-subtle" />
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="default"
                        className="shrink-0 gap-2 enabled:cursor-pointer"
                        onClick={() => void handleStop()}
                        disabled={status.status === "idle"}
                      >
                        <Unplug className="size-3.5" />
                        {intl.formatMessage({ id: "webRemoteControl.stop" })}
                      </Button>
                    )}
                  </div>
                  {failureDescription ? (
                    <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-ui-base/relaxed text-destructive">
                      <p>{failureDescription}</p>
                      {status.failure?.message && status.failure.message !== failureDescription ? (
                        <p className="mt-1 text-ui-xs/relaxed opacity-80">
                          {status.failure.message}
                        </p>
                      ) : null}
                    </div>
                  ) : status.error ? (
                    <p className="mt-3 text-ui-base/relaxed text-destructive">{status.error}</p>
                  ) : null}
                  <div
                    data-testid="web-remote-control-copy-link-row"
                    className="mt-3 flex min-h-10 flex-wrap items-center gap-3 border-t border-border pt-3"
                  >
                    <div className="min-w-48 flex-1 text-ui-base/relaxed text-foreground-subtle">
                      {intl.formatMessage({
                        id: "webRemoteControl.copyLink.description",
                      })}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="default"
                      className="shrink-0 gap-2 enabled:cursor-pointer"
                      onClick={() => void handleRefreshQr()}
                      disabled={loading}
                    >
                      <RefreshCw className="size-3.5" />
                      {intl.formatMessage({ id: "webRemoteControl.refreshQr" })}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="default"
                      className="shrink-0 gap-2 enabled:cursor-pointer"
                      onClick={() => void handleCopyLink()}
                      disabled={!status.connectUrl || loading}
                    >
                      <CopyIcon className="size-3.5" />
                      {intl.formatMessage({ id: "webRemoteControl.copyLink" })}
                    </Button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-background-alt p-4">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={intl.formatMessage({ id: "webRemoteControl.qrAlt" })}
                      className="size-64 max-w-full rounded-lg bg-white p-3"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-3 text-center text-ui-base text-foreground-subtle">
                      <LoaderCircle className="size-5 animate-spin" />
                      <span>
                        {intl.formatMessage({
                          id: "webRemoteControl.generating",
                        })}
                      </span>
                    </div>
                  )}
                </div>
              </section>

              <section className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4">
                <div className="mb-4 flex items-start gap-2">
                  <BotIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                  <div className="min-w-0 space-y-1">
                    <div className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({
                        id: "webRemoteControl.botChannel.title",
                      })}
                    </div>
                    <p className="text-ui-base/relaxed text-foreground-subtle">
                      {intl.formatMessage({
                        id: "webRemoteControl.botChannel.description",
                      })}
                    </p>
                  </div>
                </div>
                <div className="grid min-h-0 flex-1 gap-3">
                  {REMOTE_CONTROL_BOT_ENTRIES.map((entry) => {
                    const regionTagLabelId = getBotProviderRegionTagLabelId(entry.provider);

                    return (
                      <button
                        key={entry.provider}
                        type="button"
                        className="flex min-h-0 cursor-pointer items-start gap-3 rounded-lg border border-transparent bg-surface px-3 py-3 text-left transition-colors hover:border-input-border-focused hover:bg-surface-hover focus-visible:border-input-border-focused"
                        onClick={() => handleOpenBotEntry(entry.provider)}
                      >
                        {/* Bugfix: the Bot Channel entries used generic lucide icons — WeChat, Feishu and
                            Telegram were indistinguishable. Reuse the BotsDialog channel logos with no
                            extra wrapper so the brand mark itself does the recognition. */}
                        <ProviderIcon provider={entry.provider} className="size-12 shrink-0" />
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="flex min-w-0 items-center gap-1.5 text-ui-base font-medium text-foreground">
                            <span className="min-w-0 truncate">
                              {intl.formatMessage({
                                id: `webRemoteControl.botChannel.${entry.provider}.title`,
                              })}
                            </span>
                            {regionTagLabelId ? (
                              <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                                {intl.formatMessage({ id: regionTagLabelId })}
                              </span>
                            ) : null}
                          </span>
                          <span className="block text-ui-base/relaxed text-foreground-subtle">
                            {intl.formatMessage({
                              id: `webRemoteControl.botChannel.${entry.provider}.description`,
                            })}
                          </span>
                          <span className="block text-ui-base font-medium text-primary">
                            {intl.formatMessage({
                              id: "webRemoteControl.botChannel.configure",
                            })}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    data-testid="web-remote-control-open-bots"
                    className="w-full justify-center gap-2 enabled:cursor-pointer"
                    onClick={handleOpenBotsDialog}
                  >
                    <BotIcon className="size-3.5" />
                    {intl.formatMessage({
                      id: "webRemoteControl.botChannel.manageBots",
                    })}
                  </Button>
                </div>
              </section>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <BotsDialog
        open={botsDialogOpen}
        onOpenChange={setBotsDialogOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        entryProvider={botEntryProvider}
      />
    </>
  );
});
