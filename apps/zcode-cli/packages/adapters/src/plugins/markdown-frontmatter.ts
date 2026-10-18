import { readFileSync } from "node:fs";

/**
 * Minimal Markdown frontmatter extraction with YAML block scalars (> folded / | literal, +/- chomping).
 *
 * When plugins/describe read name/description with a one-line regex, a
 * description: > block scalar turned the > indicator into the whole description, leaving every skill blurb a bare >.
 * This reuses the skills adapter's block-scalar rules (skills/index.ts), folding continuation lines
 * into the full description; missing frontmatter or keys degrade to omitted, never fabricated.
 *
 * Only the name/description scalar keys (all detail views need); no full YAML parse.
 */
export function readMarkdownFrontmatter(filePath: string): {
  name?: string;
  description?: string;
} {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  return parseMarkdownFrontmatter(content);
}

/** Pure variant: parse frontmatter from a string, easing block-scalar unit tests. */
export function parseMarkdownFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const frontmatter = extractFrontmatter(content);
  if (frontmatter === null) return {};
  const values = parseFlatYamlScalars(frontmatter);
  const result: { name?: string; description?: string } = {};
  const name = parseScalar(values.name);
  if (name) result.name = name;
  const description = parseScalar(values.description);
  if (description) result.description = description;
  return result;
}

function extractFrontmatter(content: string): string | null {
  const normalized = content.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return null;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return null;
  return lines.slice(1, endIndex).join("\n");
}

/** Parse top-level key: value; block scalars (>/|) absorb following indented lines. Scalar strings only. */
function parseFlatYamlScalars(frontmatter: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    // Indented lines belong to the previous block scalar; the top-level scan skips them.
    if (/^\s/.test(line)) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key in values) continue;
    const blockStyle = parseBlockScalarStyle(value);
    if (blockStyle) {
      const block = readBlockScalar(lines, index + 1, blockStyle);
      values[key] = block.value;
      index = block.nextIndex - 1;
    } else {
      values[key] = value;
    }
  }
  return values;
}

function parseBlockScalarStyle(value: string): "folded" | "literal" | null {
  if (/^>[+-]?$/.test(value)) return "folded";
  if (/^\|[+-]?$/.test(value)) return "literal";
  return null;
}

function readBlockScalar(
  lines: string[],
  startIndex: number,
  style: "folded" | "literal",
): { value: string; nextIndex: number } {
  const rawLines: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    // A non-empty non-indented line ends the block scalar (back to top level).
    if (line.trim().length > 0 && !/^\s/.test(line)) break;
    rawLines.push(line);
    index += 1;
  }
  const indent = rawLines.reduce<number | null>((current, line) => {
    if (line.trim().length === 0) return current;
    const lineIndent = leadingWhitespaceLength(line);
    return current === null ? lineIndent : Math.min(current, lineIndent);
  }, null);
  const contentLines = rawLines.map((line) =>
    line.trim().length === 0 ? "" : line.slice(indent ?? 0),
  );
  return {
    value: style === "folded" ? foldBlockScalarLines(contentLines) : contentLines.join("\n").trim(),
    nextIndex: index,
  };
}

function leadingWhitespaceLength(value: string): number {
  const match = /^(\s*)/.exec(value);
  return match?.[1]?.length ?? 0;
}

/** Folded style (>): newlines in a paragraph become spaces, blank lines split paragraphs. */
function foldBlockScalarLines(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(trimmed);
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n").trim();
}

function parseScalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}
