import { useEffect, useMemo, useState } from "react";
import { MonitorUp, Paperclip, ShieldAlert, Usb, X } from "lucide-react";
import {
  TID_BROWSER_PERMISSION_ALLOW_ALWAYS,
  TID_BROWSER_PERMISSION_ALLOW_ONCE,
  TID_BROWSER_PERMISSION_DENY,
  TID_BROWSER_PERMISSION_DISMISS,
  TID_BROWSER_PERMISSION_PROMPTS,
  type EmbeddedBrowserPermissionPromptEvent,
  type EmbeddedBrowserPermissionResolution,
} from "@zcode/shared";
import { BrowserPermissionIcon } from "@/browser-use/BrowserPermissionIcon.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/index.js";
import { logger } from "@/logger.js";
import { useEmbeddedBrowserPermissionStore } from "@/store/embeddedBrowserPermissionStore.js";

/**
 * Embedded-browser permission layer (docs/browser-use/2026-10-08-embedded-browser-permission-governance-spec.md).
 * permission -> Chrome-style anchored bubble (below the omnibox, left; origin title + close,
 * capability rows, vertical triple: allow on visit (persist) / allow once / deny (no memory);
 * no forever-block, mis-taps are hard to undo; persistent deny lives in site settings;
 * screen-share/device -> Dialog picker (sources grouped entire screen/window).
 * Cancel/timeout settle in main; the renderer returns decisions only.
 */

const MEDIA_LABEL: Record<string, string> = {
  video: "browser.permission.mediaVideo",
  audio: "browser.permission.mediaAudio",
};

const PERMISSION_LABEL: Record<string, string> = {
  media: "browser.permission.media",
  "clipboard-read": "browser.permission.clipboardRead",
  geolocation: "browser.permission.geolocation",
  notifications: "browser.permission.notifications",
  midi: "browser.permission.midi",
  midiSysex: "browser.permission.midi",
  "idle-detection": "browser.permission.idleDetection",
  "speaker-selection": "browser.permission.speakerSelection",
  "window-management": "browser.permission.windowManagement",
  "storage-access": "browser.permission.storageAccess",
  "top-level-storage-access": "browser.permission.storageAccess",
  keyboardLock: "browser.permission.keyboardLock",
  fileSystem: "browser.permission.fileSystem",
  "select-hid-device": "browser.permission.deviceHid",
  "select-usb-device": "browser.permission.deviceUsb",
  "select-serial-port": "browser.permission.deviceSerial",
  "select-bluetooth-device": "browser.permission.deviceBluetooth",
};

function permissionLabelId(permission: string, mediaTypes?: string[]): string {
  if (permission === "media" && mediaTypes && mediaTypes.length > 0) {
    const ids = mediaTypes.map((type) => MEDIA_LABEL[type]).filter(Boolean);
    if (ids.length === 1) return ids[0]!;
    if (ids.length > 1) return "browser.permission.mediaBoth";
  }
  return PERMISSION_LABEL[permission] ?? "browser.permission.unknownCapability";
}

/** Bubble rows: media splits by mediaTypes into camera/mic; everything else one row. */
function promptCapabilities(
  prompt: Extract<EmbeddedBrowserPermissionPromptEvent, { kind: "permission" }>,
): { key: string; labelId: string }[] {
  if (prompt.permission === "media") {
    const types = prompt.mediaTypes?.length ? prompt.mediaTypes : ["video", "audio"];
    return types.map((type) => ({
      key: type === "video" ? "camera" : "microphone",
      labelId: MEDIA_LABEL[type] ?? "browser.permission.media",
    }));
  }
  return [{ key: prompt.permission, labelId: permissionLabelId(prompt.permission) }];
}

function promptIcon(event: EmbeddedBrowserPermissionPromptEvent) {
  if (event.kind === "screen-share") return <MonitorUp className="size-4 shrink-0" />;
  if (event.kind === "device") return <Usb className="size-4 shrink-0" />;
  if (event.permission === "clipboard-read") return <Paperclip className="size-4 shrink-0" />;
  return <ShieldAlert className="size-4 shrink-0" />;
}

/**
 * guestWebContentsId is the tab's guest identity: a request tagged with a non-matching id
 * renders nowhere here (background-tab requests never show on the visible tab).
 * No guest (empty tab): tagged requests do not belong here, also skipped;
 * untagged requests (device/screen-share) render as fallback,
 * with the body always naming the origin.
 */
