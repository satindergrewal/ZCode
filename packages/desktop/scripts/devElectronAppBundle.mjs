import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEV_ELECTRON_PROTOCOL_SCHEME = "zcode";
export const DEV_ELECTRON_APP_NAME = "ZCode Dev";
export const DEV_ELECTRON_APP_BUNDLE_ID = "dev.zcode.app.development";
// Copy layout version; see the stamp notes in prepareDevElectronAppBundle.
export const DEV_ELECTRON_BUNDLE_FORMAT = 2;

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

function replacePlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`, "u");
  if (!pattern.test(plist)) {
    throw new Error(`Dev Electron Info.plist is missing ${key}`);
  }
  return plist.replace(
    pattern,
    (_match, prefix, suffix) => `${prefix}${escapeXml(value)}${suffix}`,
  );
}

function appendProtocolDeclaration(plist) {
  if (plist.includes(`<string>${DEV_ELECTRON_PROTOCOL_SCHEME}</string>`)) {
    return plist;
  }

  const closingDictIndex = plist.lastIndexOf("</dict>");
  if (closingDictIndex < 0) {
    throw new Error("Dev Electron Info.plist is missing its root dict");
  }

  const protocolDeclaration = `\n\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>${DEV_ELECTRON_APP_NAME}</string>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>${DEV_ELECTRON_PROTOCOL_SCHEME}</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>\n`;
  return `${plist.slice(0, closingDictIndex)}${protocolDeclaration}${plist.slice(closingDictIndex)}`;
}

/**
 * Writes product identity and the zcode URL scheme into the macOS local dev runtime.
 * Raw Electron's Info.plist has no CFBundleURLTypes, so the OS hands zcode to com.github.Electron;
 * only the launch copy is modified, leaving node_modules' Electron untouched.
 */
export function patchDevElectronInfoPlist(plist) {
  let patched = replacePlistString(plist, "CFBundleDisplayName", DEV_ELECTRON_APP_NAME);
  patched = replacePlistString(patched, "CFBundleIdentifier", DEV_ELECTRON_APP_BUNDLE_ID);
  patched = replacePlistString(patched, "CFBundleName", DEV_ELECTRON_APP_NAME);
  return appendProtocolDeclaration(patched);
}

export function resolveDevElectronAppBundlePath({ runtimeRoot, electronVersion, arch }) {
  return join(runtimeRoot, `${electronVersion}-${arch}`, `${DEV_ELECTRON_APP_NAME}.app`);
}

export async function prepareDevElectronAppBundle({
  electronAppPath,
  runtimeRoot,
  electronVersion,
  arch,
}) {
  const appPath = resolveDevElectronAppBundlePath({ runtimeRoot, electronVersion, arch });
  const infoPlistPath = join(appPath, "Contents", "Info.plist");
  const sourceExecutablePath = join(electronAppPath, "Contents", "MacOS", "Electron");
  const existingExecutablePath = join(appPath, "Contents", "MacOS", "Electron");
  // Source-binary identity stamp, kept outside the .app: putting it in Contents would pollute the bundle layout.
  const sourceStampPath = join(dirname(appPath), ".zcode-dev-electron-source.json");
  // This previously read both Electron executables (~100MB+ each) fully into memory for an equals check,
  // paying a full disk read per dev start. The source binary is an npm package extraction, so its size+mtime
  // stamp decides recopying; semantically equivalent at constant cost.
  //
  // Do not compare source vs copy mtime directly: cp rounds mtimes to milliseconds even with preserveTimestamps,
  // losing sub-ms precision, so the two sides never compare equal and the cache would be useless.
  //
  // The format field is the copy's layout version; bump it on layout fixes (e.g. symlink policy changes)
  // so an existing stale copy is recopied even when the source binary is unchanged.
  const sourceStats = await stat(sourceExecutablePath).catch(() => undefined);
  const sourceStamp = sourceStats
    ? JSON.stringify({
        format: DEV_ELECTRON_BUNDLE_FORMAT,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      })
    : undefined;
  let needsCopy = true;
  try {
    const existingInfoPlist = await readFile(infoPlistPath, "utf8");
    await access(existingExecutablePath);
    const existingStamp = await readFile(sourceStampPath, "utf8");
    needsCopy =
      !existingInfoPlist.includes(`<string>${DEV_ELECTRON_APP_BUNDLE_ID}</string>`) ||
      !existingInfoPlist.includes(`<string>${DEV_ELECTRON_PROTOCOL_SCHEME}</string>`) ||
      sourceStamp === undefined ||
      existingStamp !== sourceStamp;
  } catch {
    // Dir missing or not a bundle produced by this tool: fall through to a full copy.
  }

  if (needsCopy) {
    // Delete only this tool's ignored runtime dir; never touch node_modules or user data.
    await rm(appPath, { recursive: true, force: true });
    await rm(sourceStampPath, { force: true });
    await mkdir(dirname(appPath), { recursive: true });
    // verbatimSymlinks is required: Electron Framework.framework is organized by relative symlinks
    // (Resources -> Versions/Current/Resources, Current -> A). fs.cp by default rewrites
    // relative links to absolute node_modules paths; the main process still reads, but sandboxed
    // subprocesses (GPU/network) may only read this bundle, so following links out gets blocked as
    // icudtl.dat-not-found-in-bundle, then GPU-process-is-not-usable goodbye.
    await cp(electronAppPath, appPath, { recursive: true, verbatimSymlinks: true });
    const patchedInfoPlist = patchDevElectronInfoPlist(await readFile(infoPlistPath, "utf8"));
    await writeFile(infoPlistPath, patchedInfoPlist, "utf8");
    // Write the stamp last: on mid-copy failure the next run still sees a recopy as needed, never a half-made cache.
    if (sourceStamp !== undefined) await writeFile(sourceStampPath, sourceStamp, "utf8");
  }

  return {
    appPath,
    executablePath: join(appPath, "Contents", "MacOS", "Electron"),
  };
}
