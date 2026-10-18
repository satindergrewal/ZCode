import { existsSync, statSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

export const WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION = 1 as const;
export const DEFAULT_WORKSPACE_HOOK_TIMEOUT_MS = 60_000;
export const DEFAULT_WORKSPACE_HOOK_MAX_OUTPUT_BYTES = 32_768;
export const WORKSPACE_HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
] as const;

export type WorkspaceHookEventName = (typeof WORKSPACE_HOOK_EVENT_NAMES)[number];
export type WorkspaceHookConfigFileKind = "zcode.json" | ".zcode/config.json" | "explicit";

const positiveNumberSchema = z.number().finite().positive();

export const workspaceHookProcessConfigSchema = z
  .object({
    type: z.literal("process"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    args: z.array(z.string()).optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
  })
  .passthrough();

export const workspaceHookCommandConfigSchema = z
  .object({
    type: z.literal("command"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    async: z.boolean().optional(),
    shell: z.union([z.literal(true), z.string().min(1)]).optional(),
    timeout: positiveNumberSchema.optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
  })
  .passthrough();

export const workspaceHookMatcherConfigSchema = z
  .object({
    matcher: z.string().min(1).optional(),
    hooks: z
      .array(
        z.discriminatedUnion("type", [
          workspaceHookProcessConfigSchema,
          workspaceHookCommandConfigSchema,
        ]),
      )
      .min(1),
  })
  .strict();

export const workspaceHooksConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: positiveNumberSchema.optional(),
    maxOutputBytes: positiveNumberSchema.optional(),
    events: z
      .object({
        SessionStart: z.array(workspaceHookMatcherConfigSchema).optional(),
        UserPromptSubmit: z.array(workspaceHookMatcherConfigSchema).optional(),
        PreToolUse: z.array(workspaceHookMatcherConfigSchema).optional(),
        PermissionRequest: z.array(workspaceHookMatcherConfigSchema).optional(),
        PostToolUse: z.array(workspaceHookMatcherConfigSchema).optional(),
        PostToolUseFailure: z.array(workspaceHookMatcherConfigSchema).optional(),
        Stop: z.array(workspaceHookMatcherConfigSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WorkspaceHookDefinition =
  | z.infer<typeof workspaceHookCommandConfigSchema>
  | z.infer<typeof workspaceHookProcessConfigSchema>;
export type WorkspaceHooksConfig = z.infer<typeof workspaceHooksConfigSchema>;

export interface WorkspaceHookSourceInput {
  canonicalPath: string;
  baseDir: string;
  discoveryOrder: number;
  configFileKind: WorkspaceHookConfigFileKind;
  explicitProjectConfig: boolean;
  editable: boolean;
  hooks: WorkspaceHooksConfig;
}

export interface WorkspaceHookRuntimeRoot {
  enabled: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface WorkspaceHookConfigPathRef {
  path: string;
  explicitProjectConfig: boolean;
}

export interface WorkspaceHookSourceReadError {
  path: string;
  error: unknown;
}

export function resolveWorkspaceHookTimeoutMs(
  hook: Pick<WorkspaceHookDefinition, "type" | "timeoutMs"> & { timeout?: number },
  defaultTimeoutMs: number,
): number {
  const timeoutMs =
    hook.timeoutMs ??
    (hook.type === "command" && hook.timeout !== undefined
      ? hook.timeout * 1000
      : defaultTimeoutMs);
  return Math.max(1, Math.round(timeoutMs));
}

export function resolveWorkspaceHookMaxOutputBytes(maxOutputBytes: number): number {
  return Math.max(1, Math.round(maxOutputBytes));
}

/** Mirrors config-merger's hooks root semantics without materializing any callback. */
export function resolveWorkspaceHookRuntimeRoot(
  roots: readonly (
    | Partial<Pick<WorkspaceHooksConfig, "enabled" | "timeoutMs" | "maxOutputBytes">>
    | undefined
  )[],
): WorkspaceHookRuntimeRoot {
  let enabled = false;
  let timeoutMs = DEFAULT_WORKSPACE_HOOK_TIMEOUT_MS;
  let maxOutputBytes = DEFAULT_WORKSPACE_HOOK_MAX_OUTPUT_BYTES;

  for (const root of roots) {
    if (!root) continue;
    if (root.enabled === true) enabled = true;
    if (root.timeoutMs !== undefined) timeoutMs = root.timeoutMs;
    if (root.maxOutputBytes !== undefined) maxOutputBytes = root.maxOutputBytes;
  }

  return {
    enabled,
    timeoutMs: Math.max(1, Math.round(timeoutMs)),
    maxOutputBytes: resolveWorkspaceHookMaxOutputBytes(maxOutputBytes),
  };
}

export function resolveWorkspaceHookConfiguredGates(input: {
  sourceEnabled?: boolean;
  declarationEnabled?: boolean;
  runtimeHooksEnabled: boolean;
}) {
  const sourceRootEnabled = input.sourceEnabled !== false;
  const declarationEnabled = input.declarationEnabled !== false;
  return {
    sourceRootEnabled,
    declarationEnabled,
    runtimeHooksEnabled: input.runtimeHooksEnabled,
    configuredEnabled: sourceRootEnabled && declarationEnabled && input.runtimeHooksEnabled,
  };
}

/**
 * Candidate file paths from the discovered config-directory list.
 * Pure, shared by sync/async discovery, so candidate names and ordering rules live here once
 *(one flatMap for both, no divergent candidate generation).
 */
function buildWorkspaceHookCandidatePaths(directories: readonly string[]): string[] {
  return directories.flatMap((directory) => [
    join(directory, "zcode.json"),
    join(directory, ".zcode", "config.json"),
  ]);
}

/**
 * Dedupe discovered config refs by normalized path, keeping first occurrence.
 *
 * When an explicit projectConfigPath hits a file auto-discovery also found, the same file appears twice under
 * different explicitProjectConfig marks; entering the snapshot that way duplicates
 * sourceFile and declaration, forked bundleDigest.
 *
 * Policy: keep first occurrence (auto-discovered before explicit), drop later duplicates.
 * Never reorder survivors--discoveryOrder and explicitProjectConfig both feed the digest;
 * any reordering invalidates existing trust records (users re-prompted for every hook). Without explicit paths
 * auto-discovery cannot duplicate, so this is a no-op and bundleDigest is unchanged.
 */
function deduplicateWorkspaceHookConfigRefs(
  refs: readonly WorkspaceHookConfigPathRef[],
): WorkspaceHookConfigPathRef[] {
  const seen = new Set<string>();
  const result: WorkspaceHookConfigPathRef[] = [];
  for (const ref of refs) {
    const resolved = resolve(ref.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(ref);
  }
  return result;
}

export function discoverWorkspaceHookConfigPaths(input: {
  workingDirectory: string;
  explicitProjectConfigPath?: string;
}): WorkspaceHookConfigPathRef[] {
  const start = resolve(input.workingDirectory);
  const refs = buildWorkspaceHookCandidatePaths(getProjectConfigDirectories(start))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, explicitProjectConfig: false }));

  if (input.explicitProjectConfigPath) {
    const explicitPath = resolve(input.explicitProjectConfigPath);
    if (existsSync(explicitPath)) refs.push({ path: explicitPath, explicitProjectConfig: true });
  }
  return deduplicateWorkspaceHookConfigRefs(refs);
}

export function createWorkspaceHookSourceInput(input: {
  path: string;
  workingDirectory: string;
  hooks: WorkspaceHooksConfig;
  discoveryOrder: number;
  explicitProjectConfig?: boolean;
}): WorkspaceHookSourceInput {
  const canonicalPath = resolve(input.path);
  const explicitProjectConfig = input.explicitProjectConfig === true;
  const configDirectory = dirname(canonicalPath);
  return {
    canonicalPath,
    baseDir: basename(configDirectory) === ".zcode" ? dirname(configDirectory) : configDirectory,
    discoveryOrder: input.discoveryOrder,
    configFileKind: explicitProjectConfig
      ? "explicit"
      : basename(canonicalPath) === "zcode.json"
        ? "zcode.json"
        : ".zcode/config.json",
    explicitProjectConfig,
    editable:
      !explicitProjectConfig &&
      canonicalPath === resolve(input.workingDirectory, ".zcode", "config.json"),
    hooks: input.hooks,
  };
}

export async function readWorkspaceHookProjectSources(input: {
  workingDirectory: string;
  explicitProjectConfigPath?: string;
}): Promise<{ sources: WorkspaceHookSourceInput[]; errors: WorkspaceHookSourceReadError[] }> {
  const refs = await discoverWorkspaceHookConfigPathsAsync(input);
  const sources: WorkspaceHookSourceInput[] = [];
  const errors: WorkspaceHookSourceReadError[] = [];

  for (const [discoveryOrder, ref] of refs.entries()) {
    try {
      const value = JSON.parse(await readFile(ref.path, "utf8")) as unknown;
      if (!isRecord(value) || value.hooks === undefined) continue;
      sources.push(
        createWorkspaceHookSourceInput({
          path: ref.path,
          workingDirectory: input.workingDirectory,
          hooks: workspaceHooksConfigSchema.parse(value.hooks),
          discoveryOrder,
          explicitProjectConfig: ref.explicitProjectConfig,
        }),
      );
    } catch (error) {
      errors.push({ path: ref.path, error });
    }
  }
  return { sources, errors };
}

async function discoverWorkspaceHookConfigPathsAsync(input: {
  workingDirectory: string;
  explicitProjectConfigPath?: string;
}): Promise<WorkspaceHookConfigPathRef[]> {
  const start = resolve(input.workingDirectory);
  const candidates = buildWorkspaceHookCandidatePaths(
    await getProjectConfigDirectoriesAsync(start),
  );
  const refs: WorkspaceHookConfigPathRef[] = [];
  for (const path of candidates) {
    if (await pathExists(path)) refs.push({ path, explicitProjectConfig: false });
  }
  if (input.explicitProjectConfigPath) {
    const explicitPath = resolve(input.explicitProjectConfigPath);
    if (await pathExists(explicitPath)) {
      refs.push({ path: explicitPath, explicitProjectConfig: true });
    }
  }
  return deduplicateWorkspaceHookConfigRefs(refs);
}

async function getProjectConfigDirectoriesAsync(start: string): Promise<string[]> {
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (await hasWorktreeMarkerAsync(current)) return directories.reverse();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [start];
}

async function hasWorktreeMarkerAsync(directory: string): Promise<boolean> {
  try {
    const stats = await stat(join(directory, ".git"));
    return stats.isDirectory() || stats.isFile();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function getProjectConfigDirectories(start: string): string[] {
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (hasWorktreeMarker(current)) return directories.reverse();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [start];
}

function hasWorktreeMarker(directory: string): boolean {
  const marker = join(directory, ".git");
  try {
    if (!existsSync(marker)) return false;
    const stats = statSync(marker);
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
