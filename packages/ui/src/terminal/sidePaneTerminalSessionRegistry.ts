// sidePaneTerminalSessionRegistry -- module-level singleton keeping side pane terminal sessions
// alive across workspace switches.
//
// If xterm, the PTY, and subscriptions were owned by the TerminalSession component, the unmount
// triggered by a workspace switch would kill the process and lose history. Holding those
// resources in a module-level registry while the component only mounts the display lets the
// terminal session survive workspace switches.
//
// Fix shape (mirrors the bottom-pane idea, different form): move ownership of the side pane
// terminal's xterm instance + PTY up into this module-level singleton, out of the
// TerminalSession effect lifecycle. Any unmount/remount leaves xterm/PTY untouched; on remount
// the entry is fetched by persistentKey (=tab.id) and hostEl is physically moved back.
//
// The session is not shared with the bottom terminal pane.
// Only SidePaneTerminalPane hooks in via TerminalSession's persistentKey prop; the bottom pane
// passes no persistentKey, keeps TerminalSession's original effect path, and never touches the
// registry.

import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal as XTerm } from "@xterm/xterm";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/**
 * Persistent resources of one side pane terminal session.
 *
 * - term/fitAddon: the xterm instance (with scrollback history) + fit addon; the same instance
 *   is reused across workspace switches.
 * - terminalId: PTY id assigned by terminalService (root-level shared service; local workspaces
 *   share baseServices).
 * - hostEl: the persistent container passed to term.open. It physically moves between stashDiv
 *   (hidden stash) and the real render container; the xterm DOM subtree moves with it while the
 *   term instance and scrollback stay intact.
 * - dispose: real teardown (on tab close) -- kill PTY + destroy xterm + release subscriptions.
 *   Injected by the TerminalSession creator; the registry itself never depends on
 *   terminalService (the service is dependency-injected, not hardcoded here).
 */
export interface SidePaneTerminalSessionEntry {
  key: string;
  term: XTerm;
  fitAddon: FitAddon;
  terminalId: string;
  cwd: string;
  /**
   * workspaceKey (= workspaceIdentity?.trim() || workspacePath) owning this terminal.
   * Used only to bulk-reclaim sessions when a workspace tab is actually closed (mirroring the
   * bottom pane's openWorkspaceKeys reclamation). Switching workspaces never reclaims; only
   * removing the workspace from openWorkspaceKeys does.
   */
  workspaceKey: string;
  hostEl: HTMLDivElement;
  /**
   * Terminal profile theme (user's terminal colors) returned by terminalService.create().
   * Bug background: the original implementation only wrote a component-local
   * terminalProfileThemeRef; the ref died with the component, and on remount the new component's
   * ref reset to undefined, so the reused observer merged the base theme with undefined and lost
   * the profile theme. Ownership moved onto the entry so the profile theme shares one persistent
   * owner with term/PTY and survives component lifecycles.
   */
  profileTheme?: ITheme;
  /** Real dispose: kill PTY + destroy xterm + release subscriptions + remove hostEl. Injected by the creator (TerminalSession persistentKey path). */
  dispose: () => void;
}

// Module-level state: persistent across workspaces and React trees.
const sessions = new Map<string, SidePaneTerminalSessionEntry>();
// Memory diagnostics counter: persistent xterm instances are unbounded, so log the count.
uiMemoryDiagnosticsRegistry.register("xterm", () => ({ sessions: sessions.size }));

// Hidden stash container for detached hostEl elements, so React unmounting a render container
// does not take the xterm DOM down with it.
let stashDiv: HTMLDivElement | null = null;

function getStashDiv(): HTMLDivElement | null {
  // SSR/web test environments may have no document.
  if (typeof document === "undefined") return null;
  if (!stashDiv) {
    stashDiv = document.createElement("div");
    stashDiv.style.display = "none";
    stashDiv.setAttribute("data-side-pane-terminal-stash", "");
    document.body.appendChild(stashDiv);
  }
  return stashDiv;
}

function releaseEntry(key: string): void {
  const entry = sessions.get(key);
  if (!entry) return;
  sessions.delete(key);
  try {
    entry.dispose();
  } catch (error) {
    // dispose kills the PTY/destroys xterm and should not throw; even if it does, it must not
    // block tab closing, or one failing terminal release would stall the whole batch
    // (close-others/close-all). Swallow and log, mirroring the bottom pane's tolerance.
    // Risk: a leftover PTY is reclaimed by terminalService disposeAll at host shutdown.
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn("[sidePaneTerminalSessionRegistry] release dispose failed", error);
    }
  }
  entry.hostEl.remove();
}

/**
 * Module-level singleton for side pane terminal sessions.
 *
 * Never news up XTerm or calls terminalService directly -- resources are created by
 * TerminalSession's persistentKey path and then registered here. The registry only does
 * store/attach/DOM-move/reclaim, staying decoupled from the service layer.
 */
export const sidePaneTerminalSessionRegistry = {
  has(key: string): boolean {
    return sessions.has(key);
  },

  get(key: string): SidePaneTerminalSessionEntry | undefined {
    return sessions.get(key);
  },

  /** Persist a newly created entry (TerminalSession persistentKey path, first creation). */
  register(key: string, entry: SidePaneTerminalSessionEntry): void {
    sessions.set(key, entry);
  },

  /**
   * Physically move entry.hostEl into the host container (attach).
   * xterm's .xterm DOM subtree travels with hostEl and the term instance is untouched; the
   * caller must run fitAddon.fit() afterwards to restore size.
   */
  attachDom(key: string, host: HTMLElement): void {
    const entry = sessions.get(key);
    if (!entry) return;
    if (entry.hostEl.parentElement === host) return;
    host.appendChild(entry.hostEl);
  },

  /**
   * Move entry.hostEl back into stashDiv (detach).
   * Called on component unmount -- term/PTY/subscriptions are not disposed; the resources stay
   * in the registry for the next remount.
   */
  detachDom(key: string): void {
    const entry = sessions.get(key);
    if (!entry) return;
    const stash = getStashDiv();
    if (!stash) return;
    if (entry.hostEl.parentElement === stash) return;
    stash.appendChild(entry.hostEl);
  },

  /** Explicit side pane tab close: real dispose (kill PTY + destroy xterm + release subscriptions). */
  release(key: string): void {
    releaseEntry(key);
  },

  /**
   * Bulk reclaim, filtered by predicate when a workspace tab closes.
   * Mirrors the bottom pane Terminal.tsx openWorkspaceKeys reclamation.
   */
  releaseByPredicate(pred: (entry: SidePaneTerminalSessionEntry) => boolean): void {
    for (const [key, entry] of sessions) {
      if (pred(entry)) {
        releaseEntry(key);
      }
    }
  },

  /** Test-only: release every session and remove stashDiv. */
  clearForTest(): void {
    for (const key of Array.from(sessions.keys())) {
      releaseEntry(key);
    }
    sessions.clear();
    if (stashDiv && typeof document !== "undefined") {
      stashDiv.remove();
      stashDiv = null;
    }
  },
};
