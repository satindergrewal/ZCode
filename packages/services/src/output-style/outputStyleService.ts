import type { OutputStyle, OutputStyleConfig } from "@zcode/shared";
import type { IOutputStyleService } from "./outputStyle.js";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_OUTPUT_STYLE = "default";
const SETTINGS_FILE = "settings.json";

const BUILT_IN_STYLES: OutputStyle[] = [
  {
    id: "default",
    name: "Default",
    description: "Completes coding tasks efficiently and provides concise responses",
    content: "",
    isBuiltIn: true,
    enabled: true,
  },
  {
    id: "explanatory",
    name: "Explanatory",
    description: "Explains implementation choices and codebase patterns",
    content: "",
    isBuiltIn: true,
    enabled: false,
  },
  {
    id: "learning",
    name: "Learning",
    description: "Pauses and asks you to write small pieces of code for hands-on practice",
    content: "",
    isBuiltIn: true,
    enabled: false,
  },
];

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getUserOutputStylesDir(): string {
  return join(resolveUserHomeDir(), ".claude", "output-styles");
}

function getUserClaudeSettingsPath(): string {
  return join(resolveUserHomeDir(), ".claude", SETTINGS_FILE);
}

interface ClaudeSettingsConfig {
  outputStyle?: string;
  hooks?: unknown;
  [key: string]: unknown;
}

/**
 * Read JSON file safely
 */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (error) {
    console.error(`Failed to read JSON file ${filePath}:`, error);
    return null;
  }
}

/**
 * Write JSON file safely
 */
async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  try {
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error(`Failed to write JSON file ${filePath}:`, error);
    throw error;
  }
}

/**
 * Parses markdown output style files
 */
function parseMarkdownStyle(
  content: string,
  filename?: string,
): { name: string; description: string } {
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  const descMatch = content.match(/^description:\s*(.+)$/m);

  let name = nameMatch?.[1]?.trim() ?? "";

  if (!name && filename) {
    name = filename.replace(/\.md$/, "");
  }

  if (!name) {
    name = "Custom Style";
  }

  const description = descMatch?.[1]?.trim() ?? "";

  return { name, description };
}

/**
 * Creates the OutputStyle service instance
 */
export function createOutputStyleService(): IOutputStyleService {
  async function getActiveStyle(): Promise<{ styleId: string | null }> {
    const settingsPath = getUserClaudeSettingsPath();
    const settings = await readJsonFile<ClaudeSettingsConfig>(settingsPath);
    return { styleId: settings?.outputStyle ?? null };
  }

  async function setActiveStyle(params: { styleId: string }): Promise<void> {
    const { styleId } = params;
    const settingsPath = getUserClaudeSettingsPath();
    const claudeDir = join(resolveUserHomeDir(), ".claude");

    // Ensure directory exists
    if (!existsSync(claudeDir)) {
      await mkdir(claudeDir, { recursive: true });
    }

    // Read existing settings.json
    const existingSettings = (await readJsonFile<ClaudeSettingsConfig>(settingsPath)) || {};

    // Update outputStyle
    const newSettings: ClaudeSettingsConfig = {
      ...existingSettings,
      outputStyle: styleId,
    };

    await writeJsonFile(settingsPath, newSettings);
  }

  async function listStyles(): Promise<{ styles: OutputStyle[] }> {
    const stylesDir = getUserOutputStylesDir();
    const customStyles: OutputStyle[] = [];

    // Get active style from settings.local.json, default to "default"
    const { styleId } = await getActiveStyle();
    const activeStyleId = styleId ?? "default";

    try {
      await access(stylesDir);
      const entries = await readdir(stylesDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const filePath = join(stylesDir, entry.name);
            const content = await readFile(filePath, "utf-8");
            const { name, description } = parseMarkdownStyle(content, entry.name);
            const styleId = `custom-${entry.name.replace(".md", "")}`;

            customStyles.push({
              id: styleId,
              name,
              description,
              content,
              isBuiltIn: false,
              enabled: styleId === activeStyleId,
              filePath,
            });
          } catch (error) {
            console.error(`Failed to read output style file ${entry.name}:`, error);
          }
        }
      }
    } catch {
      // Missing/unreadable dir: return the built-in styles
    }

    // Sort by name
    customStyles.sort((a, b) => a.name.localeCompare(b.name));

    // Merge built-in and custom styles, marking the active one
    const allStyles: OutputStyle[] = [
      ...BUILT_IN_STYLES.map((style) => ({
        ...style,
        enabled: style.id === activeStyleId,
      })),
      ...customStyles,
    ];

    return { styles: allStyles };
  }

  async function addStyle(params: { config: OutputStyleConfig }): Promise<void> {
    const { config } = params;
    const stylesDir = getUserOutputStylesDir();

    try {
      await mkdir(stylesDir, { recursive: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
    }

    const filename = `${config.name.toLowerCase().replace(/\s+/g, "-")}.md`;
    const filePath = join(stylesDir, filename);

    // Build the file contents
    const content = `name: ${config.name}
description: ${config.description}

${config.content}`;

    await writeFile(filePath, content, "utf-8");
  }

  async function updateStyle(params: { id: string; config: OutputStyleConfig }): Promise<void> {
    const { id, config } = params;

    // Strip the custom- prefix for the file name
    const baseId = id.startsWith("custom-") ? id.slice(7) : id;
    const stylesDir = getUserOutputStylesDir();
    const filename = `${baseId}.md`;
    const filePath = join(stylesDir, filename);

    // Build the file contents
    const content = `name: ${config.name}
description: ${config.description}

${config.content}`;

    await writeFile(filePath, content, "utf-8");
  }

  async function deleteStyle(params: { id: string }): Promise<void> {
    const { id } = params;

    // Strip the custom- prefix for the file name
    const baseId = id.startsWith("custom-") ? id.slice(7) : id;
    const stylesDir = getUserOutputStylesDir();
    const filename = `${baseId}.md`;
    const filePath = join(stylesDir, filename);

    await rm(filePath, { force: true });
  }

  async function getUserStylesDirectory(): Promise<{ path: string }> {
    const stylesDir = getUserOutputStylesDir();

    try {
      await mkdir(stylesDir, { recursive: true });
    } catch {
      // Directory already exists
    }

    return { path: stylesDir };
  }

  return {
    listStyles,
    addStyle,
    updateStyle,
    deleteStyle,
    getUserStylesDirectory,
    setActiveStyle,
    getActiveStyle,
  };
}
