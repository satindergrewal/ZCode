"use strict";

const v8 = require("node:v8");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { basename, dirname, join } = require("node:path");

function configureBytecodeRuntime() {
  // Bytecode ships without recompilable sources; it must be fully compiled and the bytecode
  // kept. Compiler and loader share this single configuration.
  v8.setFlagsFromString("--no-lazy --no-flush-bytecode");
  return {
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cachedDataVersionTag: v8.cachedDataVersionTag(),
  };
}

function bytecodeDigest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function loadBytecode(metadata, targetModule, targetRequire) {
  const runtime = configureBytecodeRuntime();
  if (JSON.stringify(runtime) !== JSON.stringify(metadata.runtime)) {
    throw new Error(
      "bytecode runtime mismatch; re-run pnpm build:desktop-agent:bytecode with the current Electron",
    );
  }
  const directory = dirname(targetModule.filename);
  if (basename(metadata.bytecodeFile) !== metadata.bytecodeFile) {
    throw new Error("invalid bytecode file name");
  }
  const cachedData = await readFile(join(directory, metadata.bytecodeFile));
  if (bytecodeDigest(cachedData) !== metadata.bytecodeSha256) {
    throw new Error("bytecode digest mismatch; rebuild the desktop agent");
  }
  // ASCII spaces, not double-byte zero-width characters. Only the plaintext source is erased;
  // the equal-length placeholder memory remains.
  const source = " ".repeat(metadata.sourceLength);
  const filename = join(directory, metadata.sourceFile);
  const script = new vm.Script(source, {
    cachedData,
    filename,
    // Dynamic import must be handed back to Node, resolving external ESM and native deps
    // against the original bundle's URL.
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  if (script.cachedDataRejected) {
    throw new Error("V8 rejected the bytecode cache; rebuild the desktop agent");
  }
  const run = script.runInThisContext();
  if (typeof run !== "function") throw new Error("bytecode is not a CommonJS module");
  run.call(
    targetModule.exports,
    targetModule.exports,
    targetRequire,
    targetModule,
    filename,
    directory,
  );
}

module.exports = { configureBytecodeRuntime, bytecodeDigest, loadBytecode };
