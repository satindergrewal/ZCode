/* eslint-disable max-lines -- terminal resize scheduling must stay in one component with the xterm/PTY lifecycles; splitting drag state, fit, and the backend resize queue apart invites races. */
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { ClipboardPaste, Copy } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import type { ILink, ILinkHandler, ITheme, IWindowsPty } from "@xterm/xterm";
import type { IServiceAccessor } from "@zcode/services";
import type { IDisposable } from "@zcode/rpc";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  createPendingTerminalInputFallback,
  consumeTerminalInputFallbackHandledData,
  createTerminalInputFallbackKeydownCandidate,
  markTerminalInputFallbackHandled,
  recordTerminalInputFallbackHandledData,
  recordTerminalInputFallbackRecentData,
  resolveTerminalInputFallbackAction,
  type PendingTerminalInputFallback,
  type TerminalInputFallbackKeydownCandidate,
  type TerminalInputFallbackHandledData,
} from "@/terminal/terminalComposedInputFallback.js";
import { normalizePowerShellReadlineRedraw } from "@/terminal/terminalDataTransform.js";
import { getHttpLinksForTerminalBufferLine } from "@/terminal/terminalLinks.js";
import { mergeTerminalTheme } from "@/terminal/terminalTheme.js";
import {
  sidePaneTerminalSessionRegistry,
  type SidePaneTerminalSessionEntry,
} from "@/terminal/sidePaneTerminalSessionRegistry.js";

const DEFAULT_TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Cascadia Mono', 'JetBrains Mono', 'MesloLGS NF', 'Hack Nerd Font', monospace";
const TERMINAL_RESIZE_DRAG_THROTTLE_MS = 300;
const TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS = 150;
const TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS = 40;
const TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS = 150;

type TerminalResizeReason = "drag" | "final" | "visible" | "init" | "observer";

type TerminalSize = {
  cols: number;
  rows: number;
};

function normalizeWindowsPtyOption(windowsPty: IWindowsPty | undefined): IWindowsPty | undefined {
  if (!windowsPty) return undefined;
  return windowsPty.buildNumber
    ? { backend: windowsPty.backend, buildNumber: windowsPty.buildNumber }
    : { backend: windowsPty.backend };
}

function normalizeTerminalFontSize(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 6 || value > 72) {
    return undefined;
  }
  return value;
}

function formatShellLabel(shell: string | null): string | null {
  if (!shell) {
    return null;
  }

  const shellParts = shell.split(/[\\/]/);
  const lastPart = shellParts[shellParts.length - 1];
  const name = lastPart?.replace(/\.exe$/i, "").toLowerCase();
  if (!name) {
    return shell;
  }
  if (name === "powershell" || name === "pwsh") {
    return "PowerShell";
  }
  return name;
}

function isHttpTerminalUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

