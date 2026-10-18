/* eslint-disable max-lines -- settings-navigation intent centralizes sessionStorage, event bridging, and parse validation; splitting it would make one-shot intent consumption order harder to reason about. */
import { logger } from "@/logger.js";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "migration"
  | "browser"
  | "modelProvider"
  | "memory"
  | "plugin"
  | "mcp"
  | "skill"
  | "plugins"
  | "usage"
  | "subagents"
  | "commands"
  | "hooks"
  | "workspaceFileSearch"
  | "computerUse"
  | "automations"
  | "shortcuts";

export type SettingsUsageTabTarget = "app" | "codingPlan";
export type SettingsPluginTabTarget = "plugins" | "mcps" | "skills" | "commands";
export type SettingsPluginNavigationOrigin = "plugin-store";

const SETTINGS_SECTION_INTENT_KEY = "zcode-settings-section-intent",
  SETTINGS_USAGE_TAB_INTENT_KEY = "zcode-settings-usage-tab-intent",
  SETTINGS_PLUGIN_TAB_INTENT_KEY = "zcode-settings-plugin-tab-intent",
  SETTINGS_PLUGIN_ORIGIN_INTENT_KEY = "zcode-settings-plugin-origin-intent",
  SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY = "zcode-settings-plugin-scope-key-intent";
const SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY = "zcode-settings-model-provider-id-intent";
const SETTINGS_SECTION_INTENT_EVENT = "zcode:settings-section-intent",
  SETTINGS_LAST_SECTION_STORAGE_KEY = "zcode-settings-last-section";
const HIDDEN_SETTINGS_SECTIONS = new Set<SettingsSectionId>([
  // Product semantics: automations live in the workspace main view, not as a settings section.
  // Note: hooks is already a real settings section, so it is not listed here.
  "automations",
  // Legacy plugin market moved out of Settings; the id remains only for migrating old preferences and callers.
  "plugins",
  // Workspace search (.zcodeignore) entry hidden for now: the rules file still applies and stays
  // hand-editable; editor code is kept, remove it from here to re-enable.
  "workspaceFileSearch",
]);

export interface SettingsSectionIntentEventDetail {
  section: SettingsSectionId;
  pluginTab?: SettingsPluginTabTarget;
  pluginOrigin?: SettingsPluginNavigationOrigin;
  pluginScopeKey?: string;
  usageTab?: SettingsUsageTabTarget;
  modelProviderId?: string;
}

export interface SettingsModelProviderTarget {
  providerId: string;
}

function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (
    value === "general" ||
    value === "appearance" ||
    value === "migration" ||
    value === "browser" ||
    value === "modelProvider" ||
    value === "memory" ||
    value === "plugin" ||
    value === "mcp" ||
    value === "skill" ||
    value === "plugins" ||
    value === "usage" ||
    value === "subagents" ||
    value === "commands" ||
    value === "hooks" ||
    value === "workspaceFileSearch" ||
    value === "computerUse" ||
    value === "automations" ||
    value === "shortcuts"
  );
}

export function isSettingsSectionEnabled(section: SettingsSectionId): boolean {
  return !HIDDEN_SETTINGS_SECTIONS.has(section);
}

