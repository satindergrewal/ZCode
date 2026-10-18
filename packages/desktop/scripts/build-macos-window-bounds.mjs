#!/usr/bin/env node
// Compile the macOS window-bounds helper (snap data source for the CUA permission panel).
//
// Skip on non-darwin: the binary only serves macOS TCC onboarding; other platforms have no equivalent flow.
// A missing swiftc (no Xcode CLT) warns without failing; snapping is cosmetic and without bounds the panel
// fail-opens to the screen bottom and stays usable, so this must never fail the desktop build.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageRoot, "native", "macos-window-bounds", "main.swift");
const outputDir = join(packageRoot, "resources", "macos-window-bounds");
const outputPath = join(outputDir, "zcode-window-bounds");

if (process.platform !== "darwin") {
  console.log("[window-bounds] skipped: macOS only");
  process.exit(0);
}

if (!existsSync(sourcePath)) {
  console.error(`[window-bounds] source file missing: ${sourcePath}`);
  process.exit(1);
}

function hasSwiftc() {
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!hasSwiftc()) {
  console.warn(
    "[window-bounds] swiftc not found (Xcode Command Line Tools required); skipping build.",
  );
  console.warn(
    "[window-bounds] permission panel still works but will not snap to System Settings.",
  );
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });

try {
  // Produce a universal arm64 + x86_64 binary so release packages run on either architecture.
  execFileSync(
    "xcrun",
    ["swiftc", "-O", "-target", "arm64-apple-macos11", sourcePath, "-o", `${outputPath}-arm64`],
    { stdio: "inherit" },
  );
  execFileSync(
    "xcrun",
    ["swiftc", "-O", "-target", "x86_64-apple-macos11", sourcePath, "-o", `${outputPath}-x86_64`],
    { stdio: "inherit" },
  );
  execFileSync(
    "lipo",
    ["-create", `${outputPath}-arm64`, `${outputPath}-x86_64`, "-output", outputPath],
    { stdio: "inherit" },
  );
  execFileSync("rm", ["-f", `${outputPath}-arm64`, `${outputPath}-x86_64`]);
  console.log(`[window-bounds] built universal binary: ${outputPath}`);
} catch (error) {
  console.warn(
    "[window-bounds] build failed; permission panel still works without snapping:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(0);
}
