import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import type {
  ApplicationIconInfo,
  ApplicationIconRequest,
  ApplicationIconLocator,
} from "@zcode/shared";
import { app } from "electron";
import { getAppIconDataUrl } from "./editors.js";
import { logger } from "./logger.js";
import { readWindowsAumidIcon } from "./windowsAumidIcon.js";

const applicationIconCache = new Map<string, Promise<ApplicationIconInfo | null>>();
const SAFE_BUNDLE_ID = /^[A-Za-z0-9.-]+$/;
const SAFE_WINDOWS_FIXED_DRIVE_PATH = /^[A-Za-z]:[\\/][^\\/]/u;
const FALLBACK_SCAN_BUDGET_MS = 3_000;
const PLIST_READ_TIMEOUT_MS = 1_000;
const FALLBACK_SCAN_CONCURRENCY = 8;

interface ApplicationPathDependencies {
  execute: (command: string, args: readonly string[], timeoutMs: number) => Promise<string>;
  listDirectory: (path: string) => Promise<string[]>;
  homeDirectory: string;
  now: () => number;
}

const defaultApplicationPathDependencies: ApplicationPathDependencies = {
  execute: (command, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(command, [...args], { encoding: "utf8", timeout: timeoutMs }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    }),
  listDirectory: (path) => readdir(path),
  homeDirectory: homedir(),
  now: () => Date.now(),
};

let defaultApplicationPathIndex: Promise<Map<string, string>> | undefined;

function isSafeWindowsExecutablePath(value: string): boolean {
  // win32.isAbsolute accepts UNC/device paths; handing untrusted locators to
  // app.getFileIcon triggers main-process network file access. Fixed local drive letters only.
  return SAFE_WINDOWS_FIXED_DRIVE_PATH.test(value) && win32.isAbsolute(value);
}

async function buildApplicationPathIndex(
  dependencies: ApplicationPathDependencies,
): Promise<Map<string, string>> {
  const deadline = dependencies.now() + FALLBACK_SCAN_BUDGET_MS;
  const roots = [
    "/Applications",
    join(dependencies.homeDirectory, "Applications"),
    "/System/Applications",
    "/System/Applications/Utilities",
  ];
  const appPaths: string[] = [];
  for (const root of roots) {
    try {
      const entries = await dependencies.listDirectory(root);
      appPaths.push(
        ...entries.filter((entry) => entry.endsWith(".app")).map((entry) => join(root, entry)),
      );
    } catch {
      // Standard dirs may be missing/unreadable; keep scanning the rest.
    }
  }

  const index = new Map<string, string>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < appPaths.length) {
      const appPath = appPaths[cursor++];
      const remainingMs = deadline - dependencies.now();
      if (remainingMs <= 0) return;
      try {
        const bundleId = (
          await dependencies.execute(
            "/usr/libexec/PlistBuddy",
            ["-c", "Print :CFBundleIdentifier", join(appPath, "Contents", "Info.plist")],
            Math.min(PLIST_READ_TIMEOUT_MS, remainingMs),
          )
        ).trim();
        // Index keyed by lowercase bundle id: the CUA producer appKey is darwin:<id.toLowerCase()> while
        // Info.plist keeps original case (com.apple.Notes). Spotlight queries case-insensitively ("..."c);
        // a case-sensitive fallback index would miss icons only on Spotlight-less machines --
        // both paths must share case semantics.
        const key = bundleId.toLowerCase();
        if (SAFE_BUNDLE_ID.test(bundleId) && !index.has(key)) index.set(key, appPath);
      } catch {
        // One broken/timed-out plist must not kill the whole index.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FALLBACK_SCAN_CONCURRENCY, appPaths.length) }, worker),
  );
  return index;
}

function readFallbackApplicationPath(
  bundleId: string,
  dependencies: ApplicationPathDependencies,
): Promise<string | null> {
  // Per-id synchronous scans freeze Electron main; the default path shares one async index build.
  const indexPromise =
    dependencies === defaultApplicationPathDependencies
      ? (defaultApplicationPathIndex ??= buildApplicationPathIndex(dependencies))
      : buildApplicationPathIndex(dependencies);
  return indexPromise.then((index) => index.get(bundleId.toLowerCase()) ?? null);
}

