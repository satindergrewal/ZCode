import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, LoaderIcon } from "lucide-react";
import {
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlMobileNavigationIntent,
  type WebRemoteControlWorkspaceListResult,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  WebRemoteControlMobileTaskHome,
  persistWebRemoteControlMobileTaskHomePreferences,
  readWebRemoteControlMobileTaskHomePreferences,
  type WebRemoteControlMobileTaskHomePreferences,
} from "@/WebRemoteControlMobileTaskHome.js";
import { WebRemoteControlThemeMenu } from "@/WebRemoteControlThemeMenu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { WebRemoteControlTerminalTransportState } from "@/root/types.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import { useWebRemoteControlTerminalTransportState } from "@/webRemoteControlTerminalTransportState.js";

type WebRemoteControlMobilePage = "home" | "chat";

interface WebRemoteControlMobileHistoryState {
  zcodeMobilePage?: WebRemoteControlMobilePage;
}

export function isWebRemoteControlMobileChatHistoryState(
  state: unknown,
): state is WebRemoteControlMobileHistoryState {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as WebRemoteControlMobileHistoryState).zcodeMobilePage === "chat"
  );
}

function pushWebRemoteControlMobileChatHistory() {
  if (typeof window === "undefined") {
    return;
  }

  if (isWebRemoteControlMobileChatHistoryState(window.history.state)) {
    return;
  }

  window.history.pushState({ zcodeMobilePage: "chat" }, "");
}

function resolveInitialWebRemoteControlMobilePage(
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
): WebRemoteControlMobilePage {
  if (initialNavigationIntent === "chat") {
    return "chat";
  }

  // Bugfix: on chat refresh React memory state is lost but history.state survives;
  // reuse the state written on chat entry, or refresh lands on home despite the selected task.
  if (
    typeof window !== "undefined" &&
    isWebRemoteControlMobileChatHistoryState(window.history.state)
  ) {
    return "chat";
  }

  return "home";
}

