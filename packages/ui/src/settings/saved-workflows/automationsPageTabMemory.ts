// Remembers the automation page's top-level tab in sessionStorage,
// after settingsNavigation.ts's last-section precedent: returning from detail/conversation stays on Workflows.
// Since the hub went cross-project the page no longer keys on the active project: one app-level key, no per-workspace buckets;
// not in Zustand, not broadcast across windows.
import type { AutomationsPageTab } from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";

const STORAGE_KEY = "zcode-automations-page-tab";

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readAutomationsPageTab(): AutomationsPageTab {
  try {
    const value = storage()?.getItem(STORAGE_KEY);
    return value === "workflow" ? "workflow" : "automation";
  } catch {
    return "automation";
  }
}

export function writeAutomationsPageTab(tab: AutomationsPageTab): void {
  try {
    storage()?.setItem(STORAGE_KEY, tab);
  } catch {
    // Without sessionStorage (private mode/quota) skip remembering; next open lands on the default tab.
  }
}