async function resolveDarwinApplicationPath(
  bundleId: string,
  dependencies: ApplicationPathDependencies = defaultApplicationPathDependencies,
): Promise<string | null> {
  if (!SAFE_BUNDLE_ID.test(bundleId)) return null;
  try {
    const query = `kMDItemCFBundleIdentifier == "${bundleId}"c`;
    const spotlightPath = (await dependencies.execute("/usr/bin/mdfind", [query], 3_000))
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.endsWith(".app"));
    if (spotlightPath) return spotlightPath;
  } catch (error) {
    logger.warn("[application-icons] failed to resolve application path", {
      bundleId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return readFallbackApplicationPath(bundleId, dependencies);
}

interface NativeImageLike {
  isEmpty(): boolean;
  toDataURL(): string;
}

interface ApplicationIconLoaderDependencies {
  platform: NodeJS.Platform;
  getFileIcon: (path: string, options: { size: "normal" }) => Promise<NativeImageLike>;
  resolveDarwinApplicationPath: (bundleId: string) => Promise<string | null>;
  readWindowsAumidIcon?: (aumid: string) => Promise<ApplicationIconInfo | null>;
}

const defaultApplicationIconLoaderDependencies: ApplicationIconLoaderDependencies = {
  platform: process.platform,
  getFileIcon: (path, options) => app.getFileIcon(path, options),
  resolveDarwinApplicationPath,
  readWindowsAumidIcon,
};

function normalizedRequest(
  request: string | ApplicationIconRequest,
  platform: NodeJS.Platform,
): ApplicationIconRequest | null {
  if (typeof request !== "string") {
    if (!request || !Array.isArray(request.locators) || request.locators.length > 3) return null;
    const locators = request.locators.flatMap((locator) => {
      if (
        !locator ||
        (locator.kind !== "darwin-bundle-id" &&
          locator.kind !== "windows-executable-path" &&
          locator.kind !== "windows-aumid") ||
        typeof locator.value !== "string" ||
        !locator.value.trim()
      ) {
        return [];
      }
      const value = locator.value.trim();
      if (locator.kind === "windows-executable-path" && !isSafeWindowsExecutablePath(value)) {
        return [];
      }
      return [{ kind: locator.kind, value }];
    });
    return locators.length === request.locators.length && locators.length > 0 ? { locators } : null;
  }
  const value = request.trim();
  if (!value) return null;
  if (platform === "darwin" && SAFE_BUNDLE_ID.test(value)) {
    return { locators: [{ kind: "darwin-bundle-id", value }] };
  }
  // Legacy strings cover historical macOS bundle ids only. Windows exes must come from the official
  // CUA authority's structured locator, never model input treated as a local path.
  return null;
}

function locatorCacheKey(locator: ApplicationIconLocator): string {
  return `${locator.kind}:${locator.value.trim().toLowerCase()}`;
}

async function readFileIcon(
  path: string,
  dependencies: ApplicationIconLoaderDependencies,
): Promise<ApplicationIconInfo | null> {
  const image = await dependencies.getFileIcon(path, { size: "normal" });
  if (image.isEmpty()) return null;
  const iconDataUrl = image.toDataURL();
  return iconDataUrl ? { iconDataUrl } : null;
}

function createApplicationIconLoader(dependencies: ApplicationIconLoaderDependencies) {
  return async (request: string | ApplicationIconRequest): Promise<ApplicationIconInfo | null> => {
    const normalized = normalizedRequest(request, dependencies.platform);
    if (!normalized) return null;
    const locators = [...normalized.locators].sort(
      (left, right) =>
        Number(right.kind === "windows-aumid") - Number(left.kind === "windows-aumid"),
    );
    for (const locator of locators) {
      const value = locator.value.trim();
      try {
        if (
          locator.kind === "darwin-bundle-id" &&
          dependencies.platform === "darwin" &&
          SAFE_BUNDLE_ID.test(value)
        ) {
          const appPath = await dependencies.resolveDarwinApplicationPath(value);
          if (!appPath) continue;
          const iconDataUrl = await getAppIconDataUrl(value, appPath);
          if (iconDataUrl) return { iconDataUrl };
        }
        if (
          locator.kind === "windows-aumid" &&
          dependencies.platform === "win32" &&
          dependencies.readWindowsAumidIcon
        ) {
          const icon = await dependencies.readWindowsAumidIcon(value);
          if (icon) return icon;
        }
        if (
          locator.kind === "windows-executable-path" &&
          dependencies.platform === "win32" &&
          isSafeWindowsExecutablePath(value) &&
          win32.basename(value).toLowerCase() !== "applicationframehost.exe"
        ) {
          const icon = await readFileIcon(value, dependencies);
          if (icon) return icon;
        }
      } catch (error) {
        logger.warn("[application-icons] failed to load application icon", {
          locatorKind: locator.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return null;
  };
}

const loadApplicationIcon = createApplicationIconLoader(defaultApplicationIconLoaderDependencies);

export function getApplicationIcon(
  request: string | ApplicationIconRequest,
): Promise<ApplicationIconInfo | null> {
  const normalized = normalizedRequest(request, process.platform);
  if (!normalized) return Promise.resolve(null);
  const cacheKey = normalized.locators.map(locatorCacheKey).join("|");
  const cached = applicationIconCache.get(cacheKey);
  if (cached) return cached;
  const pending = loadApplicationIcon(normalized);
  applicationIconCache.set(cacheKey, pending);
  return pending;
}
