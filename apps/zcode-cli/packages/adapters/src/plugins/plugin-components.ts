import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  PluginComponentGroup,
  PluginComponentItem,
  PluginComponentKind,
  PluginDiagnostic,
  PluginManifest,
} from "@zcode/contracts";
import { directoryExists, isRecord, resolveInside } from "./helpers.js";
import { listPluginHookEventNames } from "./hook-sources.js";
import { readMarkdownFrontmatter } from "./markdown-frontmatter.js";
import { loadPluginMcpServerDefinitions } from "./mcp.js";
import { scanSkillFilesUnderRootSync } from "../skills/scan.js";
import type { LoadedPlugin } from "./types.js";

// Component group types moved up to @zcode/contracts (PluginMetadata references them); re-exported for contract stability.
export type { PluginComponentGroup, PluginComponentItem, PluginComponentKind };

/**
 * Enumerate component names/descriptions over a resolved plugin root. Pure file reads, node:path/fs only.
 * The caller supplies the manifest (may be null); missing dirs or frontmatter skip or omit descriptions,
 * and one bad component never aborts the enumeration.
 */
export function enumeratePluginComponents(
  rootPath: string,
  manifest: PluginManifest | null,
  options: { diagnostics?: PluginDiagnostic[]; loaded?: LoadedPlugin } = {},
): PluginComponentGroup[] {
  const groups: PluginComponentGroup[] = [];
  const agentItems = collectMarkdownComponents(rootPath, manifest?.agents, "agents");
  if (agentItems.length > 0) groups.push({ kind: "agent", items: agentItems });

  const commandItems = collectMarkdownComponents(rootPath, manifest?.commands, "commands");
  if (commandItems.length > 0) groups.push({ kind: "command", items: commandItems });

  // Trust boundary: the enumeration rootPath is the plugin root; scans never follow symlinks,
  // regardless of loaded completeness (marketplace describe with failed manifest parse included).
  const skillItems = collectSkillComponents(rootPath, manifest?.skills);
  if (skillItems.length > 0) groups.push({ kind: "skill", items: skillItems });

  const hookItems = collectHookComponents(manifest, options);
  if (hookItems.length > 0) groups.push({ kind: "hook", items: hookItems });

  const mcpItems = collectMcpComponents(manifest, options);
  if (mcpItems.length > 0) groups.push({ kind: "mcp", items: mcpItems });

  return groups;
}

/** command/agent: .md files under default dirs plus manifest-declared paths, reading frontmatter name/description. */
function collectMarkdownComponents(
  rootPath: string,
  manifestField: unknown,
  defaultDir: "commands" | "agents",
): PluginComponentItem[] {
  const items: PluginComponentItem[] = [];
  const seen = new Set<string>();

  // Object-form declarations ({name: {source|content, description}}) take the declared description.
  if (isRecord(manifestField)) {
    for (const [rawName, rawMeta] of Object.entries(manifestField)) {
      const name = rawName.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const description =
        isRecord(rawMeta) && typeof rawMeta.description === "string"
          ? rawMeta.description.trim()
          : undefined;
      items.push(description ? { name, description } : { name });
    }
  }

  const dirs = collectComponentDirs(rootPath, manifestField, defaultDir);
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".md"))
        .map((dirent) => dirent.name);
    } catch {
      continue;
    }
    for (const fileName of entries) {
      const baseName = fileName.slice(0, -".md".length);
      const fm = readMarkdownFrontmatter(join(dir, fileName));
      const name = fm.name ?? baseName;
      if (seen.has(name)) continue;
      seen.add(name);
      items.push(fm.description ? { name, description: fm.description } : { name });
    }
  }
  return items;
}

/**
 * skill: enumerate under the default skills dir and manifest paths, reading SKILL.md frontmatter.
 * A root with its own SKILL.md is itself a skill; dedup by path and final name so declared and default
 * roots never double count and same-named skills in different paths cannot skew display.
 */
function collectSkillComponents(rootPath: string, manifestField: unknown): PluginComponentItem[] {
  const items: PluginComponentItem[] = [];
  const seenFiles = new Set<string>();
  const seenNames = new Set<string>();
  const dirs = collectComponentDirs(rootPath, manifestField, "skills");
  for (const dir of dirs) {
    let skillFiles: string[];
    try {
      skillFiles = scanSkillFilesUnderRootSync(dir, { followSymbolicLinks: false });
    } catch {
      continue;
    }
    for (const skillFile of skillFiles) {
      if (seenFiles.has(skillFile)) continue;
      seenFiles.add(skillFile);
      const fallbackName = basename(dirname(skillFile));
      const fm = readMarkdownFrontmatter(skillFile);
      const name = fm.name ?? fallbackName;
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      items.push(fm.description ? { name, description: fm.description } : { name });
    }
  }
  return items;
}

/** hook: reuse the loader's source discovery, extracting event names for display only, no executable hooks. */
function collectHookComponents(
  manifest: PluginManifest | null,
  options: { diagnostics?: PluginDiagnostic[]; loaded?: LoadedPlugin },
): PluginComponentItem[] {
  if (options.loaded) {
    return listPluginHookEventNames({
      diagnostics: options.diagnostics ?? [],
      loaded: options.loaded,
    }).map((name) => ({ name }));
  }
  if (!manifest) return [];
  return collectInlineHookEvents(manifest.hooks).map((name) => ({ name }));
}

/** mcp: reuse the loader's read-only .mcp.json + manifest.mcpServers parse, showing raw server names. */
function collectMcpComponents(
  manifest: PluginManifest | null,
  options: { diagnostics?: PluginDiagnostic[]; loaded?: LoadedPlugin },
): PluginComponentItem[] {
  if (options.loaded) {
    return Object.keys(
      loadPluginMcpServerDefinitions({
        diagnostics: options.diagnostics ?? [],
        loaded: options.loaded,
      }),
    )
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .map((name) => ({ name }));
  }
  if (!manifest || !isRecord(manifest.mcpServers)) return [];
  return Object.keys(manifest.mcpServers)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name }));
}

function collectInlineHookEvents(value: unknown): string[] {
  const hooksField =
    isRecord(value) && isRecord((value as Record<string, unknown>).hooks)
      ? ((value as Record<string, unknown>).hooks as Record<string, unknown>)
      : value;
  if (!isRecord(hooksField)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const event of Object.keys(hooksField)) {
    const name = event.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

//** Default dir conventions plus manifest string/array paths, merged into a deduped scan list. */
function collectComponentDirs(rootPath: string, manifestField: unknown, defaultDir: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const resolvedPath = resolveInside(rootPath, raw.replace(/^\.\//, ""));
    if (!resolvedPath || seen.has(resolvedPath)) return;
    seen.add(resolvedPath);
    dirs.push(resolvedPath);
  };
  const defaultPath = join(rootPath, defaultDir);
  if (directoryExists(defaultPath)) add(defaultDir);
  if (typeof manifestField === "string") add(manifestField);
  else if (Array.isArray(manifestField)) {
    for (const value of manifestField) if (typeof value === "string") add(value);
  }
  return dirs;
}
