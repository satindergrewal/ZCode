// The standalone CLI's dynamic-workflow mode (docs/dynamic-workflow/launch.md, "The standalone CLI: `--workflow-mode`").
// TUI and headless have no Host-pushed rollout mode; the process argument decides. Defaults to disabled: workflows need explicit opt-in in the standalone CLI.
// The mode is folded into core's two explicit fields only here; bootstrap/core inherit the same consequences as the protocol server side.
import {
  DYNAMIC_WORKFLOW_MODES,
  normalizeDynamicWorkflowMode,
  type DynamicWorkflowMode,
} from "@zcode/shared";

export const DEFAULT_CLI_WORKFLOW_MODE: DynamicWorkflowMode = "disabled";

export const WORKFLOW_MODE_SCOPE_ERROR =
  "--workflow-mode can only be used with --prompt, --target, or tui.";

export const WORKFLOW_DISABLED_NOTICE =
  "Dynamic workflows are disabled in this session. Restart with --workflow-mode onDemand or --workflow-mode alwaysOn to use them.";

export type CliWorkflowRuntimeConfig = {
  dynamicWorkflowEnabled: boolean;
  dynamicWorkflowToolsOnDemand: boolean;
};

/** Invalid values throw and are formatted by the entry layer; defaults are not filled here so the entry layer can distinguish "unset" for scoping. */
export function normalizeWorkflowModeOption(
  value: string | undefined,
): DynamicWorkflowMode | undefined {
  if (value === undefined) return undefined;
  const mode = normalizeDynamicWorkflowMode(value);
  if (mode !== undefined) return mode;
  throw new Error(
    `Unsupported --workflow-mode value: ${value}. Supported modes: ${DYNAMIC_WORKFLOW_MODES.join(", ")}.`,
  );
}

/**
 * Both fields are written explicitly: core treats absence as enabled (subagents and in-process embedders rely on that polarity),
 * and a blank standalone CLI would bypass the disabled default.
 */
export function resolveWorkflowModeRuntimeConfig(
  mode: DynamicWorkflowMode,
): CliWorkflowRuntimeConfig {
  return {
    dynamicWorkflowEnabled: mode !== "disabled",
    dynamicWorkflowToolsOnDemand: mode === "onDemand",
  };
}

export function isWorkflowModeEnabled(mode: DynamicWorkflowMode | undefined): boolean {
  // Absent = the caller never opted into modes (unit tests, embedders); no gate on the command surface. The CLI entry always passes the parsed value.
  return mode !== "disabled";
}