export function EmbeddedBrowserPermissionPrompts({
  guestWebContentsId,
}: {
  guestWebContentsId?: number;
}) {
  const platform = usePlatform();
  const {
    intl: { formatMessage },
  } = useZCodeIntl();
  const prompts = useEmbeddedBrowserPermissionStore((state) => state.prompts);
  const receivePrompt = useEmbeddedBrowserPermissionStore((state) => state.receivePrompt);
  const dropPrompt = useEmbeddedBrowserPermissionStore((state) => state.dropPrompt);
  const [selection, setSelection] = useState<Record<string, string>>({});

  useEffect(() => {
    // main settles timeouts silently; the renderer also dequeues at 20s as a floor,
    // so entries never linger (a repeat is a new requestId).
    const disposers = prompts.map((prompt) => {
      const timer = setTimeout(() => dropPrompt(prompt.requestId), 20_000);
      return () => clearTimeout(timer);
    });
    return () => disposers.forEach((dispose) => dispose());
  }, [prompts, dropPrompt]);

  useEffect(() => {
    const dispose = platform.onEmbeddedBrowserPermissionPrompt?.((event) => receivePrompt(event));
    if (!dispose) {
      logger.warn("[embedded-browser-permission] platform prompt subscription unavailable");
      return;
    }
    return dispose;
  }, [platform, receivePrompt]);

  const resolve = (requestId: string, resolution: EmbeddedBrowserPermissionResolution) => {
    platform.resolveEmbeddedBrowserPermissionPrompt?.({ requestId, resolution });
    dropPrompt(requestId);
  };

  const permissionPrompts = useMemo(
    () =>
      prompts.filter(
        (prompt): prompt is Extract<EmbeddedBrowserPermissionPromptEvent, { kind: "permission" }> =>
          prompt.kind === "permission" &&
          (prompt.guestWebContentsId === undefined ||
            prompt.guestWebContentsId === guestWebContentsId),
      ),
    [prompts, guestWebContentsId],
  );
  // The device dialog filters by guest ownership too (serial/bt carry it;
  // hid/usb and screen-share without it render as fallback, origin in the body).
  const selectorPrompts = useMemo(
    () =>
      prompts.filter(
        (prompt): prompt is Exclude<EmbeddedBrowserPermissionPromptEvent, { kind: "permission" }> =>
          prompt.kind !== "permission" &&
          (prompt.guestWebContentsId === undefined ||
            prompt.guestWebContentsId === guestWebContentsId),
      ),
    [prompts, guestWebContentsId],
  );

  return (
    <>
      {permissionPrompts.length > 0 ? (
        <div
          className="pointer-events-none absolute left-3 top-1.5 z-40 flex w-80 max-w-[calc(100%-24px)] flex-col gap-2"
          data-testid={TID_BROWSER_PERMISSION_PROMPTS}
        >
          {permissionPrompts.map((prompt) => (
            <div
              key={prompt.requestId}
              className="pointer-events-auto rounded-xl border border-popover-border bg-popover p-4 shadow-md"
              role="dialog"
              aria-label={formatMessage({ id: "browser.permission.promptAriaLabel" })}
            >
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 text-ui-lg leading-relaxed font-medium break-words">
                  <span className="text-foreground">{prompt.origin}</span>
                  <span className="text-ui-base text-foreground-subtle">
                    {" "}
                    {formatMessage({ id: "browser.permission.wantsToUse" })}
                  </span>
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={formatMessage({ id: "browser.permission.close" })}
                  data-testid={TID_BROWSER_PERMISSION_DISMISS}
                  onClick={() => resolve(prompt.requestId, { action: "dismiss" })}
                >
                  <X />
                </Button>
              </div>
              <ul className="mt-2 space-y-2">
                {promptCapabilities(prompt).map((capability) => (
                  <li
                    key={capability.key}
                    className="flex items-center gap-2 text-ui-base text-foreground break-all"
                  >
                    <BrowserPermissionIcon capability={capability.key} />
                    {formatMessage({ id: capability.labelId })}
                  </li>
                ))}
              </ul>
              {/* Vertical triple (fix/missing_tool visuals): allow always / allow once / deny (no memory).
                  No forever-block: mis-taps are hard to undo; persistent deny lives in site settings. */}
              <div className="mt-3 flex flex-col gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  data-testid={TID_BROWSER_PERMISSION_ALLOW_ALWAYS}
                  className="h-auto min-h-9 justify-start rounded-full px-4 py-2 text-left whitespace-normal"
                  onClick={() => resolve(prompt.requestId, { action: "allow-always" })}
                >
                  {formatMessage({ id: "browser.permission.allowAlways" })}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  data-testid={TID_BROWSER_PERMISSION_ALLOW_ONCE}
                  className="h-auto min-h-9 justify-start rounded-full px-4 py-2 text-left whitespace-normal"
                  onClick={() => resolve(prompt.requestId, { action: "allow-session" })}
                >
                  {formatMessage({ id: "browser.permission.allowOnce" })}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  data-testid={TID_BROWSER_PERMISSION_DENY}
                  className="h-auto min-h-9 justify-start rounded-full px-4 py-2 text-left whitespace-normal"
                  onClick={() => resolve(prompt.requestId, { action: "dismiss" })}
                >
                  {formatMessage({ id: "browser.permission.denyThisTime" })}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {selectorPrompts.map((prompt) => (
        <Dialog
          key={prompt.requestId}
          open
          onOpenChange={(open) => {
            if (!open) resolve(prompt.requestId, { action: "cancel" });
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {promptIcon(prompt)}
                {prompt.kind === "screen-share"
                  ? formatMessage(
                      { id: "browser.permission.screenShareTitle" },
                      { origin: prompt.origin },
                    )
                  : formatMessage(
                      { id: "browser.permission.deviceTitle" },
                      { origin: prompt.origin },
                    )}
              </DialogTitle>
              <DialogDescription>
                {prompt.kind === "screen-share"
                  ? formatMessage({ id: "browser.permission.screenShareDescription" })
                  : formatMessage({ id: permissionLabelId(prompt.permission) })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {prompt.kind === "screen-share"
                ? (["screen", "window"] as const).map((group) => {
                    const screens = prompt.screens.filter((screen) => screen.kind === group);
                    if (screens.length === 0) return null;
                    return (
                      <div key={group}>
                        <p className="px-2 pb-1 pt-2 text-ui-xs text-foreground-subtlest">
                          {formatMessage({
                            id:
                              group === "screen"
                                ? "browser.permission.screenGroup.screen"
                                : "browser.permission.screenGroup.window",
                          })}
                        </p>
                        {screens.map((screen) => (
                          <button
                            type="button"
                            key={screen.sourceId}
                            className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-menu-hover data-[selected=true]:bg-selected"
                            data-selected={selection[prompt.requestId] === screen.sourceId}
                            onClick={() =>
                              setSelection((current) => ({
                                ...current,
                                [prompt.requestId]: screen.sourceId,
                              }))
                            }
                          >
                            {screen.thumbnailDataUrl ? (
                              <img
                                src={screen.thumbnailDataUrl}
                                alt=""
                                className="h-[45px] w-20 rounded-sm border border-border object-cover"
                              />
                            ) : null}
                            <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
                              {screen.name}
                            </span>
                          </button>
                        ))}
                      </div>
                    );
                  })
                : prompt.devices.map((device) => (
                    <button
                      type="button"
                      key={device.deviceId}
                      className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-menu-hover data-[selected=true]:bg-selected"
                      data-selected={selection[prompt.requestId] === device.deviceId}
                      onClick={() =>
                        setSelection((current) => ({
                          ...current,
                          [prompt.requestId]: device.deviceId,
                        }))
                      }
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui-sm text-foreground">
                          {device.name ?? device.deviceId}
                        </span>
                        {device.vendorId !== undefined || device.serialNumber ? (
                          <span className="block truncate font-mono text-ui-xs text-foreground-subtlest">
                            {[
                              device.vendorId !== undefined && device.productId !== undefined
                                ? `${device.vendorId.toString(16).padStart(4, "0")}:${device.productId.toString(16).padStart(4, "0")}`
                                : undefined,
                              device.serialNumber,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  ))}
            </div>
            <DialogFooter>
              <Button
                size="sm"
                variant="outline"
                onClick={() => resolve(prompt.requestId, { action: "cancel" })}
              >
                {formatMessage({ id: "browser.permission.cancel" })}
              </Button>
              <Button
                size="sm"
                disabled={!selection[prompt.requestId]}
                onClick={() => {
                  const picked = selection[prompt.requestId];
                  if (!picked) return;
                  resolve(
                    prompt.requestId,
                    prompt.kind === "screen-share"
                      ? { action: "share-screen", sourceId: picked }
                      : { action: "select-device", deviceId: picked },
                  );
                }}
              >
                {formatMessage({
                  id:
                    prompt.kind === "screen-share"
                      ? "browser.permission.share"
                      : "browser.permission.connect",
                })}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ))}
    </>
  );
}
