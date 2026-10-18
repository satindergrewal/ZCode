import type { DragEventHandler } from "react";

/**
 * The file-drop surface ConversationComposer exposes to the outer conversation shell.
 *
 * The controller only routes into the existing composer, in-renderer: no second upload state
 * machine, and the desktop-continuous / web-remote-replayable transport bounds stay put.
 */
export interface ConversationDropTargetController {
  active: boolean;
  kind: "attachment" | "workspace" | null;
  onDragOver: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
}
