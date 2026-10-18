import type { StartupWindowBootstrap } from "./startupWorkspace.js";

interface WindowLike {
  destroy?(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized?(): boolean;
  isRendererCrashed?(): boolean;
  webContents?: {
    isCrashed?: () => boolean;
  };
  restore?(): void;
  show(): void;
  focus?(): void;
}

interface PrimaryWindowCoordinatorDeps {
  listWindows(): WindowLike[];
  resolveStartupWindowBootstrap(): Promise<StartupWindowBootstrap>;
  createWindow(startupBootstrap: StartupWindowBootstrap): void;
  canCreateWindow?: (reason: string) => boolean;
  logger: {
    info(message: string): void;
  };
}

export function createPrimaryWindowCoordinator(deps: PrimaryWindowCoordinatorDeps) {
  let pendingEnsurePromise: Promise<void> | null = null;

  function isRendererCrashed(window: WindowLike): boolean {
    return Boolean(window.isRendererCrashed?.() || window.webContents?.isCrashed?.());
  }

  function revealExistingWindow(): boolean {
    for (const existingWindow of deps.listWindows()) {
      if (existingWindow.isDestroyed()) {
        continue;
      }

      if (isRendererCrashed(existingWindow)) {
        // After a renderer native crash the BrowserWindow can survive; reuse shows a blank shell on activate.
        existingWindow.destroy?.();
        deps.logger.info("[primary-window] discarded crashed renderer window");
        continue;
      }

      if (existingWindow.isMinimized?.()) {
        existingWindow.restore?.();
      }
      if (!existingWindow.isVisible()) {
        existingWindow.show();
      }
      existingWindow.focus?.();
      return true;
    }

    return false;
  }

  async function ensurePrimaryWindow(reason: string) {
    if (deps.canCreateWindow && !deps.canCreateWindow(reason)) {
      // Force-update is a process-level gate; activate/dock/tray/open-url entries share the same block.
      deps.logger.info(`[primary-window] window creation blocked (${reason})`);
      return;
    }

    if (revealExistingWindow()) {
      deps.logger.info(`[primary-window] reused existing window (${reason})`);
      return;
    }

    if (pendingEnsurePromise) {
      deps.logger.info(`[primary-window] window creation already pending (${reason})`);
      return pendingEnsurePromise;
    }

    // On macOS cold start, app.activate can race the startup path.
    // If ready and activate each resolved the bootstrap and created windows directly, the first
    // launch could open two main windows; a single-flight promise collapses to one.
    deps.logger.info(`[primary-window] creating main window (${reason})`);
    pendingEnsurePromise = deps
      .resolveStartupWindowBootstrap()
      .then((startupBootstrap) => {
        if (revealExistingWindow()) {
          deps.logger.info(`[primary-window] window became available before create (${reason})`);
          return;
        }

        deps.createWindow(startupBootstrap);
      })
      .finally(() => {
        pendingEnsurePromise = null;
      });

    return pendingEnsurePromise;
  }

  return {
    ensurePrimaryWindow,
  };
}
