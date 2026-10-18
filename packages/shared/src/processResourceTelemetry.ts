/**
 * The shared contract of whole-process CPU/memory telemetry.
 *
 * Only what main and unit tests must share: the role enum, three event names,
 * per-event property key allowlists, counts, and privacy rules. Sampling/aggregation live in desktop main.
 */

/** The first batch's 10 process roles. */
export const PROCESS_RESOURCE_ROLES = [
  "main",
  "renderer_main",
  "renderer_guest",
  "gpu",
  "chromium_other",
  "host",
  "scheduler",
  "cli_chat",
  "cli_aux",
  "mcp",
] as const;

export type ProcessResourceRole = (typeof PROCESS_RESOURCE_ROLES)[number];

/**
 * zcode-cli's self-sample period--the beat contract between CLI and app:
 * CLI-side a timer period; main-side both the sample window and the expiry basis (2 periods).
 * One source only, or a CLI beat change silently shifts main's sample_count.
 */
export const ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS = 60_000;

/**
 * zcode-cli's process lanes.
 *
 * lane is not a CLI protocol field--a CLI process cannot know its manager; the app services side
 * tags samples by manager (chat = the workspace-level agent; the other two are control-plane lanes).
 */
export const PROCESS_RESOURCE_CLI_LANES = ["chat", "plugin", "mcp-status"] as const;

export type ProcessResourceCliLane = (typeof PROCESS_RESOURCE_CLI_LANES)[number];

/**
 * lane -> role: chat maps to cli_chat (one process per workspace); the other two merge into cli_aux.
 *
 * Default (no lane) maps to cli_chat: the only source is a version-lagged server not yet tagging, and the
 * long-lived resource consumer on remote workspaces is the chat lane; closer to truth than dropping the sample.
 */
export function resolveCliProcessResourceRole(
  lane: ProcessResourceCliLane | undefined,
): Extract<ProcessResourceRole, "cli_chat" | "cli_aux"> {
  return lane === undefined || lane === "chat" ? "cli_chat" : "cli_aux";
}

/** Where the process actually runs; remote CLI/MCP samples carry remote. */
export type ProcessResourceRuntimeSurface = "local" | "remote";

export const PROCESS_RESOURCE_EVENT_NAMES = {
  processWindow: "perf_process_window",
  systemWindow: "perf_system_window",
  toolExecResource: "perf_tool_exec_resource",
} as const;

export type ProcessResourceEventName =
  (typeof PROCESS_RESOURCE_EVENT_NAMES)[keyof typeof PROCESS_RESOURCE_EVENT_NAMES];

/** ARMS cap on properties per custom event (global + event properties combined). */
export const ARMS_CUSTOM_EVENT_PROPERTY_LIMIT = 20;

/** Global properties shared by all resource events. */
const PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS = [
  "platform",
  "app_version",
  "arms_env",
  "device_mid",
] as const;

/**
 * Every possible perf_process_window property (21).
 * 20 max per event: node roles and renderer_main 20 (both heap fields, no mcp_id),
 * mcp 19 (mcp_id, no heap), gpu / renderer_guest / chromium_other 18.
 */
export const PERF_PROCESS_WINDOW_PROPERTY_KEYS = [
  ...PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS,
  "process_role",
  "runtime_surface",
  "arch",
  "logical_cpu_count",
  "total_memory_gb",
  "mcp_id",
  "background_ratio",
  "uptime_minutes",
  "cpu_percent_p95",
  "cpu_percent_peak",
  "rss_kb_total_mean",
  "rss_kb_total_peak",
  "rss_kb_max_process_peak",
  "heap_used_kb_mean",
  "heap_used_kb_peak",
  "process_count_peak",
  "sample_count",
] as const;

/** Every perf_system_window property (17). */
export const PERF_SYSTEM_WINDOW_PROPERTY_KEYS = [
  ...PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS,
  "arch",
  "logical_cpu_count",
  "total_memory_gb",
  "background_ratio",
  "app_uptime_minutes",
  "system_cpu_percent_p95",
  "system_free_memory_kb_min",
  "app_cpu_percent_p95",
  "app_rss_kb_total_mean",
  "app_rss_kb_total_peak",
  "process_count_total_peak",
  "sample_count",
  "telemetry_self_ms",
] as const;

/** Every perf_tool_exec_resource property (12; 10 on Windows without the tree_* pair). */
export const PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS = [
  ...PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS,
  "runtime_surface",
  "tool_name",
  "exit_kind",
  "tree_rss_kb_peak",
  "tree_cpu_time_ms",
  "sample_count",
  "cli_rss_kb",
  "system_free_memory_kb",
] as const;

const PROPERTY_KEY_WHITELIST: Record<ProcessResourceEventName, readonly string[]> = {
  [PROCESS_RESOURCE_EVENT_NAMES.processWindow]: PERF_PROCESS_WINDOW_PROPERTY_KEYS,
  [PROCESS_RESOURCE_EVENT_NAMES.systemWindow]: PERF_SYSTEM_WINDOW_PROPERTY_KEYS,
  [PROCESS_RESOURCE_EVENT_NAMES.toolExecResource]: PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS,
};

/**
 * Privacy rule: property keys never carry pid/path/workspace/session/task/command semantics.
 * device_mid and mcp_id do not match it (mid, p_id are not pid substrings).
 */
export const PROCESS_RESOURCE_FORBIDDEN_PROPERTY_KEY_PATTERN =
  /pid|path|workspace|session|task|command/i;

export interface ProcessResourceEventPropertyCheck {
  /// Allowlisted, within the count cap, no privacy keys.
  ok: boolean;
  /// Properties actually reported (undefined values excluded).
  count: number;
  overLimit: boolean;
  unknownKeys: string[];
  forbiddenKeys: string[];
}

/** Validate one event's properties against allowlist, count cap, and the privacy rule. */
export function checkProcessResourceEventProperties(
  eventName: ProcessResourceEventName,
  properties: Record<string, string | number | boolean | undefined>,
): ProcessResourceEventPropertyCheck {
  const whitelist = new Set(PROPERTY_KEY_WHITELIST[eventName]);
  const presentKeys = Object.entries(properties)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  const unknownKeys = presentKeys.filter((key) => !whitelist.has(key));
  const forbiddenKeys = presentKeys.filter((key) =>
    PROCESS_RESOURCE_FORBIDDEN_PROPERTY_KEY_PATTERN.test(key),
  );
  const count = presentKeys.length;
  const overLimit = count > ARMS_CUSTOM_EVENT_PROPERTY_LIMIT;

  return {
    ok: unknownKeys.length === 0 && forbiddenKeys.length === 0 && !overLimit,
    count,
    overLimit,
    unknownKeys,
    forbiddenKeys,
  };
}
