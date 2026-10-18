import { readCuaErrorDetails } from "@/ToolCallBlocks/renderers/cuaErrorDetails.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function readText(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseCuaTextAppState(value: string): Record<string, unknown> | null {
  const match = /^app:\s+([A-Za-z0-9.-]+)\s+pid=\d+\s+"([^"\r\n]+)"\s*$/mu.exec(value);
  if (!match) return null;
  const [, bundleId, name] = match;
  return { app: { bundle_id: bundleId, name } };
}

function parseCuaResultState(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  const structuredMarker = "Structured content:";
  const structuredStart = value.lastIndexOf(structuredMarker);
  const jsonStart = value.lastIndexOf("\n\n{");
  // Some MCP results append only an empty `Structured content:` marker after the valid main JSON.
  // Unconditionally parsing the empty post-marker string loses the app identity and degrades to
  // Computer Use. Real structured content still wins; when empty or invalid, parse the main JSON
  // before the marker.
  const candidates =
    structuredStart >= 0
      ? [
          value.slice(structuredStart + structuredMarker.length).trim(),
          value.slice(0, structuredStart).trim(),
        ]
      : jsonStart >= 0
        ? [value.slice(jsonStart + 2).trim(), value.trim()]
        : [value.trim()];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = asRecord(JSON.parse(candidate));
      if (!parsed) continue;
      const wrappedResult = parsed?.result;
      if (typeof wrappedResult === "string") {
        try {
          // MCP structuredContent may wrap the CUA JSON result again as a result string;
          // without unwrapping, structured fields like the name are lost and fall back to bundle_id.
          return asRecord(JSON.parse(wrappedResult)) ?? parsed;
        } catch {
          return parsed;
        }
      }
      return parsed;
    } catch {
      // get_app_state success results may be model-facing text state rather than JSON;
      // its stable app header already names the target app, and ignoring it degrades the summary
      // to Computer Use.
      const textState = parseCuaTextAppState(candidate);
      if (textState) return textState;
    }
  }
  return null;
}

export function readCuaResultBundleId(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | null {
  const errorBundleId = readCuaErrorDetails(toolCall)?.targetBundleId;
  if (errorBundleId) return errorBundleId;
  const rawOutput = readText(asRecord(toolCall.raw), "rawOutput");
  const result = parseCuaResultState(toolCall.output) ?? parseCuaResultState(rawOutput);
  const resultApp = asRecord(result?.app) ?? asRecord(result?.owner) ?? result;
  return readText(resultApp, "bundle_id") ?? readText(resultApp, "bundleId");
}

function readCuaInputApp(input: unknown): Record<string, unknown> | null {
  const inputRecord = asRecord(input);
  return parseRecord(inputRecord?.app) ?? parseRecord(inputRecord?.app_ref);
}

function parseCuaResultArrayLength(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const markerStart = value.lastIndexOf("\n\nStructured content:");
  const candidate = (markerStart >= 0 ? value.slice(0, markerStart) : value).trim();
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

export function readCuaResultListCount(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): number | null {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "cua") {
    const displayCount = parseCuaResultArrayLength(display.text);
    if (displayCount !== null) return displayCount;
  }
  const rawOutput = readText(asRecord(toolCall.raw), "rawOutput");
  return parseCuaResultArrayLength(toolCall.output) ?? parseCuaResultArrayLength(rawOutput);
}

function readCuaOutputText(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | null {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "cua" && display.text) return display.text;
  if (typeof toolCall.output === "string" && toolCall.output.trim()) return toolCall.output;
  return readText(asRecord(toolCall.raw), "rawOutput");
}

function stripElementRole(value: string): string {
  return value.replace(/^\S+\s+/u, "").trim();
}

function readElementName(elementLine: string): string | null {
  const content = elementLine.replace(/\s+\([^)]*\)\s*$/u, "").trim();
  const separator = content.lastIndexOf(" = ");
  if (separator < 0) return stripElementRole(content) || null;

  const left = content.slice(0, separator).trim();
  const right = content.slice(separator + 3).trim();
  // For textarea the right side of "=" is a possibly multiline body preview, not the accessible
  // name; treating the body as the target leaks long document excerpts into the context-menu
  // summary, so take the control name after the role.
  if (/^textarea\s+/iu.test(left)) return stripElementRole(left) || null;
  // For value widgets the right side is state like 0/1, not a target name; descriptive elements
  // such as text nodes use the right side as the readable name.
  return /^(?:-?\d+(?:\.\d+)?|true|false|null)$/iu.test(right)
    ? stripElementRole(left) || null
    : right || null;
}

export function readCuaActionTargetName(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | null {
  const target = parseRecord(asRecord(toolCall.input)?.target);
  if (
    target?.type !== "element" ||
    typeof target.index !== "number" ||
    !Number.isInteger(target.index)
  ) {
    return null;
  }
  const output = readCuaOutputText(toolCall);
  if (!output) return null;

  const lines = output.split(/\r?\n/u);
  const elementPattern = new RegExp(`^\\s*\\[${target.index}\\]\\s+(.+)$`, "u");
  const targetLineIndex = lines.findIndex((line) => elementPattern.test(line));
  if (targetLineIndex < 0) return null;

  const targetLine = lines[targetLineIndex];
  if (!targetLine) return null;
  const elementLine = elementPattern.exec(targetLine)?.[1];
  if (!elementLine) return null;
  const directName = readElementName(elementLine);
  if (directName !== String(target.index)) return directName;

  const childNames: string[] = [];
  const anyElementPattern = /^\s*\[\d+\]\s+(.+)$/u;
  for (const line of lines.slice(targetLineIndex + 1)) {
    const childLine = anyElementPattern.exec(line)?.[1];
    if (!childLine || !/^text\s+/iu.test(childLine)) break;
    const childName = readElementName(childLine);
    if (!childName) break;
    childNames.push(childName);
  }

  // CUA splits a button's name into flat text nodes right after it, leaving the button itself only
  // a numeric index. Read only consecutive text nodes and stop at the next actionable element so
  // neighboring control names never bleed into this summary.
  return childNames.length > 0 ? childNames.join("") : directName;
}

export function readCuaResultState(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): Record<string, unknown> | null {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "cua" && display.structuredContent) {
    // New-session display still keeps the MCP `{ result: "...json..." }` wrapper; the legacy
    // unwrapping must be reused, otherwise the display-first path cannot read the app name/state.
    const structured = parseCuaResultState(display.structuredContent);
    if (structured) return structured;
  }
  const rawOutput = readText(asRecord(toolCall.raw), "rawOutput");
  return parseCuaResultState(toolCall.output) ?? parseCuaResultState(rawOutput);
}

export function readCuaAppName(
  input: unknown,
  result: Record<string, unknown> | null,
): string | null {
  const inputRecord = asRecord(input);
  const inputApp = readCuaInputApp(inputRecord);
  const resultApp = asRecord(result?.app) ?? asRecord(result?.owner) ?? result;
  const name =
    readText(resultApp, "name") ??
    readText(resultApp, "display_name") ??
    readText(inputApp, "name");
  if (name) return name;
  const bundleId = readText(resultApp, "bundle_id") ?? readText(inputApp, "bundle_id");
  // Finder's list_windows-style results return only the stable system bundle ID, no app.name;
  // use the standard macOS name so summaries and details never show com.apple.finder.
  return bundleId === "com.apple.finder" ? "Finder" : bundleId;
}
