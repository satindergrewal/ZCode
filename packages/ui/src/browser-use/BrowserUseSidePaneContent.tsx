import type { BrowserViewScreenshotSurfacePreparePayload } from "@zcode/shared";
import type { CSSProperties } from "react";
import { UnifiedBrowserView } from "@/browser-use/UnifiedBrowserView.js";
import { cn } from "@/components/lib/utils.js";
import { TabsContent } from "@/components/ui/tabs.js";
import type { BrowserSidePaneMetadata, BrowserUseSidePaneTab } from "@/lib/workspaceSidePane.js";

export interface BrowserUseSidePaneContentProps {
  tab: BrowserUseSidePaneTab;
  onOpenPermissionSettings?: (origin: string) => void;
  isPanelVisible: boolean;
  isSelected: boolean;
  isCurrentTask: boolean;
  screenshotSurfaceRequest: BrowserViewScreenshotSurfacePreparePayload | null;
  initialUrl?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  residencyGeneration?: number;
  onUrlChange(url: string): void;
  onPageMetadataChange(metadata: BrowserSidePaneMetadata): void;
}

/** browser-use-only TabsContent: inactive tabs keep the real composite layout only during screenshot preparation. */
export function BrowserUseSidePaneContent({
  tab,
  onOpenPermissionSettings,
  isPanelVisible,
  isSelected,
  isCurrentTask,
  screenshotSurfaceRequest,
  initialUrl,
  workspacePath,
  workspaceIdentity,
  residencyGeneration,
  onUrlChange,
  onPageMetadataChange,
}: BrowserUseSidePaneContentProps): React.JSX.Element {
  // The screenshot surface cannot rely on a collapsed ResizablePanel for size: at width 0 Chromium
  // treats the guest as having no compositor surface and capturePage fails outright. The same TabsContent
  // is pinned temporarily into an on-window compositing layer, visually isolated by near-transparent opacity; fully off-window
  // reads as offscreen to Viz and keeps returning UnknownVizError. It still takes no layout space and never unmounts the guest.
  const screenshotSurfaceStyle: CSSProperties | undefined = screenshotSurfaceRequest
    ? {
        position: "fixed",
        left: 0,
        top: 0,
        // When the pinned layer exceeds the window, Fit believes the viewport fits; Windows high-DPI
        // Chromium clips guest raster beyond the visible area and the normalized native screenshot stretches horizontally.
        // Cap at the host window so Fit scales to the truly visible canvas, preserving the logical viewport and user preference.
        width: `${screenshotSurfaceRequest.viewport.width}px`,
        height: `${screenshotSurfaceRequest.viewport.height + 48}px`,
        maxWidth: screenshotSurfaceRequest.surfaceScaleMode === "unscaled" ? undefined : "100vw",
        maxHeight: screenshotSurfaceRequest.surfaceScaleMode === "unscaled" ? undefined : "100vh",
        pointerEvents: "none",
        // opacity=0 makes Chromium drop the guest layer; 0.001 keeps the compositor surface while staying invisible.
        opacity: 0.001,
      }
    : undefined;

  return (
    <TabsContent
      value={tab.id}
      forceMount
      aria-hidden={!isSelected}
      inert={!isSelected ? true : undefined}
      data-browser-use-tab-id={tab.tabId}
      data-browser-screenshot-surface-state={screenshotSurfaceRequest ? "preparing" : undefined}
      className={cn(
        "h-full min-h-0 bg-background",
        isSelected
          ? "relative z-10 flex"
          : screenshotSurfaceRequest
            ? "pointer-events-none fixed z-0 flex overflow-hidden"
            : "hidden",
      )}
      style={screenshotSurfaceStyle}
    >
      <UnifiedBrowserView
        browserKey={tab.tabId}
        onOpenPermissionSettings={onOpenPermissionSettings}
        isResidencyRestore={tab.residency === "restoring"}
        isVisible={isPanelVisible && isSelected}
        isSelected={isSelected}
        isCurrentTask={isCurrentTask}
        screenshotSurfaceRequest={screenshotSurfaceRequest}
        initialUrl={initialUrl}
        faviconUrl={tab.faviconUrl}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        workspaceKey={tab.workspaceKey ?? (workspaceIdentity?.trim() || workspacePath)}
        remoteSessionId={tab.remoteSessionId ?? undefined}
        sessionId={tab.sessionId}
        residencyGeneration={tab.residencyGeneration ?? residencyGeneration}
        browserUseOperationUntil={tab.browserUseOperationUntil}
        browserResizeBaselineVersion={tab.browserUseResizeBaselineVersion}
        onUrlChange={onUrlChange}
        onPageMetadataChange={onPageMetadataChange}
      />
    </TabsContent>
  );
}
