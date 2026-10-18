import { DesktopWindowControls } from "@/DesktopWindowControls.js";

/** Full overlays cover window controls; root platform flags restore Windows/Linux buttons. */
export function DesktopOverlayWindowControls() {
  return (
    <div className="absolute right-1 top-1 z-30 mt-px mr-px hidden h-12 items-center px-2 [app-region:no-drag] platform-windows-desktop:flex platform-linux-desktop:flex">
      <DesktopWindowControls />
    </div>
  );
}
