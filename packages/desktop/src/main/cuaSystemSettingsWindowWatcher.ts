/**
 * Data source for the System Settings window frame: spawns the resident zcode-window-bounds helper and reads its stdout.
 *
 * Every design choice follows one rule: snapping is a polish, not a usability requirement.
 *   - missing binary, spawn failure, crash, corrupted output -- all surface as latest() === null and
 *     the positioner fail-opens to the screen bottom. No path may throw, or a cosmetic feature
 *     escalates into grant-flow-cannot-open.
 *   - Stop reporting stale frames immediately after the helper dies, or the panel pins to the last
 *     known spot -- worse than the screen bottom (looks frozen).
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Rect } from "./cuaPermissionPanelPositioner.js";

export interface SystemSettingsWindowWatcher {
  start(): void;
  stop(): void;
  /** Latest parsed System Settings main-window bounds; null when unavailable. */
  latest(): Rect | null;
}

export interface CreateSystemSettingsWindowWatcherOptions {
  binaryPath: string;
  intervalMs?: number;
  platform?: NodeJS.Platform;
  spawnProcess?: (binaryPath: string, args: string[]) => ChildProcess;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

const DEFAULT_INTERVAL_MS = 150;

interface RawWindow {
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  layer?: unknown;
}

function toRect(raw: RawWindow): Rect | null {
  const { x, y, w, h, layer } = raw;
  // Layer 0 only: settings subwindows spawn higher layers (tooltips, popovers);
  // snapping to those throws the panel into a screen corner.
  if (layer !== 0) return null;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number"
  ) {
    return null;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

function parseLine(line: string): Rect | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  // Take the largest layer-0 window, not the z-order frontmost.
  //
  // After a drag lands, System Settings shows a modal notice (may not be able to record
  // the contents of your screen until it is quit...): same process, layer 0 too, z-ordered
  // above the main window -- taking the first pins the panel under the notice.
  // The settings main window is always the largest of these.
  let best: Rect | null = null;
  let bestArea = 0;
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const rect = toRect(entry as RawWindow);
    if (!rect) continue;
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = rect;
      bestArea = area;
    }
  }
  return best;
}

export function createSystemSettingsWindowWatcher(
  options: CreateSystemSettingsWindowWatcherOptions,
): SystemSettingsWindowWatcher {
  const platform = options.platform ?? process.platform;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const spawnProcess =
    options.spawnProcess ?? ((path, args) => spawn(path, args, { stdio: "pipe" }));

  let child: ChildProcess | null = null;
  let current: Rect | null = null;
  // stdout chunks ignore line boundaries; buffer lines ourselves -- per-chunk parse fails on real HW.
  let buffer = "";

  function reset(): void {
    current = null;
    buffer = "";
  }

  return {
    start(): void {
      if (platform !== "darwin" || child) return;
      try {
        child = spawnProcess(options.binaryPath, [String(intervalMs)]);
      } catch (error) {
        // Binary missing/not executable: fail-open; the panel works, just without snapping.
        options.logger.warn(
          "[cua-permission-panel] window bounds helper unavailable; panel will not anchor",
          error instanceof Error ? error.message : String(error),
        );
        child = null;
        return;
      }

      child.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const lines = buffer.split("\n");
        // The last segment may be a partial line; keep it buffered for the next chunk.
        buffer = lines.pop() ?? "";
        // Only the last complete line matters; earlier ones are stale positions.
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i]!;
          if (line.trim().length === 0) continue;
          current = parseLine(line);
          return;
        }
      });

      child.on("error", (error: Error) => {
        options.logger.warn("[cua-permission-panel] window bounds helper error", error.message);
        reset();
        child = null;
      });

      child.on("exit", (code: number | null) => {
        // A dead helper must not keep reporting stale frames; a pinned panel confuses more than the bottom fallback.
        if (code !== 0 && code !== null) {
          options.logger.warn("[cua-permission-panel] window bounds helper exited", code);
        }
        reset();
        child = null;
      });
    },

    stop(): void {
      if (child) {
        try {
          child.kill();
        } catch {
          // Already exited; ignore.
        }
        child = null;
      }
      reset();
    },

    latest(): Rect | null {
      return current;
    },
  };
}
