#!/usr/bin/env node
// Build the Linux x64 .deb from the already-packed dist/linux-unpacked tree, inside a
// Linux Docker container (electron-builder's fpm/appimage tooling fails when
// cross-packaging from macOS: appimage needs x86_64 mksquashfs via Rosetta, and fpm
// produced empty debs through the VirtioFS mount).
//
// Usage (from repo root, after `pnpm --filter @zcode/desktop build` and
// `pnpm exec electron-builder --config electron-builder.config.js --linux dir --x64`
// in packages/desktop):
//
//   docker run --rm -v "$PWD":/repo -v /tmp/build-deb.cjs:/build-deb.cjs \
//     node:22-bookworm-slim node /build-deb.cjs
//
// Adjustments applied on top of electron-builder's dir output:
// - Injects the real linux-x64 node-pty prebuild (the source tree can hold a corrupted
//   placeholder after failed cross-runs; the Host crashes on startup without it).
// - Removes resources/tools (native bfs/ugrep/ripgrep): those are compiled for the BUILD
//   host platform (darwin here) and cannot execute on Linux. The agent falls back to
//   standard system grep/find until linux binaries are compiled in a Linux CI job.
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = "/repo";
const UNPACKED = path.join(REPO, "packages/desktop/dist/linux-unpacked");
const PTY_PREBUILD_SRC = path.join(
  REPO,
  "node_modules/@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node",
);
const OUT = path.join(REPO, "packages/desktop/dist/ZCode-3.14.3-linux-amd64.deb");
const VERSION = "3.14.3";
const PKG = "zcode";
const ARCH = "amd64";
const MAINTAINER = "ZCode <dev@zcode.z.ai>";

const sh = (cmd) => execSync(cmd, { stdio: "inherit" });

if (!fs.existsSync(path.join(UNPACKED, "zcode"))) {
  console.error(`missing ${UNPACKED}/zcode — run the electron-builder --linux dir --x64 step first`);
  process.exit(1);
}
if (!fs.existsSync(PTY_PREBUILD_SRC)) {
  console.error(`missing ${PTY_PREBUILD_SRC}`);
  process.exit(1);
}

