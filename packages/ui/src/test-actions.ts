import type { TaskChatMessage as ChatMessage } from "@/lib/taskChatMessageTypes.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { IBotsService, IZCodeAgentService, IZCodeTaskService } from "@zcode/services";
import type { TaskListE2EActions } from "@/lib/taskListE2EActions.js";
import { useEffect } from "react";

// Vite-injected import.meta.env typings
declare global {
  interface ImportMeta {
    env: { PROD: boolean; DEV: boolean; [key: string]: unknown };
  }
}

/**
 * Actions callable via window.__testActions in E2E.
 * Registered outside production builds only.
 */
export interface TestActions extends TaskListE2EActions {
  /** Controlled E2E input uses the real Host bot service and CLI admission; no fake queues. */
  sendBotMessage: IBotsService["handleInboundMessage"];
  /** Controlled fixtures use the real task service, upload, and CLI queue; no injected rows. */
  submitBotGroupInput: NonNullable<IZCodeTaskService["submitBotGroupInput"]>;
  /** Get the active theme. */
  getTheme: () => string;
  /** Set the theme. */
  setTheme: (theme: "light" | "dark" | "zai-light" | "zai-dark" | "system") => void;
  /** Get the locale; cross-language display E2E only. */
  getLocale: () => "zh-CN" | "en-US";
  /** Set the locale; cross-language display E2E only. */
  setLocale: (locale: "zh-CN" | "en-US") => void;
  /** Inject mock messages for chat rendering. */
  setChatMessages: (messages: ChatMessage[]) => void;
  /** Get the current mock message count. */
  getChatMessageCount: () => number;
  /** E2E: plugin overview via the real zcodeAgentService. */
  getPluginsOverview: IZCodeAgentService["getPluginsOverview"];
  /** E2E: add a marketplace via the real zcodeAgentService. */
  addPluginMarketplace: IZCodeAgentService["addPluginMarketplace"];
  /** E2E: refresh marketplaces via the real zcodeAgentService. */
  updatePluginMarketplace: IZCodeAgentService["updatePluginMarketplace"];
  /** E2E: install a marketplace plugin via the real zcodeAgentService. */
  installPlugin: IZCodeAgentService["installPlugin"];
  /** E2E: trigger plugin discover via the real zcodeAgentService. */
  listPlugins: IZCodeAgentService["listPlugins"];
  /** E2E: query workspace/session plugin catalogs via the real zcodeAgentService. */
  getPluginReferenceCatalog: IZCodeAgentService["getPluginReferenceCatalog"];
}

declare global {
  interface Window {
    __testActions?: TestActions;
  }
}

/**
 * Registers test actions onto window.__testActions.
 * Skipped when import.meta.env.PROD is true (Vite).
 */
export function useTestActions(actions: TestActions) {
  useEffect(() => {
    // Production E2E renderers still need entries; a dedicated bridge flag opens them, no leaks.
    if (import.meta.env.PROD && !shouldExposeE2EStoreBridge()) return;
    window.__testActions = actions;
    return () => {
      actions.releaseTaskMembershipRefreshHold();
      delete window.__testActions;
    };
  }, [actions]);
}