export function WebRemoteControlMobileShell({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  chatContent,
  chatOverlay,
  initialNavigationIntent,
  initialWorkspaceList,
  isSidePaneOpen = false,
  onCloseSidePane,
  onSelectTask,
  onStartDraftInWorkspace,
  renderChatHeader,
  sidePaneContent,
  switcher,
  webRemoteControlTerminalTransportState,
}: {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  initialWorkspaceList?: WebRemoteControlWorkspaceListResult;
  isSidePaneOpen?: boolean;
  onCloseSidePane?: () => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onStartDraftInWorkspace?: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  renderChatHeader: (options: { onBackHome: () => void }) => ReactNode;
  chatContent: ReactNode;
  chatOverlay?: ReactNode;
  sidePaneContent?: ReactNode;
  webRemoteControlTerminalTransportState?: WebRemoteControlTerminalTransportState;
}) {
  const { intl } = useZCodeIntl();
  const [currentPage, setCurrentPage] = useState<WebRemoteControlMobilePage>(() =>
    resolveInitialWebRemoteControlMobilePage(initialNavigationIntent),
  );
  const [taskHomePreferences, setTaskHomePreferences] =
    useState<WebRemoteControlMobileTaskHomePreferences>(() =>
      readWebRemoteControlMobileTaskHomePreferences(),
    );
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const terminalTransportState = useWebRemoteControlTerminalTransportState(
    webRemoteControlTerminalTransportState,
  );
  const syncedMobileViewStateRef = useRef<string | null>(null);
  const shouldInertChatSurface = Boolean(sidePaneContent) && isSidePaneOpen;

  const navigateToChat = useCallback(() => {
    setCurrentPage("chat");
    pushWebRemoteControlMobileChatHistory();
  }, []);

  const handleTaskHomePreferencesChange = useCallback(
    (preferences: WebRemoteControlMobileTaskHomePreferences) => {
      // Bugfix: entering a task only unmounts the home; shell memory keeps sort prefs,
      // but a refresh rebuilds the tree and defaults would override the user's choice;
      // mirror to localStorage so a refresh restores the same sort/grouping.
      persistWebRemoteControlMobileTaskHomePreferences(preferences);
      logger.debug("[WebRemoteControlMobileShell] phone home preferences updated", preferences);
      setTaskHomePreferences(preferences);
    },
    [],
  );

  const navigateHome = useCallback(() => {
    setHomeRefreshKey((key) => key + 1);
    if (
      typeof window !== "undefined" &&
      isWebRemoteControlMobileChatHistoryState(window.history.state)
    ) {
      window.history.back();
      return;
    }

    setCurrentPage("home");
  }, []);

  useEffect(() => {
    if (initialNavigationIntent !== "chat") {
      return;
    }

    navigateToChat();
  }, [initialNavigationIntent, navigateToChat]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handlePopState = (event: PopStateEvent) => {
      const nextPage = isWebRemoteControlMobileChatHistoryState(event.state) ? "chat" : "home";
      setCurrentPage(nextPage);
      if (nextPage === "home") {
        setHomeRefreshKey((key) => key + 1);
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    if (!switcher.updateMobileViewState) {
      return;
    }
    const workspaceKey = resolveWebRemoteControlWorkspaceKey({
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
    });
    const dedupeKey = `${workspaceKey}:${activeTaskId ?? ""}`;
    if (syncedMobileViewStateRef.current === dedupeKey) {
      return;
    }
    syncedMobileViewStateRef.current = dedupeKey;

    // Bugfix: new-task/fork auto-switches tasks but only explicit list clicks reported mobileViewState,
    // so desktop kept the phone on the old task and list refreshes lagged;
    // sync on activeTaskId change so cross-device selection and lists converge.
    void switcher.updateMobileViewState(workspaceKey, activeTaskId ?? undefined).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[WebRemoteControlMobileShell] failed to sync mobileViewState", {
        error: message,
        workspaceKey,
        taskId: activeTaskId ?? null,
      });
    });
  }, [activeTaskId, activeWorkspaceIdentity, activeWorkspacePath, switcher]);

  // Bugfix: chat/sidebar are flex children; min-width:auto sized drawers to long-message
  // min-content and clipped body text on narrow screens; allow shrinking down the
  // whole width chain so subagent output, panes, and body wrap inside the drawer.
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-background">
      {currentPage === "home" ? (
        <WebRemoteControlMobileTaskHome
          activeTaskId={activeTaskId}
          activeWorkspaceIdentity={activeWorkspaceIdentity}
          activeWorkspacePath={activeWorkspacePath}
          initialResult={initialWorkspaceList}
          onCrossWorkspaceSwitchingChange={setSwitchingWorkspace}
          onNavigateHome={navigateHome}
          onNavigateToChat={navigateToChat}
          preferences={taskHomePreferences}
          onPreferencesChange={handleTaskHomePreferencesChange}
          refreshKey={homeRefreshKey}
          onSelectTask={onSelectTask}
          onStartDraftInWorkspace={onStartDraftInWorkspace}
          switcher={switcher}
        />
      ) : (
        <section
          className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
          data-mobile-page="chat"
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-header px-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({
                id: "webRemoteControl.mobileShell.backHome",
              })}
              onClick={navigateHome}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
              {intl.formatMessage({ id: "webRemoteControl.mobileShell.chatTitle" })}
            </span>
            <WebRemoteControlThemeMenu />
          </div>
          {renderChatHeader({ onBackHome: navigateHome })}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <main
              className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              aria-hidden={shouldInertChatSurface ? true : undefined}
              data-mobile-chat-surface={shouldInertChatSurface ? "inert" : undefined}
              inert={shouldInertChatSurface ? true : undefined}
            >
              {/* Bugfix: with the sidebar open it covers the bottom composer.
                  Chat left interactable keeps controls hit-testable under the drawer,
                  the classic dead-button trap. Mark the covered chat surface inert so the right
                  drawer is the only interactable area. */}
              {chatContent}
            </main>
            {sidePaneContent ? (
              <div
                className={[
                  "absolute inset-0 z-30 transition-opacity duration-200 ease-out",
                  isSidePaneOpen ? "opacity-100" : "pointer-events-none opacity-0",
                ].join(" ")}
                aria-hidden={!isSidePaneOpen}
                data-mobile-side-pane-overlay="true"
              >
                <button
                  type="button"
                  className="absolute inset-0 bg-background/60 backdrop-blur-[1px]"
                  aria-label={intl.formatMessage({ id: "sidePane.collapse" })}
                  onClick={onCloseSidePane}
                />
                <div
                  className={[
                    "absolute top-0 right-0 h-full w-[min(88vw,28rem)] max-w-full border-l border-border bg-background shadow-2xl transition-transform duration-200 ease-out",
                    isSidePaneOpen ? "translate-x-0" : "translate-x-full",
                  ].join(" ")}
                >
                  {/* Bugfix: the side pane rendered as a bottom panel, squeezing chat and
                      unlike desktop's right rail. Now a right overlay drawer, phone chat only;
                      the desktop split layout is untouched. */}
                  {sidePaneContent}
                </div>
              </div>
            ) : null}
            {chatOverlay ? (
              <div
                className="pointer-events-none absolute inset-0 z-40"
                data-mobile-chat-overlay="true"
              >
                {/* Bugfix: find belongs to chat visuals but must not descend from the inert surface;
                    a separate overlay keeps drawer isolation while find stays focusable/closable. */}
                <div className="pointer-events-auto">{chatOverlay}</div>
              </div>
            ) : null}
          </div>
        </section>
      )}

      {switchingWorkspace ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-background/72 backdrop-blur-[1px]"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle shadow-sm">
            <LoaderIcon className="size-4 animate-spin" />
            {intl.formatMessage({ id: "common.loading" })}
          </div>
        </div>
      ) : null}
      {terminalTransportState === "reconnecting" ? (
        <div
          className="pointer-events-none absolute top-3 left-1/2 z-50 flex -translate-x-1/2 justify-center px-3"
          aria-live="polite"
          aria-busy="true"
          data-web-remote-control-reconnect-notice="true"
        >
          <div className="flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-lg border border-border bg-toast px-3 py-2 text-ui-base text-foreground shadow-lg">
            <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground-subtle" />
            <span className="min-w-0 whitespace-nowrap">
              {intl.formatMessage({ id: "webRemoteControl.mobileShell.reconnecting" })}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