const root = "/tmp/debbuild";
fs.rmSync(root, { recursive: true, force: true });
const controlDir = path.join(root, "control");
const dataDir = path.join(root, "data");
fs.mkdirSync(controlDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

// ---- data tree ----
const appDir = path.join(dataDir, "opt/ZCode");
fs.mkdirSync(path.dirname(appDir), { recursive: true });
sh(`cp -a "${UNPACKED}" "${appDir}"`);
sh(`chmod -R u+rwX,go+rX,go-w "${dataDir}"`);

// Linux node-pty prebuild: the darwin prebuilds in the dir output are inert here; the
// linux-x64 binary is required for the Host to spawn a PTY at all.
const ptyPrebuilds = path.join(appDir, "resources/app.asar.unpacked/node_modules/node-pty/prebuilds");
fs.rmSync(path.join(ptyPrebuilds, "linux-arm64"), { recursive: true, force: true });
fs.mkdirSync(path.join(ptyPrebuilds, "linux-x64"), { recursive: true });
fs.copyFileSync(PTY_PREBUILD_SRC, path.join(ptyPrebuilds, "linux-x64", "pty.node"));
fs.chmodSync(path.join(ptyPrebuilds, "linux-x64", "pty.node"), 0o644);

// Native search tools are darwin binaries from this cross-build; drop them instead of
// shipping executables Linux cannot run.
fs.rmSync(path.join(appDir, "resources/tools"), { recursive: true, force: true });

fs.mkdirSync(path.join(dataDir, "usr/bin"), { recursive: true });
fs.symlinkSync("/opt/ZCode/zcode", path.join(dataDir, "usr/bin/zcode"));

const desktopEntry = [
  "[Desktop Entry]",
  "Name=ZCode",
  "Comment=ZCode coding agent",
  "Exec=/usr/bin/zcode",
  "Type=Application",
  "Icon=zcode",
  "StartupWMClass=ZCode",
  "Categories=Development;",
  "Terminal=false",
  "",
].join("\n");
fs.mkdirSync(path.join(dataDir, "usr/share/applications"), { recursive: true });
fs.writeFileSync(path.join(dataDir, "usr/share/applications/zcode.desktop"), desktopEntry);

fs.mkdirSync(path.join(dataDir, "usr/share/icons/hicolor/256x256/apps"), { recursive: true });
sh(`cp "${REPO}/packages/desktop/build/icon.png" "${dataDir}/usr/share/icons/hicolor/256x256/apps/zcode.png"`);

// ---- control ----
const depends = [
  "libgtk-3-0t64 | libgtk-3-0",
  "libnss3",
  "libnspr4",
  "libasound2t64 | libasound2",
  "libcups2t64 | libcups2",
  "libatk1.0-0t64 | libatk1.0-0",
  "libatk-bridge2.0-0t64 | libatk-bridge2.0-0",
  "libatspi2.0-0t64 | libatspi2.0-0",
  "libxcomposite1",
  "libxdamage1",
  "libxfixes3",
  "libxrandr2",
  "libgbm1",
  "libxkbcommon0",
  "libpango-1.0-0",
  "libcairo2",
  "libdrm2",
  "libx11-6",
  "libxcb1",
  "libxext6",
].join(", ");
const control = [
  `Package: ${PKG}`,
  `Version: ${VERSION}`,
  `Section: devel`,
  `Priority: optional`,
  `Architecture: ${ARCH}`,
  `Maintainer: ${MAINTAINER}`,
  `Depends: ${depends}`,
  `Installed-Size: ${Math.ceil(
    Number(execSync(`du -sk "${dataDir}"`).toString().trim().split("\t")[0]),
  )}`,
  `Description: ZCode coding agent desktop app`,
  ` Privacy-hardened fork build: telemetry and auto-update disabled; mission mode enabled.`,
  "",
].join("\n");
fs.writeFileSync(path.join(controlDir, "control"), control);
const md5Out = execSync(`cd "${dataDir}" && find . -type f | sort | xargs md5sum`).toString();
fs.writeFileSync(path.join(controlDir, "md5sums"), md5Out);

sh(`tar czf "${root}/control.tar.gz" --owner=0 --group=0 -C "${controlDir}" .`);
sh(`tar czf "${root}/data.tar.gz" --owner=0 --group=0 -C "${dataDir}" .`);
fs.writeFileSync(path.join(root, "debian-binary"), "2.0\n");

// ---- ar archive (plain member names; dpkg rejects BSD "/" suffixes) ----
function arEntry(name, buf) {
  const header = Buffer.alloc(60);
  header.write(name.padEnd(16, " "), 0, "latin1");
  header.write("0".padEnd(12, " "), 16, "latin1");
  header.write("0".padEnd(6, " "), 28, "latin1");
  header.write("0".padEnd(6, " "), 34, "latin1");
  header.write("100644".padEnd(8, " "), 40, "latin1");
  header.write(String(buf.length).padEnd(10, " "), 48, "latin1");
  header.write("\x60\n", 58, "latin1");
  const pad = buf.length % 2 === 1 ? Buffer.from("\n") : Buffer.alloc(0);
  return Buffer.concat([header, buf, pad]);
}

const archive = Buffer.concat([
  Buffer.from("!<arch>\n"),
  arEntry("debian-binary", fs.readFileSync(path.join(root, "debian-binary"))),
  arEntry("control.tar.gz", fs.readFileSync(path.join(root, "control.tar.gz"))),
  arEntry("data.tar.gz", fs.readFileSync(path.join(root, "data.tar.gz"))),
]);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, archive);
console.log("wrote", OUT, archive.length, "bytes");
