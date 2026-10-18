"use strict";

const { readFile, writeFile } = require("node:fs/promises");
const Module = require("node:module");
const vm = require("node:vm");
const {
  configureBytecodeRuntime,
  bytecodeDigest,
} = require("./desktop-agent-bytecode-runtime.cjs");

async function compile() {
  const [entryPath, outputPath] = process.argv.slice(2);
  const runtime = configureBytecodeRuntime();
  if (!runtime.electron)
    throw new Error("desktop agent bytecode must be compiled by Electron in Node mode");
  const source = await readFile(entryPath, "utf8");
  const wrapped = Module.wrap(source.replace(/^#![^\r\n]*/, ""));
  const script = new vm.Script(wrapped, {
    filename: entryPath,
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  // Compile only, never run the module; cache warm-up must not trigger the CLI's storage,
  // network, or process side effects.
  const cachedData = script.createCachedData();
  await writeFile(outputPath, cachedData);
  process.stdout.write(
    JSON.stringify({
      runtime,
      sourceLength: wrapped.length,
      sourceSha256: bytecodeDigest(Buffer.from(source)),
      bytecodeSha256: bytecodeDigest(cachedData),
      bytecodeBytes: cachedData.length,
    }),
  );
}

compile().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
