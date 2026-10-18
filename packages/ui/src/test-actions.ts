import type { TaskChatMessage as ChatMessage } from "@/lib/taskChatMessageTypes.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { IZCodeAgentService } from "@zcode/services";
import type { TaskListE2EActions } from "@/lib/taskListE2EActions.js";
import { useEffect } from "react";

// Vite-injected import.meta.env type declaration
declare global {
  interface ImportMeta {
    env: { PROD: boolean; DEV: boolean; [key: string]: unknown };
  }
}

/**
 * Actions callable via window.__testActions from E2E tests.
 * Registered only outside production builds to avoid leaking into production.
 */
export interface TestActions extends TaskListE2EActions {
  /** Get the current theme */
  getTheme: () => string;
  /** Set the theme */
  setTheme: (theme: "light" | "dark" | "zai-light" | "zai-dark" | "system") => void;
  /** Get the current locale; for cross-locale rendering E2E only */
  getLocale: () => "zh-CN" | "en-US";
  /** Set the current locale; for cross-locale rendering E2E only */
  setLocale: (locale: "zh-CN" | "en-US") => void;
  /** Inject mock messages for chat rendering */
  setChatMessages: (messages: ChatMessage[]) => void;
  /** Get the current mock message count */
  getChatMessageCount: () => number;
  /** E2E: fetch the plugin overview via the real zcodeAgentService */
  getPluginsOverview: IZCodeAgentService["getPluginsOverview"];
  /** E2E: add a marketplace via the real zcodeAgentService */
  addPluginMarketplace: IZCodeAgentService["addPluginMarketplace"];
  /** E2E: refresh a marketplace via the real zcodeAgentService */
  updatePluginMarketplace: IZCodeAgentService["updatePluginMarketplace"];
  /** E2E: install a marketplace plugin via the real zcodeAgentService */
  installPlugin: IZCodeAgentService["installPlugin"];
  /** E2E: trigger plugin discovery via the real zcodeAgentService */
  listPlugins: IZCodeAgentService["listPlugins"];
  /** E2E: query the Workspace/Session plugin catalog via the real zcodeAgentService */
  getPluginReferenceCatalog: IZCodeAgentService["getPluginReferenceCatalog"];
}

declare global {
  interface Window {
    __testActions?: TestActions;
  }
}

/**
 * Register the test actions on window.__testActions.
 * Skipped only when import.meta.env.PROD is true (Vite builds).
 */
export function useTestActions(actions: TestActions) {
  useEffect(() => {
    // The E2E production renderer still needs the service entry; it is enabled only via the
    // dedicated bridge flag so plain production bundles stay clean.
    if (import.meta.env.PROD && !shouldExposeE2EStoreBridge()) return;
    window.__testActions = actions;
    return () => {
      actions.releaseTaskMembershipRefreshHold();
      delete window.__testActions;
    };
  }, [actions]);
}
