import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { prepareDevElectronAppBundle } from "./devElectronAppBundle.mjs";

const root = resolve(import.meta.dirname, "..");
const mainBundle = resolve(root, "out/main/index.js");
const buildReadyMarkers = [
  { name: "main", path: resolve(root, "out/.main-build-ready") },
  { name: "host", path: resolve(root, "out/.host-build-ready") },
  { name: "preload", path: resolve(root, "out/.preload-build-ready") },
];
const waitLogIntervalMs = 3_000;
const require = createRequire(import.meta.url);

function resolveLocalElectronBinary() {
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackageRoot = resolve(electronPackageJsonPath, "..");

  // This used to spawn("electron") directly on Windows, relying on PATH luckily containing the local bin.
  // Under pnpm + PowerShell, children often get the node executable but not the electron command,
  // leaving dev stuck on ENOENT until manually split across three terminals.
  // Resolve the project-installed Electron binary explicitly to avoid cross-shell/platform PATH semantics.
  if (process.platform === "win32") {
    return resolve(electronPackageRoot, "dist", "electron.exe");
  }

  if (process.platform === "darwin") {
    return resolve(electronPackageRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron");
  }

  return resolve(electronPackageRoot, "dist", "electron");
}

function probeHttpUrl(url) {
  return new Promise((resolveProbe) => {
    const req = request(url, { method: "HEAD", timeout: 1_000 }, (res) => {
      res.resume();
      resolveProbe({ ok: true });
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => {
      resolveProbe({
        ok: false,
        reason: `${error.code ? `${error.code} ` : ""}${error.message}`,
      });
    });
    req.end();
  });
}

// Wait for both Vite dev server and main bundle to be ready
async function waitForReady() {
  // desktop's tsup is really three independent watch builds: main/host/preload.
  // Any single success could previously release the gate; Electron started while other artifacts were still
  // settling, reading half-written ESM/CJS. All three ready markers are now required, plus a main-bundle existence check.
  let lastBuildWaitLogAt = 0;
  while (true) {
    const missingMarkers = buildReadyMarkers
      .filter((marker) => !existsSync(marker.path))
      .map((marker) => marker.name);
    const hasMainBundle = existsSync(mainBundle);
    if (missingMarkers.length === 0 && hasMainBundle) {
      break;
    }
    const now = Date.now();
    if (now - lastBuildWaitLogAt >= waitLogIntervalMs) {
      // When startup waits, the last terminal line sits at tsup watch logs, hiding which condition is unmet.
      // Print waiting state periodically so a missing marker or main bundle is visible from logs alone.
      console.log(
        `[dev] Waiting for build artifacts... missingMarkers=${
          missingMarkers.join(",") || "none"
        } mainBundle=${hasMainBundle ? "ready" : "missing"}`,
      );
      lastBuildWaitLogAt = now;
    }
    await sleep(300);
  }

  // Wait for Vite dev server
  // Depending on local DNS/IPv6 config, Vite may bind only localhost/::1 or only 127.0.0.1.
  // Poll several loopback addresses so a dev-script/Vite mismatch never leaves Electron waiting forever.
  const viteUrls = ["http://localhost:5174", "http://127.0.0.1:5174", "http://[::1]:5174"];
  let lastViteWaitLogAt = 0;
  while (true) {
    const failures = [];
    for (const viteUrl of viteUrls) {
      const result = await probeHttpUrl(viteUrl);
      if (result.ok) {
        return viteUrl;
      }
      failures.push(`${viteUrl}: ${result.reason}`);
    }
    const now = Date.now();
    if (now - lastViteWaitLogAt >= waitLogIntervalMs) {
      console.log(`[dev] Waiting for Vite dev server... ${failures.join(" | ")}`);
      lastViteWaitLogAt = now;
    }
    await sleep(300);
  }
}

const rendererUrl = await waitForReady();
console.log("[dev] Starting Electron...");

const electronBinary = resolveLocalElectronBinary();
let electronCommand = existsSync(electronBinary) ? electronBinary : "electron";

if (process.platform === "darwin" && existsSync(electronBinary)) {
  // Raw Electron launched from the CLI lacks CFBundleURLTypes, so LaunchServices hands zcode://
  // to a stock Electron shell with no project entry. Patching the local copy's Info.plist with product
  // metadata lets the production Share page keep handing links to the running Dev instance, unaware of Dev.
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackage = JSON.parse(await readFile(electronPackageJsonPath, "utf8"));
  const electronAppPath = resolve(electronBinary, "../../..");
  const devBundle = await prepareDevElectronAppBundle({
    electronAppPath,
    runtimeRoot: resolve(root, "../../.zcode-runtime/desktop-dev"),
    electronVersion: electronPackage.version,
    arch: process.arch,
  });
  electronCommand = devBundle.executablePath;
  console.log(`[dev] Prepared macOS ZCode Dev bundle: ${devBundle.appPath}`);
}

const electron = spawn(electronCommand, ["."], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
  windowsHide: true,
  detached: process.platform !== "win32",
});

let electronClosed = false;
let shuttingDown = false;
let forceKillTimer;
let hardExitTimer;

function signalElectronTree(signal) {
  if (electronClosed || !electron.pid) {
    return;
  }

  if (process.platform === "win32") {
    electron.kill(signal);
    return;
  }

  try {
    process.kill(-electron.pid, signal);
  } catch {
    electron.kill(signal);
  }
}

function forceKillElectronTree() {
  if (electronClosed || !electron.pid) {
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(electron.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  signalElectronTree("SIGKILL");
}

function shutdownFromSignal(signal) {
  if (shuttingDown) {
    forceKillElectronTree();
    return;
  }

  shuttingDown = true;
  console.log(`[dev] Received ${signal}, stopping Electron...`);
  // On Ctrl+C, concurrently only kills the node scripts/dev.mjs wrapper; Electron on macOS does not reliably
  // handle SIGINT/SIGTERM and used to be orphaned to ppid=1, holding ports and logs.
  // Run Electron in its own process group, reap it from the dev script, and force-kill the whole tree on timeout.
  signalElectronTree("SIGTERM");
  forceKillTimer = setTimeout(forceKillElectronTree, 1_500);
  hardExitTimer = setTimeout(() => process.exit(0), 5_000);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => shutdownFromSignal(signal));
}

electron.on("error", (error) => {
  console.error("[dev] Failed to start Electron:", error);
  process.exit(1);
});

electron.on("close", (code, signal) => {
  electronClosed = true;
  clearTimeout(forceKillTimer);
  clearTimeout(hardExitTimer);
  if (shuttingDown) {
    process.exit(0);
  }
  process.exit(code ?? (signal ? 1 : 0));
});
