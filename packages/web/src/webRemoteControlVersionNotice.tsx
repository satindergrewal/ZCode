import { createRoot } from "react-dom/client";
import { Button } from "@zcode/ui";
import { resolveWebRemoteControlScreenLocale } from "./webRemoteControlFailureScreen.js";

/** The page stays mounted; the native modal blocks background elements and other portals, and global shortcuts are intercepted at the entry. */
export function showWebRemoteControlVersionNotice(
  version: string,
  onReload: () => void,
): () => void {
  const dialog = document.createElement("dialog");
  dialog.className =
    "m-auto max-w-md rounded-2xl border border-popover-border bg-popover p-6 text-foreground shadow-lg";
  // Web files sit outside shared-UI Tailwind scan dirs; streaming widths avoid depending on ungenerated responsive utilities.
  dialog.style.width = "calc(100% - 2rem)";
  // Open Radix dialogs set pointer-events:none on body; the top-level native modal must restore pointer events explicitly.
  dialog.style.pointerEvents = "auto";
  dialog.setAttribute("aria-labelledby", "remote-version-title");
  dialog.setAttribute("aria-describedby", "remote-version-description");
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  const zh = resolveWebRemoteControlScreenLocale(navigator.language) === "zh-CN";
  document.body.append(dialog);
  const noticeRoot = createRoot(dialog);
  noticeRoot.render(
    <div className="flex min-w-0 flex-col gap-4">
      <h2 id="remote-version-title" className="text-ui-lg font-medium">
        {zh ? "桌面版本已更新" : "Desktop version changed"}
      </h2>
      <p
        id="remote-version-description"
        className="text-ui-base text-foreground-subtle break-words"
      >
        {zh
          ? `桌面当前版本为 ${version}。任务操作已暂停，请重新加载以继续。未发送的附件不会保留。`
          : `The desktop is now running ${version}. Task controls are paused. Reload to continue. Unsent attachments will not be retained.`}
      </p>
      <Button autoFocus size="lg" className="self-end" onClick={onReload}>
        {zh ? "重新加载" : "Reload"}
      </Button>
    </div>,
  );
  dialog.showModal();
  // Native modal events still bubble to document/window; stop them so background global shortcut handling stays blocked.
  for (const type of [
    "keydown",
    "keyup",
    "keypress",
    "click",
    "pointerdown",
    "focusin",
    "focusout",
  ] as const) {
    dialog.addEventListener(type, (event) => event.stopPropagation());
  }
  return () => {
    noticeRoot.unmount();
    dialog.close();
    dialog.remove();
  };
}
