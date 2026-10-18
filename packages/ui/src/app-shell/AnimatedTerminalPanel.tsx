import { useCallback, useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { IServiceAccessor } from "@zcode/services";
import { Terminal } from "@/Terminal.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { cn } from "@/components/lib/utils.js";
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable.js";

export function AnimatedTerminalPanel({
  services,
  workspaceAbsPath,
  workspaceIdentity,
  openWorkspaceKeys,
  isVisible,
  isWindowsDesktop,
  frameClassName = "rounded-xl border border-border",
  panelRef,
  panelElementRef,
  onClose,
  onOpenBrowserUrl,
}: {
  services: IServiceAccessor;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  openWorkspaceKeys?: string[];
  isVisible: boolean;
  isWindowsDesktop?: boolean;
  frameClassName?: string;
  panelRef: RefObject<PanelImperativeHandle | null>;
  panelElementRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onOpenBrowserUrl: (url: string) => void;
}) {
  const [hasRenderedTerminal, setHasRenderedTerminal] = useState(isVisible);
  const [isTerminalPanelResizing, setIsTerminalPanelResizing] = useState(false);
  const isDragCollapsible = !isVisible;
  const isResizeDisabled = !isVisible;
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;

  const finishTerminalPanelResize = useCallback(() => {
    setIsTerminalPanelResizing(false);
  }, []);

  const handleTerminalPanelResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isVisible || (event.pointerType === "mouse" && event.button !== 0)) {
        return;
      }

      // Dragging the terminal panel floods ResizeObserver with callbacks.
      // Mark the drag window so TerminalSession throttles resizes during the drag and flushes the final size on release.
      setIsTerminalPanelResizing(true);
    },
    [isVisible],
  );

  useEffect(() => {
    if (isVisible) {
      // Do not create the terminal session before first expand, or xterm and the backend
      // terminal process get spawned even if the user never opens the terminal. Render only after first expand;
      // collapsing hides instead of unmounting, preserving the session and avoiding a redundant init.
      setHasRenderedTerminal(true);
    }
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible) {
      setIsTerminalPanelResizing(false);
    }
  }, [isVisible]);

  useEffect(() => {
    if (!isTerminalPanelResizing) {
      return;
    }

    window.addEventListener("pointerup", finishTerminalPanelResize);
    window.addEventListener("pointercancel", finishTerminalPanelResize);
    window.addEventListener("blur", finishTerminalPanelResize);
    return () => {
      window.removeEventListener("pointerup", finishTerminalPanelResize);
      window.removeEventListener("pointercancel", finishTerminalPanelResize);
      window.removeEventListener("blur", finishTerminalPanelResize);
    };
  }, [finishTerminalPanelResize, isTerminalPanelResizing]);

  return (
    <>
      {isVisible ? (
        <ResizableHandle
          data-workspace-terminal-resize-handle="true"
          className={cn(
            "aria-[orientation=horizontal]:h-1 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:mx-0 aria-[orientation=horizontal]:translate-y-0 aria-[orientation=horizontal]:[mask-image:none] aria-[orientation=horizontal]:[-webkit-mask-image:none] hover:bg-transparent data-[separator=hover]:bg-transparent data-[separator=active]:bg-transparent focus-visible:bg-transparent after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 after:opacity-0 after:transition-opacity after:content-[''] after:inset-x-[var(--workspace-panel-radius,var(--radius-xl))] after:h-0.5 hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100",
            isTerminalPanelResizing && "after:opacity-100",
          )}
          onPointerCancel={finishTerminalPanelResize}
          onPointerDown={handleTerminalPanelResizeStart}
          onPointerUp={finishTerminalPanelResize}
        />
      ) : null}
      <ResizablePanel
        id="terminal"
        panelRef={panelRef}
        elementRef={panelElementRef}
        defaultSize="0px"
        minSize="140px"
        maxSize="50%"
        collapsedSize="0px"
        // Dragging the panel to minimum height used to collapse it, sharing a trigger with manual close.
        // Now only an explicit close collapses; the toggle animation stays and drag-to-min no longer auto-collapses.
        collapsible={isDragCollapsible}
        // Even with ResizableHandle unmounted, the library treats the collapsed panel edge as a drag hotspot.
        // Disable the hidden panel's resize target so the terminal cannot be dragged out from the edge.
        disabled={isResizeDisabled}
        className={cn(
          "transition-opacity duration-200 ease-out",
          isVisible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <div
          data-workspace-terminal-frame="true"
          className={cn("h-full overflow-hidden bg-background", frameClassName)}
        >
          {hasRenderedTerminal ? (
            <div aria-hidden={!isVisible} className="h-full">
              {/* Do not render the terminal before its first expand to skip needless init;
                  keep it mounted afterwards and only hide (not unmount) when collapsed, so the next expand reuses the session. */}
              <ScopedErrorBoundary
                scope="workspace-terminal"
                resetKeys={[workspaceKey]}
                variant="panel"
                className="h-full"
              >
                <Terminal
                  services={services}
                  cwd={workspaceAbsPath}
                  workspaceIdentity={workspaceIdentity}
                  openWorkspaceKeys={openWorkspaceKeys}
                  isVisible={isVisible}
                  isPanelResizing={isTerminalPanelResizing}
                  isWindowsDesktop={isWindowsDesktop}
                  onClose={onClose}
                  onOpenBrowserUrl={onOpenBrowserUrl}
                />
              </ScopedErrorBoundary>
            </div>
          ) : null}
        </div>
      </ResizablePanel>
    </>
  );
}