export function resolveSettingsSection(
  section: SettingsSectionId,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (section === "plugins") return "plugin";
  return isSettingsSectionEnabled(section) ? section : fallbackSection;
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch (error) {
    // Some WebView / mobile-remote containers may disable localStorage.
    // Last-section memory is a UI preference only; fall back to the default section, never block opening Settings.
    logger.warn("[settingsNavigation] localStorage unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function readLastSettingsSectionPreference(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const storage = getLocalStorage();
  if (!storage) {
    return fallbackSection;
  }

  try {
    const raw = storage.getItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    // Legacy section id merged into plugin; migrate the persisted value instead of propagating old routing semantics.
    if (raw === "plugins") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "plugin");
      setPendingPluginTab("plugins");
      return "plugin";
    }
    if (raw === "skills") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "skill");
      return "skill";
    }
    // Legacy "code preview" merged into "appearance"; keep the last-visited-section migration semantics.
    if (raw === "codePreview") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "appearance");
      return "appearance";
    }
    if (raw && isSettingsSectionId(raw)) {
      return resolveSettingsSection(raw, fallbackSection);
    }
    if (raw !== null) {
      storage.removeItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    }
  } catch (error) {
    logger.warn("[settingsNavigation] Failed to read last settings section", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return fallbackSection;
}

export function writeLastSettingsSectionPreference(section: SettingsSectionId): void {
  const resolvedSection = resolveSettingsSection(section);
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, resolvedSection);
  } catch (error) {
    logger.warn("[settingsNavigation] Failed to persist last settings section", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function consumeInitialSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const lastSection = readLastSettingsSectionPreference(fallbackSection);
  // consumePendingSettingsSection's fallback used to be hardcoded to modelProvider, so opening
  // Settings with no explicit intent always landed on "Model Providers". Read the last section
  // first, then let one-shot intents (quick pick / manage models) override it, keeping direct-entry semantics.
  return resolveSettingsSection(consumePendingSettingsSection(lastSection), lastSection);
}

export function setPendingSettingsSection(section: SettingsSectionId): void {
  setPendingSettingsSectionIntent(section);
}

export function setPendingSettingsUsageIntent(): void {
  // The usage entry only opens the Usage section; never override the specific stats tab the user wants.
  setPendingSettingsSectionIntent("usage");
}

export function setPendingSettingsUsageCodingPlanIntent(): void {
  // The remaining-quota entry must land on Coding Plan usage stats, while the
  // avatar-menu entry only opens Usage to preserve the user's last stats tab.
  setPendingSettingsSectionIntent("usage", { usageTab: "codingPlan" });
}

export function setPendingSettingsPluginIntent(
  tab: SettingsPluginTabTarget,
  options: {
    origin?: SettingsPluginNavigationOrigin;
    scopeKey?: string;
  } = {},
): void {
  const section =
    tab === "mcps"
      ? "mcp"
      : tab === "skills"
        ? "skill"
        : tab === "commands"
          ? "commands"
          : "plugin";
  setPendingSettingsSectionIntent(section, {
    pluginTab: tab === "plugins" ? tab : undefined,
    pluginOrigin: options.origin,
    pluginScopeKey: options.scopeKey,
  });
}

export function setPendingSettingsSectionIntent(
  section: SettingsSectionId,
  options: {
    pluginTab?: SettingsPluginTabTarget;
    pluginOrigin?: SettingsPluginNavigationOrigin;
    pluginScopeKey?: string;
    modelProviderId?: string;
    usageTab?: SettingsUsageTabTarget;
  } = {},
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(SETTINGS_SECTION_INTENT_KEY, section);
    if (options.pluginTab) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_TAB_INTENT_KEY, options.pluginTab);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    }
    if (options.pluginOrigin) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY, options.pluginOrigin);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    }
    const normalizedPluginScopeKey = options.pluginScopeKey?.trim();
    if (normalizedPluginScopeKey) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY, normalizedPluginScopeKey);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
    }
    if (options.usageTab) {
      window.sessionStorage.setItem(SETTINGS_USAGE_TAB_INTENT_KEY, options.usageTab);
    }
    if (options.modelProviderId) {
      window.sessionStorage.setItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY, options.modelProviderId);
    } else {
      window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    }
  } catch {
    // Ignore browser storage errors; not fatal to the main flow.
  }

  // An already-mounted SettingsPage does not remount, so a bare sessionStorage write has no subscriber.
  // Re-dispatch the custom event in this window so the open SettingsPage jumps to the quick-pick section immediately.
  window.dispatchEvent(
    new CustomEvent<SettingsSectionIntentEventDetail>(SETTINGS_SECTION_INTENT_EVENT, {
      detail: {
        section,
        pluginTab: options.pluginTab,
        pluginOrigin: options.pluginOrigin,
        pluginScopeKey: options.pluginScopeKey?.trim() || undefined,
        usageTab: options.usageTab,
        modelProviderId: options.modelProviderId,
      },
    }),
  );
}