export function TerminalSession({
  sessionId,
  services,
  cwd,
  isVisible,
  isPanelResizing = false,
  isWindowsDesktop = false,
  onShellLabelChange,
  onExit,
  onOpenBrowserUrl,
  persistentKey,
  workspaceKey,
}: {
  sessionId: string;
  services: IServiceAccessor;
  cwd?: string;
  isVisible: boolean;
  isPanelResizing?: boolean;
  isWindowsDesktop?: boolean;
  onShellLabelChange: (sessionId: string, shellLabel: string | null) => void;
  onExit?: (sessionId: string, exitCode: number) => void;
  onOpenBrowserUrl: (url: string) => void;
  /**
   * Session-reuse key surviving component lifecycles (side pane terminal only).
   * When set, xterm instance + PTY ownership moves up into the sidePaneTerminalSessionRegistry
   * module singleton; unmount only detaches the DOM without disposing, remount reuses by key,
   * and scrollback history survives workspace switches.
   * When omitted (bottom terminal pane) the original effect path runs, byte-identical.
   */
  persistentKey?: string;
  /**
   * Workspace identity isolation key (= workspaceIdentity?.trim() || workspacePath).
   * persistentKey path only: written to registry entry.workspaceKey so PTYs are bulk-reclaimed
   * by workspaceKey when a workspace tab is actually closed (mirroring the bottom pane's
   * openWorkspaceKeys reclamation). Falls back to cwd when absent; the bottom pane passes no
   * persistentKey, so the value has no effect there.
   */
  workspaceKey?: string;
}) {
  const { intl } = useZCodeIntl();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | undefined>(undefined);
  const isVisibleRef = useRef(isVisible);
  const resizeRAFRef = useRef(0);
  const resizeThrottleTimerRef = useRef<number | null>(null);
  const isPanelResizingRef = useRef(isPanelResizing);
  const resizeRequestStatsRef = useRef({ fit: 0, queued: 0, sent: 0, skipped: 0 });
  const lastSentTerminalSizeRef = useRef<TerminalSize | null>(null);
  const pendingTerminalSizeRef = useRef<TerminalSize | null>(null);
  const resizeInFlightRef = useRef(false);
  const focusRAFRef = useRef(0);
  const exitedMessageRef = useRef("");
  const exitHandlerRef = useRef(onExit);
  const openBrowserUrlRef = useRef(onOpenBrowserUrl);
  const terminalProfileThemeRef = useRef<ITheme | undefined>(undefined);
  const pendingInputFallbacksRef = useRef<PendingTerminalInputFallback[]>([]);
  const inputFallbackKeydownCandidateRef = useRef<TerminalInputFallbackKeydownCandidate | null>(
    null,
  );
  const recentInputFallbackHandledDataRef = useRef<TerminalInputFallbackHandledData[]>([]);

  exitedMessageRef.current = intl.formatMessage({ id: "terminal.exited" });
  exitHandlerRef.current = onExit;
  openBrowserUrlRef.current = onOpenBrowserUrl;

  const flushTerminalServiceResize = useCallback(() => {
    if (resizeInFlightRef.current) {
      return;
    }

    const terminalId = terminalIdRef.current;
    const pendingSize = pendingTerminalSizeRef.current;
    if (!terminalId || !pendingSize) {
      return;
    }

    pendingTerminalSizeRef.current = null;
    resizeInFlightRef.current = true;
    resizeRequestStatsRef.current.sent += 1;

    const startedAt = performance.now();
    void services.terminalService
      .resize({
        id: terminalId,
        cols: pendingSize.cols,
        rows: pendingSize.rows,
      })
      .then(() => {
        logger.debug("[Terminal] resize sent", {
          cols: pendingSize.cols,
          durationMs: Math.round(performance.now() - startedAt),
          fitCount: resizeRequestStatsRef.current.fit,
          queuedCount: resizeRequestStatsRef.current.queued,
          rows: pendingSize.rows,
          sentCount: resizeRequestStatsRef.current.sent,
          skippedCount: resizeRequestStatsRef.current.skipped,
          terminalId,
          terminalTabId: sessionId,
        });
      })
      .catch((error) => {
        logger.warn("[Terminal] resize failed:", error);
      })
      .finally(() => {
        resizeInFlightRef.current = false;
        if (pendingTerminalSizeRef.current) {
          flushTerminalServiceResize();
        }
      });
  }, [services.terminalService, sessionId]);

  const queueTerminalServiceResize = useCallback(
    (size: TerminalSize) => {
      const lastSentSize = lastSentTerminalSizeRef.current;
      const pendingSize = pendingTerminalSizeRef.current;
      if (
        (lastSentSize?.cols === size.cols && lastSentSize.rows === size.rows && !pendingSize) ||
        (pendingSize?.cols === size.cols && pendingSize.rows === size.rows)
      ) {
        resizeRequestStatsRef.current.skipped += 1;
        return;
      }

      pendingTerminalSizeRef.current = size;
      lastSentTerminalSizeRef.current = size;
      resizeRequestStatsRef.current.queued += 1;
      flushTerminalServiceResize();
    },
    [flushTerminalServiceResize],
  );

  const clearResizeThrottleTimer = useCallback(() => {
    if (resizeThrottleTimerRef.current) {
      window.clearTimeout(resizeThrottleTimerRef.current);
      resizeThrottleTimerRef.current = null;
    }
  }, []);

  const requestFitAndResize = useCallback(
    (reason: TerminalResizeReason = "observer") => {
      if (resizeRAFRef.current) {
        cancelAnimationFrame(resizeRAFRef.current);
      }

      resizeRAFRef.current = requestAnimationFrame(() => {
        resizeRAFRef.current = 0;
        const el = containerRef.current;
        const term = termRef.current;
        const fitAddon = fitAddonRef.current;
        if (
          !isVisibleRef.current ||
          !el ||
          !term ||
          !fitAddon ||
          el.clientWidth <= 0 ||
          el.clientHeight <= 0
        ) {
          return;
        }

        try {
          resizeRequestStatsRef.current.fit += 1;
          fitAddon.fit();
        } catch (error) {
          logger.warn("[Terminal] fit failed:", error);
          return;
        }

        logger.debug("[Terminal] fit requested resize", {
          cols: term.cols,
          reason,
          resizing: isPanelResizingRef.current,
          rows: term.rows,
          terminalId: terminalIdRef.current,
          terminalTabId: sessionId,
        });
        queueTerminalServiceResize({ cols: term.cols, rows: term.rows });
      });
    },
    [queueTerminalServiceResize, sessionId],
  );

  const scheduleFitAndResize = useCallback(
    (reason: TerminalResizeReason = "observer") => {
      if (!isPanelResizingRef.current || reason === "final") {
        clearResizeThrottleTimer();
        requestFitAndResize(reason);
        return;
      }

      if (resizeThrottleTimerRef.current) {
        return;
      }

      // While the terminal height is dragged, ResizeObserver fires on every layout frame.
      // xterm fit + PTY resize mix synchronous layout with a cross-process request, so during
      // the drag only preview at a constant low rate; flush the final size on release.
      resizeThrottleTimerRef.current = window.setTimeout(() => {
        resizeThrottleTimerRef.current = null;
        requestFitAndResize("drag");
      }, TERMINAL_RESIZE_DRAG_THROTTLE_MS);
    },
    [clearResizeThrottleTimer, requestFitAndResize],
  );

  const requestFocus = useCallback(() => {
    if (focusRAFRef.current) {
      cancelAnimationFrame(focusRAFRef.current);
    }

    focusRAFRef.current = requestAnimationFrame(() => {
      focusRAFRef.current = 0;
      const term = termRef.current;
      if (!isVisibleRef.current || !term) {
        return;
      }

      // On open/create/switch React only updates the visible tab; focus still sits on a button
      // or input. xterm's textarea appears after open, so wait a frame and re-check visibility
      // before focusing.
      term.focus();
      logger.debug("[Terminal] focused visible terminal", {
        terminalId: terminalIdRef.current,
        terminalTabId: sessionId,
      });
    });
  }, [sessionId]);

  useEffect(() => {
    isVisibleRef.current = isVisible;
    if (isVisible) {
      scheduleFitAndResize("visible");
      requestFocus();
    }
  }, [isVisible, requestFocus, scheduleFitAndResize]);

  useEffect(() => {
    const wasResizing = isPanelResizingRef.current;
    isPanelResizingRef.current = isPanelResizing;
    if (wasResizing && !isPanelResizing && isVisibleRef.current) {
      scheduleFitAndResize("final");
    }
  }, [isPanelResizing, scheduleFitAndResize]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // ===== persistentKey path: side pane terminal session keep-alive across workspaces =====
    // xterm instance + PTY ownership moves up into the sidePaneTerminalSessionRegistry module
    // singleton; unmount only detaches the DOM without disposing, remount reuses by
    // persistentKey, and scrollback survives workspace switches.
    // The original path (bottom pane, no persistentKey) stays byte-identical.
    if (persistentKey) {
      terminalProfileThemeRef.current = undefined;
      const existingEntry = sidePaneTerminalSessionRegistry.get(persistentKey);

      // --- Fast reuse path: workspace switch back / remount, entry already in registry ---
      if (existingEntry) {
        termRef.current = existingEntry.term;
        fitAddonRef.current = existingEntry.fitAddon;
        terminalIdRef.current = existingEntry.terminalId || undefined;
        el.appendChild(existingEntry.hostEl);
        const reuseThemeObserver = new MutationObserver(() => {
          // Read from entry.profileTheme: after remount the component-local ref reset to
          // undefined, and the profile theme only lives on the registry entry -- reading
          // anywhere else loses the user's terminal colors.
          existingEntry.term.options.theme = mergeTerminalTheme(existingEntry.profileTheme);
        });
        reuseThemeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        });
        let reuseResizeRAF = 0;
        const reuseResizeObserver = new ResizeObserver(() => {
          if (!isVisibleRef.current) return;
          if (reuseResizeRAF) cancelAnimationFrame(reuseResizeRAF);
          reuseResizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
        });
        reuseResizeObserver.observe(el);
        try {
          resizeRequestStatsRef.current.fit += 1;
          existingEntry.fitAddon.fit();
        } catch (error) {
          logger.warn("[Terminal] persistent reuse fit failed:", error);
        }
        if (isVisibleRef.current) {
          requestFocus();
        }
        logger.debug("[Terminal] persistent reuse", {
          terminalTabId: sessionId,
          persistentKey,
        });
        return () => {
          reuseThemeObserver.disconnect();
          reuseResizeObserver.disconnect();
          if (reuseResizeRAF) cancelAnimationFrame(reuseResizeRAF);
          sidePaneTerminalSessionRegistry.detachDom(persistentKey);
          // No dispose: term/PTY/subscriptions stay in the registry for reuse.
          termRef.current = null;
          fitAddonRef.current = null;
        };
      }

      // --- First creation: persistent hostEl, term.open into hostEl, resources into the registry ---
      const hostEl = document.createElement("div");
      hostEl.className = "terminal-xterm-shell h-full min-h-0 w-full overflow-hidden";
      el.appendChild(hostEl);

      let ptyCancelled = false;
      const registryDisposers: IDisposable[] = [];
      const localDisposers: IDisposable[] = [];

      const term = new XTerm({
        fontSize: 13,
        fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
        theme: mergeTerminalTheme(terminalProfileThemeRef.current),
        linkHandler: {
          allowNonHttpProtocols: false,
          activate(event, text) {
            if (!isHttpTerminalUrl(text)) return;
            event.preventDefault();
            logger.debug("[Terminal] open OSC 8 http link", { url: text });
            openBrowserUrlRef.current(text);
          },
        } satisfies ILinkHandler,
      });
      termRef.current = term;

      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      term.loadAddon(fitAddon);
      term.loadAddon(new ClipboardAddon());
      term.open(hostEl);

      let initialTerminalSize: TerminalSize | null = null;
      if (isVisibleRef.current && hostEl.clientWidth > 0 && hostEl.clientHeight > 0) {
        try {
          resizeRequestStatsRef.current.fit += 1;
          fitAddon.fit();
          initialTerminalSize = { cols: term.cols, rows: term.rows };
          lastSentTerminalSizeRef.current = initialTerminalSize;
          logger.debug("[Terminal] initial fit before create (persistent)", {
            cols: initialTerminalSize.cols,
            rows: initialTerminalSize.rows,
            terminalTabId: sessionId,
          });
        } catch (error) {
          logger.warn("[Terminal] persistent initial fit failed:", error);
        }
      }
      if (isVisibleRef.current) {
        requestFocus();
      }

      // Component-local: customKeyEventHandler (depends on the component inputFallback ref)
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        inputFallbackKeydownCandidateRef.current =
          e.metaKey || e.ctrlKey || e.altKey
            ? null
            : createTerminalInputFallbackKeydownCandidate({
                eventTimeStamp: e.timeStamp,
                key: e.key,
                now: performance.now(),
              });
        if (!(e.metaKey || e.ctrlKey)) return true;
        const key = e.key.toLowerCase();
        if (key === "c" && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
            logger.warn("[Terminal] copy via shortcut failed:", err);
          });
          return false;
        }
        if (key === "v") {
          // Returning false from attachCustomKeyEventHandler only stops xterm handling Ctrl+V;
          // it does not cancel the native paste event the browser dispatches afterwards. A
          // manual paste here plus the native paste being written again by xterm's built-in
          // listener would duplicate the shortcut paste. So the default event must be cancelled
          // while keeping the single manual clipboard read/write.
          // Byte-aligned with the original path (bottom pane): the two copies drifted here once
          // (persistentKey missed a debug log); delete this comment once a future refactor
          // converges them into a single wireTerminalProcessing.
          e.preventDefault();
          e.stopPropagation();
          navigator.clipboard
            .readText()
            .then((text) => {
              logger.debug("[Terminal] paste via shortcut", { length: text.length });
              if (text) term.paste(text);
            })
            .catch((err) => logger.warn("[Terminal] paste via shortcut failed:", err));
          return false;
        }
        return true;
      });

      // Component-local: theme observer
      const themeObserver = new MutationObserver(() => {
        // Read from entry.profileTheme: profile theme ownership lives on the registry entry and
        // survives remounts; the component-local terminalProfileThemeRef loses it on remount and
        // must not be the observer's data source.
        term.options.theme = mergeTerminalTheme(entry.profileTheme);
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      localDisposers.push({ dispose: () => themeObserver.disconnect() } as IDisposable);

      // Into the registry: linkProvider (harmless to keep while detached)
      registryDisposers.push(
        term.registerLinkProvider({
          provideLinks(bufferLineNumber, callback) {
            const links = getHttpLinksForTerminalBufferLine(
              term.buffer.active,
              bufferLineNumber,
              term.cols,
            )?.map(
              (link): ILink => ({
                ...link,
                activate(event, text) {
                  event.preventDefault();
                  logger.debug("[Terminal] open plain http link", { url: text });
                  openBrowserUrlRef.current(text);
                },
              }),
            );
            callback(links);
          },
        }),
      );

      // Placeholder-register the entry (terminalId filled in async); remount/reclaim checks rely on it.
      const entry: SidePaneTerminalSessionEntry = {
        key: persistentKey,
        term,
        fitAddon,
        terminalId: "",
        cwd: cwd ?? "",
        // workspaceKey bulk-reclaims by workspace when the workspace tab is actually closed
        // (mirrors the bottom pane's openWorkspaceKeys).
        workspaceKey: workspaceKey ?? cwd ?? "",
        hostEl,
        dispose: () => {}, // completed right below
      };
      entry.dispose = () => {
        ptyCancelled = true;
        for (const d of registryDisposers) {
          try {
            d.dispose();
          } catch (error) {
            logger.warn("[Terminal] persistent dispose disposer failed:", error);
          }
        }
        if (entry.terminalId) {
          void services.terminalService.dispose({ id: entry.terminalId });
        }
        try {
          term.dispose();
        } catch (error) {
          logger.warn("[Terminal] persistent term.dispose failed:", error);
        }
      };
      sidePaneTerminalSessionRegistry.register(persistentKey, entry);

      // Create the PTY (async).
      const initialCreateSize = initialTerminalSize ?? { cols: term.cols, rows: term.rows };
      void services.terminalService
        .create({ cols: initialCreateSize.cols, rows: initialCreateSize.rows, cwd })
        .then(({ id, shell, fontFamily, fontSize, theme, fontFamilySource, windowsPty }) => {
          if (ptyCancelled) {
            // Cleanup already ran: kill this orphan PTY, never enters the entry.
            void services.terminalService.dispose({ id });
            return;
          }
          entry.terminalId = id;
          terminalIdRef.current = id;
          // Mirrors the original path: flush resizes queued during creation
          // (pendingTerminalSizeRef) as soon as the id is ready. Otherwise
          // scheduleFitAndResize("init") dedupes via pendingSize and the PTY stays on the
          // wrong cols/rows.
          flushTerminalServiceResize();
          term.options.windowsPty = normalizeWindowsPtyOption(windowsPty);
          term.options.fontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
          const nextFontSize = normalizeTerminalFontSize(fontSize);
          if (nextFontSize) {
            term.options.fontSize = nextFontSize;
          }
          terminalProfileThemeRef.current = theme as ITheme | undefined;
          // Profile theme ownership moves up to the registry entry so reuse across component
          // lifecycles keeps it (writing only the component-local ref meant a remounted
          // component's ref was undefined -> reuse observer merged undefined -> theme lost).
          entry.profileTheme = theme as ITheme | undefined;
          term.options.theme = mergeTerminalTheme(entry.profileTheme);
          const nextShellLabel = formatShellLabel(shell);
          logger.info("[Terminal] shell resolved (persistent):", {
            cwd,
            fontFamilySource,
            shell,
            shellLabel: nextShellLabel,
            terminalId: id,
            terminalTabId: sessionId,
          });
          onShellLabelChange(sessionId, nextShellLabel);
          scheduleFitAndResize("init");
          if (isVisibleRef.current) {
            requestFocus();
          }

          // data subscription -> term.write (into the registry; scrollback keeps accumulating
          // while detached)
          registryDisposers.push(
            services.terminalService.onDynamicData(id)((data) => {
              term.write(normalizePowerShellReadlineRedraw(data, shell));
            }),
          );
          // exit subscription (into the registry, mirroring the original path: call onExit when
          // provided, otherwise write the exited notice)
          registryDisposers.push(
            services.terminalService.onDynamicExit(id)((exitCode) => {
              const exitHandler = exitHandlerRef.current;
              logger.info("[Terminal] persistent session exited", {
                autoClose: Boolean(exitHandler),
                exitCode,
                terminalId: id,
                terminalTabId: sessionId,
              });
              if (exitHandler) {
                exitHandler(sessionId, exitCode);
                return;
              }
              // The side pane Terminal passes no onExit; keep the exited notice.
              term.write(`\r\n${exitedMessageRef.current}\r\n`);
            }),
          );

          // onData (into the registry, lives with term):
          // Must not go into localDisposers: cleanup(detach) would cancel it while the reuse
          // path never re-binds, leaving scrollback visible but input dead after switching
          // workspace back. The input subscription's lifetime must equal the entry's lifetime
          // (lives with term); detach does not cancel it.
          //
          // Identical to the bottom pane's onData: maintains the keydown-candidate dedupe
          // history consumed by the Windows IME textarea fallback (the three-stage dedupe loop
          // for committed composition text).
          // Note: this block only dedupes committed composition text and has nothing to do with
          // Shift-based IME switching -- that is an IME-system behavior (customKeyEventHandler
          // returns true for Shift). The real root cause of "chars lost after Shift to English"
          // was isWindowsDesktop not being threaded through (fixed in WorkspaceShellLayout).
          registryDisposers.push(
            term.onData((data) => {
              const now = performance.now();
              const inputFallbackKeydownCandidate = inputFallbackKeydownCandidateRef.current;
              const handledData = recordTerminalInputFallbackHandledData({
                candidate: inputFallbackKeydownCandidate,
                data,
                history: recentInputFallbackHandledDataRef.current,
                maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                now,
              });
              recentInputFallbackHandledDataRef.current = handledData.usedCandidate
                ? handledData.history
                : recordTerminalInputFallbackRecentData({
                    data,
                    history: handledData.history,
                    maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                    now,
                  });
              if (handledData.usedCandidate) {
                inputFallbackKeydownCandidateRef.current = null;
              }
              markTerminalInputFallbackHandled(pendingInputFallbacksRef.current, data);
              void services.terminalService.write({ id, data });
            }),
          );

          // Windows IME fallback (into the registry, lives with term, same lifetime as onData).
          // The textarea element lives with the term instance, so binding once is enough; detach
          // does not cancel and the CJK-IME fallback keeps working after remount.
          const textarea =
            isWindowsDesktop &&
            (term as unknown as { _core: { textarea: HTMLTextAreaElement } })._core?.textarea;
          if (textarea) {
            const handleInput = (e: InputEvent) => {
              if (e.inputType !== "insertText" || !e.data || !e.composed) return;
              const insertedText = e.data;
              const now = performance.now();
              const pendingFallback = createPendingTerminalInputFallback(insertedText);
              pendingInputFallbacksRef.current.push(pendingFallback);
              consumeTerminalInputFallbackHandledData({
                history: recentInputFallbackHandledDataRef.current,
                inputEventTimeStamp: e.timeStamp,
                maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                maxInputDelayMs: TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS,
                now,
                pending: pendingFallback,
              });
              setTimeout(() => {
                pendingInputFallbacksRef.current = pendingInputFallbacksRef.current.filter(
                  (item) => item !== pendingFallback,
                );
                // Do not check ptyCancelled: the subscription lives with the entry
                // (registryDisposers), while ptyCancelled is a single-effect closure variable
                // that turns true on detach and would kill the fallback forever. release runs
                // entry.dispose which removes this listener; after PTY disposal write is a
                // no-op, so this is safe.
                const fallbackAction = resolveTerminalInputFallbackAction({
                  pending: pendingFallback,
                  textareaValue: textarea.value,
                });
                if (fallbackAction.shouldWrite) {
                  logger.debug("[Terminal] flush composed input fallback (persistent)", {
                    length: insertedText.length,
                    terminalId: id,
                    terminalTabId: sessionId,
                  });
                  void services.terminalService.write({ id, data: insertedText });
                }
                if (fallbackAction.shouldClearTextarea) {
                  textarea.value = "";
                }
              }, TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS);
            };
            textarea.addEventListener("input", handleInput, true);
            registryDisposers.push({
              dispose: () => textarea.removeEventListener("input", handleInput, true),
            } as IDisposable);
          }
        })
        .catch((error) => {
          if (ptyCancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          logger.error("[Terminal] persistent create failed:", error);
          term.write(`\r\n[Terminal failed to start]\r\n${message}\r\n`);
          // A failed PTY create must release the placeholder entry left in the registry.
          // The entry is registered up front with terminalId="" (see above) before the async
          // terminalService.create(). Without release, a zombie entry with terminalId="" stays
          // in the registry; remount/workspace-switch hits the fast reuse path (existingEntry
          // branch above), reuses the half-started xterm, and never calls
          // terminalService.create() again -- that terminal could never reach a PTY.
          //
          // Ownership check (the safe variant): release only if the registry's current entry is
          // still the one created here. Edge sequencing: before the create rejection fires, the
          // component may already have unmounted (cleanup released the half-built entry, see the
          // !entry.terminalId branch below), remounted, and the registry now holds a newer
          // entry; a blind release would delete the new one. Comparing the closure `entry`
          // against the registry's current value distinguishes generations for free, since every
          // creation makes a new entry object.
          const currentEntry = sidePaneTerminalSessionRegistry.get(persistentKey);
          if (currentEntry === entry) {
            sidePaneTerminalSessionRegistry.release(persistentKey);
          }
        });

      // Component-local: resize observer
      let resizeRAF = 0;
      const resizeObserver = new ResizeObserver(() => {
        if (!isVisibleRef.current) return;
        if (resizeRAF) cancelAnimationFrame(resizeRAF);
        resizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
      });
      resizeObserver.observe(el);

      logger.debug("[Terminal] persistent create", {
        terminalTabId: sessionId,
        persistentKey,
      });

      return () => {
        ptyCancelled = true;
        themeObserver.disconnect();
        resizeObserver.disconnect();
        if (resizeRAF) cancelAnimationFrame(resizeRAF);
        for (const d of localDisposers) {
          try {
            d.dispose();
          } catch (error) {
            logger.warn("[Terminal] persistent cleanup local disposer failed:", error);
          }
        }
        // Unmounted before the PTY was ready (rare): reclaim the half-built entry so a remount
        // cannot reuse an empty PTY.
        if (!entry.terminalId) {
          sidePaneTerminalSessionRegistry.release(persistentKey);
        } else {
          sidePaneTerminalSessionRegistry.detachDom(persistentKey);
        }
        termRef.current = null;
        fitAddonRef.current = null;
      };
    }
    // ===== persistentKey path end =====

    let disposed = false;
    terminalProfileThemeRef.current = undefined;

    const term = new XTerm({
      fontSize: 13,
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      theme: mergeTerminalTheme(terminalProfileThemeRef.current),
      linkHandler: {
        allowNonHttpProtocols: false,
        activate(event, text) {
          if (!isHttpTerminalUrl(text)) {
            return;
          }
          event.preventDefault();
          logger.debug("[Terminal] open OSC 8 http link", { url: text });
          openBrowserUrlRef.current(text);
        },
      } satisfies ILinkHandler,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    // ClipboardAddon for OSC 52 support, and so xterm's copy event writes the selection to the
    // system clipboard.
    term.loadAddon(new ClipboardAddon());
    term.open(el);
    let initialTerminalSize: TerminalSize | null = null;
    if (isVisibleRef.current && el.clientWidth > 0 && el.clientHeight > 0) {
      try {
        // Creating the PTY with xterm's default cols and fitting afterwards makes startup
        // output reflow at the wrong width once fit/resize lands; zsh can show an inverted
        // PROMPT_EOL_MARK. On first visibility, fit synchronously and only then start the PTY
        // with the real cols/rows, avoiding the startup-output vs size-correction race.
        resizeRequestStatsRef.current.fit += 1;
        fitAddon.fit();
        initialTerminalSize = { cols: term.cols, rows: term.rows };
        lastSentTerminalSizeRef.current = initialTerminalSize;
        logger.debug("[Terminal] initial fit before create", {
          cols: initialTerminalSize.cols,
          rows: initialTerminalSize.rows,
          terminalTabId: sessionId,
        });
      } catch (error) {
        logger.warn("[Terminal] initial fit failed:", error);
      }
    }
    if (isVisibleRef.current) {
      requestFocus();
    }

    // Intercept Ctrl/Cmd+C and Ctrl/Cmd+V:
    // - On Win/Linux Ctrl+C defaults to SIGINT for the PTY; with a selection it must copy instead.
    // - Unintercepted Ctrl+V would be typed as a literal `^V`.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      inputFallbackKeydownCandidateRef.current =
        e.metaKey || e.ctrlKey || e.altKey
          ? null
          : createTerminalInputFallbackKeydownCandidate({
              eventTimeStamp: e.timeStamp,
              key: e.key,
              now: performance.now(),
            });
      if (!(e.metaKey || e.ctrlKey)) return true;
      const key = e.key.toLowerCase();
      if (key === "c" && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
          logger.warn("[Terminal] copy via shortcut failed:", err);
        });
        return false;
      }
      if (key === "v") {
        // Returning false from attachCustomKeyEventHandler only stops xterm handling Ctrl+V;
        // it does not cancel the native paste event the browser dispatches afterwards. A manual
        // paste here plus the native paste being written again by xterm's built-in listener
        // would duplicate the shortcut paste. So the default event must be cancelled while
        // keeping the single manual clipboard read/write.
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard
          .readText()
          .then((text) => {
            logger.debug("[Terminal] paste via shortcut", { length: text.length });
            if (text) term.paste(text);
          })
          .catch((err) => logger.warn("[Terminal] paste via shortcut failed:", err));
        return false;
      }
      return true;
    });

    // Track theme switches and retint the terminal live.
    const observer = new MutationObserver(() => {
      term.options.theme = mergeTerminalTheme(terminalProfileThemeRef.current);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const disposables: IDisposable[] = [];
    const { terminalService } = services;
    disposables.push(
      // Plain URLs live outside the React DOM; the xterm link provider computes clickable
      // ranges from the buffer and hands them to the browser pane, keeping platform APIs
      // out of the terminal layer.
      term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const links = getHttpLinksForTerminalBufferLine(
            term.buffer.active,
            bufferLineNumber,
            term.cols,
          )?.map(
            (link): ILink => ({
              ...link,
              activate(event, text) {
                event.preventDefault();
                logger.debug("[Terminal] open plain http link", { url: text });
                openBrowserUrlRef.current(text);
              },
            }),
          );

          callback(links);
        },
      }),
    );

    // Prefer the workspace path as the terminal cwd; the backend falls back to HOME when unset.
    const initialCreateSize = initialTerminalSize ?? { cols: term.cols, rows: term.rows };
    terminalService
      .create({ cols: initialCreateSize.cols, rows: initialCreateSize.rows, cwd })
      .then(({ id, shell, fontFamily, fontSize, theme, fontFamilySource, windowsPty }) => {
        if (disposed) {
          terminalService.dispose({ id });
          return;
        }

        terminalIdRef.current = id;
        // The first fit or ResizeObserver tick may run before the terminal id is ready; park
        // resizes in pendingTerminalSizeRef. A manual flush is required once the id exists, or
        // the dedupe logic skips same-size resizes.
        flushTerminalServiceResize();
        // Windows ConPTY does not pull scrollback into the viewport on grow-resizes like Unix PTYs;
        // without xterm's windowsPty compat, PSReadLine repaints input at stale coordinates over
        // the previous command's output.
        term.options.windowsPty = normalizeWindowsPtyOption(windowsPty);
        term.options.fontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
        const nextFontSize = normalizeTerminalFontSize(fontSize);
        if (nextFontSize) {
          term.options.fontSize = nextFontSize;
        }
        terminalProfileThemeRef.current = theme as ITheme | undefined;
        term.options.theme = mergeTerminalTheme(terminalProfileThemeRef.current);
        const nextShellLabel = formatShellLabel(shell);
        logger.info("[Terminal] shell resolved:", {
          cwd,
          fontFamilySource,
          shell,
          shellLabel: nextShellLabel,
          terminalId: id,
          terminalTabId: sessionId,
        });
        onShellLabelChange(sessionId, nextShellLabel);
        scheduleFitAndResize("init");
        if (isVisibleRef.current) {
          requestFocus();
        }

        disposables.push(
          terminalService.onDynamicData(id)((data) => {
            term.write(normalizePowerShellReadlineRedraw(data, shell));
          }),
        );

        disposables.push(
          terminalService.onDynamicExit(id)((exitCode) => {
            const exitHandler = exitHandlerRef.current;
            logger.info("[Terminal] terminal session exited", {
              autoClose: Boolean(exitHandler),
              exitCode,
              terminalId: id,
              terminalTabId: sessionId,
            });
            if (exitHandler) {
              exitHandler(sessionId, exitCode);
              return;
            }

            // Side-pane terminals are not in the bottom tab registry; without onExit, keep the exited notice.
            term.write(`\r\n${exitedMessageRef.current}\r\n`);
          }),
        );

        disposables.push(
          term.onData((data) => {
            const now = performance.now();
            const inputFallbackKeydownCandidate = inputFallbackKeydownCandidateRef.current;
            const handledData = recordTerminalInputFallbackHandledData({
              candidate: inputFallbackKeydownCandidate,
              data,
              history: recentInputFallbackHandledDataRef.current,
              maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
              now,
            });
            recentInputFallbackHandledDataRef.current = handledData.usedCandidate
              ? handledData.history
              : recordTerminalInputFallbackRecentData({
                  data,
                  history: handledData.history,
                  maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                  now,
                });
            if (handledData.usedCandidate) {
              inputFallbackKeydownCandidateRef.current = null;
            }
            markTerminalInputFallbackHandled(pendingInputFallbacksRef.current, data);
            terminalService.write({ id, data });
          }),
        );

        // On Windows desktop some IMEs leave composed text half-processed in the textarea; keep
        // this fallback. Linux Wayland double-writes alongside xterm's onData path, so the hook
        // stays Windows-only to avoid breaking the normal path.
        const textarea =
          isWindowsDesktop &&
          (term as unknown as { _core: { textarea: HTMLTextAreaElement } })._core?.textarea;
        if (textarea) {
          const handleInput = (e: InputEvent) => {
            // Handle only composed-text insertions.
            if (e.inputType !== "insertText" || !e.data || !e.composed) return;
            const insertedText = e.data;
            const now = performance.now();
            const pendingFallback = createPendingTerminalInputFallback(insertedText);
            pendingInputFallbacksRef.current.push(pendingFallback);
            // Plain spaces reach the PTY via keydown/onData before the browser dispatches composed
            // input; Sogou IME can also fire onData without a stable keydown candidate first.
            // Consume nearby unclaimed onData from the same input so the fallback never double-writes.
            consumeTerminalInputFallbackHandledData({
              history: recentInputFallbackHandledDataRef.current,
              inputEventTimeStamp: e.timeStamp,
              maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
              maxInputDelayMs: TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS,
              now,
              pending: pendingFallback,
            });

            // Delayed check: let xterm's onData claim the pending input first, then decide on the fallback.
            setTimeout(() => {
              pendingInputFallbacksRef.current = pendingInputFallbacksRef.current.filter(
                (item) => item !== pendingFallback,
              );
              if (disposed) {
                return;
              }
              const fallbackAction = resolveTerminalInputFallbackAction({
                pending: pendingFallback,
                textareaValue: textarea.value,
              });
              if (fallbackAction.shouldWrite) {
                // Plain spaces also fire composed input, and onData already wrote the PTY.
                // Trusting textarea.value alone would write the space twice; only fall back
                // once onData is confirmed not to have handled it.
                logger.debug("[Terminal] flush composed input fallback", {
                  length: insertedText.length,
                  terminalId: id,
                  terminalTabId: sessionId,
                });
                terminalService.write({ id, data: insertedText });
              }
              if (fallbackAction.shouldClearTextarea) {
                textarea.value = "";
              }
            }, TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS);
          };

          textarea.addEventListener("input", handleInput, true);
          disposables.push({
            dispose: () => textarea.removeEventListener("input", handleInput, true),
          } as IDisposable);
        }
      })
      .catch((error) => {
        // create() rejections used to escape as Uncaught Promise errors. Log explicitly and
        // surface the message in the terminal pane to pin down shell vs cwd failures.
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[Terminal] failed to create terminal:", error);
        term.write(`\r\n[Terminal failed to start]\r\n${message}\r\n`);
      });

    let resizeRAF = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (!isVisibleRef.current) return;
      if (resizeRAF) cancelAnimationFrame(resizeRAF);
      resizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
    });
    resizeObserver.observe(el);

    return () => {
      disposed = true;
      observer.disconnect();
      resizeObserver.disconnect();
      clearResizeThrottleTimer();
      if (resizeRAF) cancelAnimationFrame(resizeRAF);
      if (resizeRAFRef.current) cancelAnimationFrame(resizeRAFRef.current);
      if (focusRAFRef.current) cancelAnimationFrame(focusRAFRef.current);
      pendingInputFallbacksRef.current = [];
      inputFallbackKeydownCandidateRef.current = null;
      recentInputFallbackHandledDataRef.current = [];
      pendingTerminalSizeRef.current = null;
      lastSentTerminalSizeRef.current = null;
      resizeInFlightRef.current = false;
      for (const d of disposables) d.dispose();
      if (terminalIdRef.current) {
        terminalService.dispose({ id: terminalIdRef.current });
      }
      terminalIdRef.current = undefined;
      fitAddonRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [
    clearResizeThrottleTimer,
    cwd,
    isWindowsDesktop,
    onShellLabelChange,
    requestFocus,
    scheduleFitAndResize,
    flushTerminalServiceResize,
    services,
    sessionId,
    persistentKey,
  ]);

  const handleCopy = () => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
      logger.warn("[Terminal] copy via context menu failed:", err);
    });
  };

  const handlePaste = () => {
    const term = termRef.current;
    if (!term) return;
    navigator.clipboard
      .readText()
      .then((text) => text && term.paste(text))
      .catch((err) => logger.warn("[Terminal] paste via context menu failed:", err));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          className="terminal-xterm-shell h-full min-h-0 w-full overflow-hidden"
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleCopy}>
          <Copy className="mr-2 h-4 w-4" />
          {intl.formatMessage({ id: "terminal.contextMenu.copy" })}
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlePaste}>
          <ClipboardPaste className="mr-2 h-4 w-4" />
          {intl.formatMessage({ id: "terminal.contextMenu.paste" })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
