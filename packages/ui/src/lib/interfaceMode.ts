export type InterfaceMode = "office" | "coding";

export const INTERFACE_MODE_STORAGE_KEY = "zcode-interface-mode";

export function normalizeInterfaceMode(value: unknown): InterfaceMode {
  // localStorage (zcode-interface-mode) may still hold pre-rename values "general"/"concise";
  // they must map to the new office name or upgrading users would be normalized to coding,
  // silently losing their choice.
  return value === "office" || value === "general" || value === "concise" ? "office" : "coding";
}