function clearPendingSettingsSectionIntent(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
  } catch {
    // Ignore browser storage errors; not fatal to the main flow.
  }
}

export function consumePendingSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (typeof window === "undefined") {
    return fallbackSection;
  }

  try {
    const raw = window.sessionStorage.getItem(SETTINGS_SECTION_INTENT_KEY);
    if (raw !== null) {
      window.sessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
    }

    if (raw === "skills") {
      // Legacy Skills used a plural id; migrate to the standalone skill section.
      return "skill";
    }
    if (raw && isSettingsSectionId(raw)) {
      return resolveSettingsSection(raw, fallbackSection);
    }
  } catch {
    // Ignore browser storage errors; not fatal to the main flow.
  }

  return fallbackSection;
}

function setPendingPluginTab(tab: SettingsPluginTabTarget): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SETTINGS_PLUGIN_TAB_INTENT_KEY, tab);
  } catch {
    // Ignore browser storage errors; do not block opening Settings.
  }
}

export function consumePendingSettingsPluginTab(): SettingsPluginTabTarget | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    return raw === "plugins" || raw === "mcps" || raw === "skills" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function consumePendingSettingsPluginOrigin(): SettingsPluginNavigationOrigin | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    return raw === "plugin-store" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function consumePendingSettingsPluginScopeKey(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
    return raw?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function clearPendingSettingsPluginScopeKey(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
  } catch {
    // Ignore browser storage errors; not fatal to the main flow.
  }
}

export function clearPendingSettingsPluginOrigin(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
  } catch {
    // Ignore browser storage errors; do not block opening Settings.
  }
}

export function consumePendingSettingsUsageTab(): SettingsUsageTabTarget | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const raw = window.sessionStorage.getItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    if (raw !== null) {
      window.sessionStorage.removeItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    }
    return raw === "app" || raw === "codingPlan" ? raw : undefined;
  } catch {
    // Ignore browser storage errors; not fatal to the main flow.
    return undefined;
  }
}

export function consumePendingSettingsModelProviderTarget():
  | SettingsModelProviderTarget
  | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const providerId = window.sessionStorage.getItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    if (!providerId?.trim()) {
      return undefined;
    }
    return {
      providerId: providerId.trim(),
    };
  } catch {
    // Ignore browser storage errors; not fatal to the main flow.
    return undefined;
  }
}

export function shouldFallbackSettingsUsageTabToApp({
  activeTab,
  checkingCodingPlanTab,
  loadingModelProviders,
  showCodingPlanTab,
}: {
  activeTab: SettingsUsageTabTarget;
  checkingCodingPlanTab: boolean;
  loadingModelProviders: boolean;
  showCodingPlanTab: boolean;
}): boolean {
  // A Coding Plan intent can land before provider/entitlement data finishes loading.
  // Fall back to App Usage only once loading is done and no valid plan exists, so the first
  // frame cannot flip the tab back right after the "more" click.
  return (
    activeTab === "codingPlan" &&
    !showCodingPlanTab &&
    !loadingModelProviders &&
    !checkingCodingPlanTab
  );
}

export function addPendingSettingsSectionListener(
  listener: (section: SettingsSectionId, detail?: SettingsSectionIntentEventDetail) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleIntent = (event: Event) => {
    const detail = (event as CustomEvent<SettingsSectionIntentEventDetail>).detail;
    if (detail?.section && isSettingsSectionId(detail.section)) {
      // With Settings already open, the event itself carries this navigation intent.
      // Clear sessionStorage now so that after the user switches sections and leaves, a stale
      // pending intent cannot override the last-visited section on the next mount.
      clearPendingSettingsSectionIntent();
      listener(detail.section, detail);
    }
  };

  window.addEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  return () => {
    window.removeEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  };
}
