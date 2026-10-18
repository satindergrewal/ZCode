/**
 * Zustand store - global state management.
 *
 * State that must sync across windows is broadcast via BroadcastService.
 * The broadcast channel prefix "state:" marks state-sync messages.
 */
import { create } from "zustand";
import type { IBroadcastService, BroadcastMessage } from "@zcode/services";
import type { OAuthProviderId, UserInfo } from "@zcode/shared";
import type { CodingPlanResetType } from "@zcode/shared";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type {
  CodingPlanQuotaResetUiEntries,
  CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";
import {
  applyCodingPlanQuotaResetAutoPlayedBroadcast,
  createCodingPlanQuotaResetStoreActions,
  parseCodingPlanQuotaResetAutoPlayedBroadcastMessage,
  type CodingPlanQuotaResetAutomaticObservations,
  type CodingPlanQuotaResetAutoPlayReservation,
  type CodingPlanQuotaResetAutoPlayReservationAttempt,
  type CodingPlanQuotaResetAutoPlayedSlot,
} from "@/store/codingPlanQuotaResetState.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";
import {
  applyUiFontSizePx,
  loadUiFontSizePx,
  normalizeUiFontSizePx,
  UI_FONT_SIZE_STORAGE_KEY,
} from "@/lib/uiFontSize.js";
import {
  isTaskNotificationEnabled,
  isTaskNotificationSoundPreferenceEnabled,
  persistTaskNotificationEnabled,
  persistTaskNotificationSoundEnabled,
} from "@/lib/taskNotificationPreferences.js";
import type { Theme } from "../useTheme.js";
import { applyTheme, normalizeThemePreference, resolveTheme } from "../useTheme.js";

import {
  INTERFACE_MODE_STORAGE_KEY,
  normalizeInterfaceMode,
  type InterfaceMode,
} from "@/lib/interfaceMode.js";
import { logger } from "@/logger.js";

export type LoginEntryPurpose = "app-login";

// v4 refactor: types and defaults moved down into @/lib/codePreviewSettings.ts
// so pure display components do not depend on the store; this re-export keeps the legacy import path working.
export type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
export { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";

export type LoginEntryAttemptStatus =
  | "requested"
  | "waiting"
  | "succeeded"
  | "cancelled"
  | "failed";

export interface LoginEntryAttempt {
  id: number;
  providerId?: OAuthProviderId;
  purpose?: LoginEntryPurpose;
  status: LoginEntryAttemptStatus;
}

const CODE_PREVIEW_SETTINGS_KEY = "zcode-code-preview-settings";
const PERFORMANCE_MODE_STORAGE_KEY = "zcode-performance-mode";

function loadCodePreviewSettings(): CodePreviewSettings {
  try {
    const raw = readSafeLocalStorage(CODE_PREVIEW_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_CODE_PREVIEW_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<CodePreviewSettings>;
    return {
      ...DEFAULT_CODE_PREVIEW_SETTINGS,
      ...parsed,
      fontSizePx:
        typeof parsed.fontSizePx === "number"
          ? Math.min(20, Math.max(12, Math.round(parsed.fontSizePx)))
          : DEFAULT_CODE_PREVIEW_SETTINGS.fontSizePx,
    };
  } catch {
    return DEFAULT_CODE_PREVIEW_SETTINGS;
  }
}

function loadPerformanceMode(): boolean {
  return readSafeLocalStorage(PERFORMANCE_MODE_STORAGE_KEY) === "true";
}

// ============================================================================
// State shape
// ============================================================================

export interface ZCodeState {
  /** Display-detail preference; does not change agent permissions or execution. */
  interfaceMode: InterfaceMode;
  setInterfaceMode: (mode: InterfaceMode) => void;

  /** Current theme */
  theme: Theme;
  setTheme: (theme: Theme) => void;

  /** Current language */
  locale: string;
  setLocale: (locale: string) => void;

  /** Code preview settings */
  codePreviewSettings: CodePreviewSettings;
  setCodePreviewSettings: (patch: Partial<CodePreviewSettings>) => void;

  /** UI root rem font size (px) */
  uiFontSizePx: number;
  setUiFontSizePx: (fontSizePx: number) => void;

  /** Whether performance mode is on */
  performanceMode: boolean;
  setPerformanceMode: (enabled: boolean) => void;

  /** Whether task notifications are on (desktop notifications; sound has its own sub-switch) */
  notificationEnabled: boolean;
  setNotificationEnabled: (enabled: boolean) => void;

  /** Whether the task-notification sound is on (bound to the master task-notification switch) */
  notificationSoundEnabled: boolean;
  setNotificationSoundEnabled: (enabled: boolean) => void;

  /** Current user info */
  user: UserInfo | null;
  /** Incremented when the user goes from signed-out to signed-in; connecting extra providers does not count as a new sign-in. */
  authSessionSeq: number;
  setUser: (user: UserInfo | null) => void;

  /** Whether startup is still restoring the OAuth session */
  isRestoringOAuthSession: boolean;
  setIsRestoringOAuthSession: (restoring: boolean) => void;

  /** OAuth callback error (written by Root, read by the unified login entry) */
  oauthError: string | null;
  setOAuthError: (error: string | null) => void;
  oauthPollingActive: boolean;
  setOAuthPollingActive: (active: boolean) => void;
  oauthSuccessSeq: number;
  lastOAuthSuccessProvider: OAuthProviderId | null;
  markOAuthSuccess: (provider?: OAuthProviderId) => void;
  apiKeyLoginSuccessSeq: number;
  lastApiKeyLoginModel: string | null;
  markApiKeyLoginSuccess: (preferredModel?: string | null) => void;
  /** Request to open the unified login entry, optionally carrying providers to auto sign-in/connect. */
  loginEntryRequest: {
    id: number;
    providerId?: OAuthProviderId;
    purpose?: LoginEntryPurpose;
  } | null;
  /** Current unified-login attempt; later actions such as purchase resume only their own OAuth via the id. */
  loginEntryAttempt: LoginEntryAttempt | null;
  requestLoginEntry: (providerId?: OAuthProviderId, purpose?: LoginEntryPurpose) => number;
  clearLoginEntryRequest: (requestId?: number) => void;
  markLoginEntryAttemptStatus: (
    requestId: number,
    status: Exclude<LoginEntryAttemptStatus, "requested">,
  ) => void;

  /** Coding Plan quota-reset UI state; entry/observation records stay within this window, never persisted. */
  codingPlanQuotaResetUiBySource: Record<string, CodingPlanQuotaResetUiEntries>;
  /** Auth session under which the auto/ops completion was first observed; separates later same-session mounts from re-login. */
  codingPlanQuotaResetAutomaticObservationsBySource: Record<
    string,
    CodingPlanQuotaResetAutomaticObservations
  >;
  /** played used_at records behind the once-per-window auto-complete toast; in-memory, mergeable via broadcast. */
  codingPlanQuotaResetAutoPlayedBySource: Record<string, CodingPlanQuotaResetAutoPlayedSlot>;
  /** State after the server status write or a manual-use reconciliation; entry=null clears that kind. */
  setCodingPlanQuotaResetUiEntry: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    entry: CodingPlanQuotaResetUiEntry | null,
    authSessionSeq: number,
  ) => void;
  /** The composer requests a transient reservation before display; played is not written at this stage. */
  reserveCodingPlanQuotaResetAutoPlay: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    completedAt: number,
  ) => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  /** Commit reservation, played and the broadcast while the component is still valid and about to show. */
  commitCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => boolean;
  /** Release an uncommitted reservation when the component goes away. */
  releaseCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;

  /** Manually request opening the onboarding dialog */
  newUserOnboardingOpen: boolean;
  setNewUserOnboardingOpen: (open: boolean) => void;
  onboardingDialogRequested: boolean | "migration";
  requestOnboardingDialog: (entry?: "migration") => void;
  clearOnboardingDialogRequest: () => void;
}

// ============================================================================
// Broadcast fields - only changes to these fields are sent to other windows
// ============================================================================

const BROADCAST_FIELDS = new Set(["theme", "locale", "uiFontSizePx", "interfaceMode"]);

type BroadcastField = "theme" | "locale" | "uiFontSizePx" | "interfaceMode";

/** Broadcast channel name prefix */
const STATE_CHANNEL_PREFIX = "state:";

// ============================================================================
// Store factory
// ============================================================================

/**
 * Creates the Zustand store, wired to the broadcast service for cross-window state sync.
 *
 * @param broadcastService - broadcast service. Desktop uses RPC; web may pass a no-op implementation
 */
export function createZCodeStore(
  broadcastService: IBroadcastService,
  options: {
    initialIsRestoringOAuthSession?: boolean;
  } = {},
) {
  /** Flag: a broadcast update is being applied, so it is not rebroadcast (loop guard) */
  let applyingBroadcast = false;
  let loginEntryRequestSeq = 0;
  let cleanupSystemThemeListener: (() => void) | null = null;
  let syncSystemThemeListener = (_theme: Theme) => {};

  const useStore = create<ZCodeState>()((set, get) => ({
    interfaceMode: normalizeInterfaceMode(readSafeLocalStorage(INTERFACE_MODE_STORAGE_KEY)),
    setInterfaceMode: (mode) => {
      const interfaceMode = normalizeInterfaceMode(mode);
      if (get().interfaceMode !== interfaceMode) {
        logger.debug("[InterfaceMode] Switching interface mode", {
          interfaceMode,
          source: applyingBroadcast ? "broadcast" : "local",
        });
      }
      writeSafeLocalStorage(INTERFACE_MODE_STORAGE_KEY, interfaceMode);
      set({ interfaceMode });
    },
    // The default theme converges on Zai dark so the first launch matches the other theme entries.
    // A choice already saved in localStorage still wins; existing preferences are not overwritten.
    theme: normalizeThemePreference((readSafeLocalStorage("zcode-theme") as Theme) || "zai-dark"),
    setTheme: (theme: Theme) => {
      const normalizedTheme = normalizeThemePreference(theme);
      writeSafeLocalStorage("zcode-theme", normalizedTheme);
      syncSystemThemeListener(normalizedTheme);
      applyTheme(normalizedTheme);

      set({ theme: normalizedTheme });
    },

    locale: readSafeLocalStorage("zcode-locale") || "zh-CN",
    setLocale: (locale: string) => {
      writeSafeLocalStorage("zcode-locale", locale);
      set({ locale });
    },

    codePreviewSettings: loadCodePreviewSettings(),
    setCodePreviewSettings: (patch: Partial<CodePreviewSettings>) =>
      set((state) => {
        const next = {
          ...state.codePreviewSettings,
          ...patch,
          fontSizePx:
            typeof patch.fontSizePx === "number"
              ? Math.min(20, Math.max(12, Math.round(patch.fontSizePx)))
              : state.codePreviewSettings.fontSizePx,
        };
        writeSafeLocalStorage(CODE_PREVIEW_SETTINGS_KEY, JSON.stringify(next));
        return { codePreviewSettings: next };
      }),

    uiFontSizePx: loadUiFontSizePx(),
    setUiFontSizePx: (fontSizePx: number) => {
      const normalizedFontSizePx = normalizeUiFontSizePx(fontSizePx);
      writeSafeLocalStorage(UI_FONT_SIZE_STORAGE_KEY, String(normalizedFontSizePx));
      applyUiFontSizePx(normalizedFontSizePx);
      set({ uiFontSizePx: normalizedFontSizePx });
    },

    performanceMode: loadPerformanceMode(),
    setPerformanceMode: (enabled: boolean) => {
      writeSafeLocalStorage(PERFORMANCE_MODE_STORAGE_KEY, enabled ? "true" : "false");
      set({ performanceMode: enabled });
    },

    notificationEnabled: isTaskNotificationEnabled(),
    setNotificationEnabled: (enabled: boolean) => {
      persistTaskNotificationEnabled(enabled);
      set({ notificationEnabled: enabled });
    },

    notificationSoundEnabled: isTaskNotificationSoundPreferenceEnabled(),
    setNotificationSoundEnabled: (enabled: boolean) => {
      persistTaskNotificationSoundEnabled(enabled);
      set({ notificationSoundEnabled: enabled });
    },

    user: null,
    authSessionSeq: 0,
    setUser: (user: UserInfo | null) =>
      set((state) => ({
        user,
        authSessionSeq:
          state.user === null && user !== null ? state.authSessionSeq + 1 : state.authSessionSeq,
      })),

    isRestoringOAuthSession: options.initialIsRestoringOAuthSession ?? false,
    setIsRestoringOAuthSession: (restoring: boolean) => set({ isRestoringOAuthSession: restoring }),

    oauthError: null,
    setOAuthError: (error: string | null) => set({ oauthError: error }),
    oauthPollingActive: false,
    setOAuthPollingActive: (active: boolean) => set({ oauthPollingActive: active }),
    oauthSuccessSeq: 0,
    lastOAuthSuccessProvider: null,
    markOAuthSuccess: (provider?: OAuthProviderId) =>
      set((state) => ({
        oauthSuccessSeq: state.oauthSuccessSeq + 1,
        lastOAuthSuccessProvider: provider ?? state.lastOAuthSuccessProvider,
      })),
    apiKeyLoginSuccessSeq: 0,
    lastApiKeyLoginModel: null,
    markApiKeyLoginSuccess: (preferredModel?: string | null) =>
      set((state) => ({
        apiKeyLoginSuccessSeq: state.apiKeyLoginSuccessSeq + 1,
        lastApiKeyLoginModel: preferredModel?.trim() || null,
      })),
    loginEntryRequest: null,
    loginEntryAttempt: null,
    requestLoginEntry: (providerId?: OAuthProviderId, purpose?: LoginEntryPurpose) => {
      const id = ++loginEntryRequestSeq;
      const attempt: LoginEntryAttempt = {
        id,
        providerId,
        purpose,
        status: "requested",
      };
      set({
        loginEntryRequest: {
          id,
          providerId,
          purpose,
        },
        loginEntryAttempt: attempt,
      });
      return id;
    },
    clearLoginEntryRequest: (requestId?: number) =>
      set((state) => {
        if (requestId !== undefined && state.loginEntryRequest?.id !== requestId) {
          return {};
        }
        return { loginEntryRequest: null };
      }),
    markLoginEntryAttemptStatus: (requestId, status) =>
      set((state) => {
        if (state.loginEntryAttempt?.id !== requestId) {
          return {};
        }
        return {
          loginEntryAttempt: {
            ...state.loginEntryAttempt,
            status,
          },
        };
      }),

    codingPlanQuotaResetUiBySource: {},
    codingPlanQuotaResetAutomaticObservationsBySource: {},
    codingPlanQuotaResetAutoPlayedBySource: {},
    ...createCodingPlanQuotaResetStoreActions({
      broadcastService,
      readState: get,
      writeState: (updater) => set((state) => updater(state)),
    }),

    newUserOnboardingOpen: false,
    setNewUserOnboardingOpen: (open) => set({ newUserOnboardingOpen: open }),
    onboardingDialogRequested: false,
    requestOnboardingDialog: (entry) => set({ onboardingDialogRequested: entry ?? true }),
    clearOnboardingDialogRequest: () => set({ onboardingDialogRequested: false }),
  }));

  syncSystemThemeListener = (theme: Theme) => {
    cleanupSystemThemeListener?.();
    cleanupSystemThemeListener = null;

    if (theme !== "system" || typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      if (useStore.getState().theme !== "system") {
        return;
      }

      // system mode must keep subscribing to light/dark changes, not apply once at switch time,
      // or the DOM dark class stops following later OS theme changes, looking like broken auto mode.
      applyTheme("system");
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleSystemThemeChange);
      cleanupSystemThemeListener = () => {
        mediaQuery.removeEventListener("change", handleSystemThemeChange);
      };
      return;
    }

    // Some Electron/Chromium combos still support only the legacy MediaQueryList listener API.
    // With addEventListener alone, system mode gets no notification on OS theme changes.
    mediaQuery.addListener(handleSystemThemeChange);
    cleanupSystemThemeListener = () => {
      mediaQuery.removeListener(handleSystemThemeChange);
    };
  };

  // Zustand v5 setState uses different overloads for replace=true/false;
  // wrapping it and passing replace through used to land on incompatible signature branches under strict types.
  // Subscribe-then-broadcast instead, comparing only the fields that truly need cross-window sync; simpler and overload-safe.
  useStore.subscribe((state, prevState) => {
    if (applyingBroadcast) {
      return;
    }

    for (const field of BROADCAST_FIELDS as Set<BroadcastField>) {
      if (state[field] === prevState[field]) {
        continue;
      }

      broadcastService.send({
        channel: `${STATE_CHANNEL_PREFIX}${field}`,
        payload: state[field],
      });
    }
  });

  // Listen for broadcasts from other windows
  broadcastService.onMessage((msg: BroadcastMessage) => {
    // Auto-complete is once-per-window: once another window broadcasts a played used_at, this window
    // merges the played record and dismisses its playing toast of the same used_at; local echoes were ignored at parse time.
    const autoPlayed = parseCodingPlanQuotaResetAutoPlayedBroadcastMessage(msg);
    if (autoPlayed) {
      useStore.setState((state) => applyCodingPlanQuotaResetAutoPlayedBroadcast(state, autoPlayed));
      return;
    }

    if (!msg.channel.startsWith(STATE_CHANNEL_PREFIX)) return;

    const field = msg.channel.slice(STATE_CHANNEL_PREFIX.length) as BroadcastField;
    if (!BROADCAST_FIELDS.has(field)) return;

    applyingBroadcast = true;
    try {
      // Call the matching setter so its side effects (localStorage, DOM) run too
      const state = useStore.getState();
      if (field === "theme" && typeof msg.payload === "string") {
        state.setTheme(msg.payload as Theme);
      } else if (field === "locale" && typeof msg.payload === "string") {
        state.setLocale(msg.payload);
      } else if (
        field === "interfaceMode" &&
        (msg.payload === "office" || msg.payload === "coding")
      ) {
        state.setInterfaceMode(normalizeInterfaceMode(msg.payload));
      } else if (field === "uiFontSizePx" && typeof msg.payload === "number") {
        state.setUiFontSizePx(msg.payload);
      }
    } finally {
      applyingBroadcast = false;
    }
  });

  syncSystemThemeListener(useStore.getState().theme);
  applyTheme(useStore.getState().theme);
  applyUiFontSizePx(useStore.getState().uiFontSizePx);
  document.documentElement.classList.toggle(
    "dark",
    resolveTheme(useStore.getState().theme) === "dark",
  );

  return useStore;
}

export type ZCodeStore = ReturnType<typeof createZCodeStore>;
