import type { ReactNode } from "react";
import { AlertDialogHost } from "@/AlertDialogHost.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { CuaPermissionObservationAttachment } from "@/cua-permission/CuaPermissionObservationAttachment.js";
import { PluginUiFollowUpDialogHost } from "@/plugin-ui/index.js";

export function RootShell({ children }: { children: ReactNode }) {
  // Web remote control in phone browsers cannot use a fixed 100vh:
  // the collapsing URL bar clips the bottom input out of the viewport; the root uses dynamic viewport height.
  return (
    <div className="relative h-dvh">
      {children}
      <CuaPermissionObservationAttachment />
      <AlertDialogHost />
      <ConfirmDialogHost />
      <PluginUiFollowUpDialogHost />
    </div>
  );
}
