/* eslint-disable max-lines -- staging and the afterPack verifier share one release contract; a single module keeps schema/PE rules from drifting. */
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  parse,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { collectRuntimeModuleClosureEntries } from "./runtime-dependency-closure.mjs";
import { resolveSharpRuntimePackageNames } from "./sharp-package-assets.mjs";

const EXPECTED_PACKAGE_NAME = "@zcode/zcode-cua";
const RUNTIME_MANIFEST = "runtime-manifest.json";
const MODULE_TYPE_PACKAGE_JSON = "package.json";
const REMOVE_DIRECTORY_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
};
const PE_MACHINE_BY_ARCH = {
  x64: 0x8664,
  arm64: 0xaa64,
};
const ELECTRON_BUILDER_ARCH = {
  1: "x64",
  3: "arm64",
};

export function resolveElectronBuilderWindowsTarget({
  electronPlatformName,
  arch,
  configuredTargetPlatform,
}) {
  if (electronPlatformName !== "win32") {
    throw new Error(
      `[windows-cua-helper-assets] electron-builder context platform is not win32: ${String(electronPlatformName)}`,
    );
  }
  const actualArch = ELECTRON_BUILDER_ARCH[arch];
  if (!actualArch) {
    throw new Error(
      `[windows-cua-helper-assets] unsupported electron-builder Windows architecture: ${String(arch)}`,
    );
  }
  const actualTarget = {
    os: "win32",
    arch: actualArch,
    key: `win32-${actualArch}`,
  };
  if (
    configuredTargetPlatform?.os !== actualTarget.os ||
    configuredTargetPlatform?.arch !== actualTarget.arch ||
    configuredTargetPlatform?.key !== actualTarget.key
  ) {
    // Root cause: under cross-builds the process.env target can differ from electron-builder's
    // actual context; trusting the global target makes afterPack skip or validate the wrong arch.
    throw new Error(
      `[windows-cua-helper-assets] configured target ${String(configuredTargetPlatform?.key)} does not match electron-builder target ${actualTarget.key}`,
    );
  }
  return actualTarget;
}

async function readContainedJson(
  physicalRoot,
  path,
  label,
  { lstatOperation = lstat, realpathOperation = realpath, readFileOperation = readFile } = {},
) {
  const bytes = await readRegularFileSnapshot(path, label, {
    lstatOperation,
    readFileOperation,
  });
  const physicalPath = await realpathOperation(path);
  assertPhysicalContainment(physicalRoot, physicalPath, label);
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] invalid ${label}: ${path}`, {
      cause: error,
    });
  }
}

export async function readRegularFileSnapshot(
  path,
  artifact,
  { lstatOperation = lstat, readFileOperation = readFile } = {},
) {
  let stats;
  try {
    stats = await lstatOperation(path);
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] missing ${artifact}: ${path}`, {
      cause: error,
    });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(
      `[windows-cua-helper-assets] ${artifact} must be a regular file, not a symbolic link: ${path}`,
    );
  }
  try {
    // TOCTOU: copying again from the source path after verify/hash can write changed bytes into
    // the artifact. Read the snapshot once; verification, disk writes and the manifest all use
    // exactly those bytes.
    return await readFileOperation(path);
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] cannot snapshot ${artifact}: ${path}`, {
      cause: error,
    });
  }
}

function parsePeMachine(bytes, addonPath) {
  if (bytes.length < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") {
    throw new Error(`[windows-cua-helper-assets] invalid PE header: ${addonPath}`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset > bytes.length - 6 ||
    bytes.toString("binary", peOffset, peOffset + 4) !== "PE\u0000\u0000"
  ) {
    throw new Error(`[windows-cua-helper-assets] invalid PE header: ${addonPath}`);
  }
  return bytes.readUInt16LE(peOffset + 4);
}

async function copyRuntimePackage(sourceRoot, targetRoot) {
  const skippedDirectories = new Set(["test", "tests", "__tests__", "node_modules"]);
  const skippedSuffixes = [".map", ".md", ".markdown", ".ts"];
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    dereference: true,
    filter(source) {
      if (source === sourceRoot) {
        return true;
      }
      const name = basename(source);
      if (skippedDirectories.has(name)) {
        return false;
      }
      return !skippedSuffixes.some((suffix) => name.endsWith(suffix));
    },
  });
}

function resolveModuleLookupRoots(sourceRoot) {
  const lookupRoots = [sourceRoot];
  const volumeRoot = parse(sourceRoot).root;
  let currentDir = dirname(sourceRoot);
  while (currentDir !== volumeRoot) {
    if (basename(currentDir) === "node_modules") {
      lookupRoots.push(dirname(currentDir));
      break;
    }
    currentDir = dirname(currentDir);
  }
  return lookupRoots;
}

export async function renameDirectoryWithRetries(
  source,
  destination,
  { renameOperation = rename, retryDelayMs = 100, maxAttempts = 5 } = {},
) {
  const transientWindowsErrors = new Set(["EACCES", "EBUSY", "EPERM"]);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await renameOperation(source, destination);
      return;
    } catch (error) {
      if (!transientWindowsErrors.has(error?.code) || attempt === maxAttempts) {
        throw error;
      }
      // Windows Defender or the indexer can hold handles briefly during the atomic dir swap.
      await delay(retryDelayMs * attempt);
    }
  }
}

async function atomicallyReplaceDirectory(stagedTempRoot, outputDir) {
  const backupDir = `${outputDir}.backup-${randomUUID()}`;
  let movedExistingOutput = false;
  try {
    await renameDirectoryWithRetries(outputDir, backupDir);
    movedExistingOutput = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await renameDirectoryWithRetries(stagedTempRoot, outputDir);
  } catch (error) {
    if (movedExistingOutput) {
      await renameDirectoryWithRetries(backupDir, outputDir);
    }
    throw error;
  }

  if (movedExistingOutput) {
    await rm(backupDir, REMOVE_DIRECTORY_OPTIONS);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isNonEmptyTrimmedString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isCanonicalRelativeArtifactPath(artifact) {
  return (
    typeof artifact === "string" &&
    artifact.length > 0 &&
    !artifact.includes("\\") &&
    !isAbsolute(artifact) &&
    !posix.isAbsolute(artifact) &&
    !win32.isAbsolute(artifact) &&
    posix.normalize(artifact) === artifact &&
    !artifact.split("/").some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        // Windows reads colon as an ADS separator and NUL as a terminator; reject before touching the filesystem.
        segment.includes(":") ||
        segment.includes("\0"),
    )
  );
}

function resolveCanonicalPackagedArtifact(root, artifact, label) {
  if (!isCanonicalRelativeArtifactPath(artifact)) {
    throw new Error(
      `[windows-cua-helper-assets] invalid ${label} path in ${RUNTIME_MANIFEST}: ${String(artifact)}`,
    );
  }
  const artifactPath = resolve(root, ...artifact.split("/"));
  const relativePath = relative(root, artifactPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`[windows-cua-helper-assets] ${label} path escapes packaged root: ${artifact}`);
  }
  return artifactPath;
}

// 2026-08-18: split contract violations into per-item readable checks. Eleven conditions used
// to share one if throwing a single "invalid zcodeCuaRuntime Windows artifact path contract",
// unable to tell a producer contract gap from the repo reading the wrong dir. This audit was
// misled by exactly that: node_modules pinned at a pre-repin commit (repins do not reinstall
// git deps), the old package lacked zcodeCuaRuntime, and it read as a producer regression.
// Errors must self-identify: who (name@version), where (source dir), which item failed.
function describeRuntimeContractViolation(packageJson) {
  if (!isPlainRecord(packageJson)) return "source package.json is not a JSON object";
  if (packageJson.name !== EXPECTED_PACKAGE_NAME) {
    return `unexpected package name ${JSON.stringify(packageJson.name)}`;
  }
  if (!isNonEmptyTrimmedString(packageJson.version)) {
    return `invalid package version ${JSON.stringify(packageJson.version)}`;
  }
  const contract = packageJson.zcodeCuaRuntime;
  if (contract === undefined) {
    return "zcodeCuaRuntime is missing — the producer package does not publish a Windows runtime contract";
  }
  if (!isPlainRecord(contract)) return "zcodeCuaRuntime is not a JSON object";
  if (!hasExactKeys(contract, ["schema", "windows"])) {
    return `zcodeCuaRuntime must have exactly the keys {schema, windows}, got {${Object.keys(contract).join(", ")}}`;
  }
  if (contract.schema !== 1) {
    return `zcodeCuaRuntime.schema must be 1, got ${JSON.stringify(contract.schema)}`;
  }
  const windowsContract = contract.windows;
  if (!isPlainRecord(windowsContract)) return "zcodeCuaRuntime.windows is not a JSON object";
  if (!hasExactKeys(windowsContract, ["entry", "nativeAddon"])) {
    return `zcodeCuaRuntime.windows must have exactly the keys {entry, nativeAddon}, got {${Object.keys(windowsContract).join(", ")}}`;
  }
  if (!isCanonicalRelativeArtifactPath(windowsContract.entry)) {
    return `zcodeCuaRuntime.windows.entry is not a canonical relative artifact path: ${JSON.stringify(windowsContract.entry)}`;
  }
  if (!isCanonicalRelativeArtifactPath(windowsContract.nativeAddon)) {
    return `zcodeCuaRuntime.windows.nativeAddon is not a canonical relative artifact path: ${JSON.stringify(windowsContract.nativeAddon)}`;
  }
  if (windowsContract.entry === windowsContract.nativeAddon) {
    return "zcodeCuaRuntime.windows.entry and zcodeCuaRuntime.windows.nativeAddon must differ";
  }
  return undefined;
}

function readProducerRuntimeContract(packageJson, sourceRoot) {
  const violation = describeRuntimeContractViolation(packageJson);
  if (violation) {
    const identity = isPlainRecord(packageJson)
      ? `${String(packageJson.name)}@${String(packageJson.version)}`
      : "<unreadable package.json>";
    throw new Error(
      `[windows-cua-helper-assets] invalid zcodeCuaRuntime Windows artifact path contract in ${identity} (${sourceRoot}): ${violation}`,
    );
  }
  const windowsContract = packageJson.zcodeCuaRuntime.windows;
  return {
    packageVersion: packageJson.version,
    entry: windowsContract.entry,
    addon: windowsContract.nativeAddon,
  };
}

function assertPhysicalContainment(root, artifactPath, label) {
  const relativePath = relative(root, artifactPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `[windows-cua-helper-assets] ${label} physical path is not contained by packaged root`,
    );
  }
}

function samePhysicalPath(expected, actual) {
  const normalize = (path) => {
    const normalized = resolve(path);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(expected) === normalize(actual);
}

function resolvePackagedRuntimePackageRoot(nodeModulesRoot, packageName) {
  if (
    typeof packageName !== "string" ||
    !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(packageName)
  ) {
    throw new Error(
      `[windows-cua-helper-assets] invalid runtime dependency name: ${String(packageName)}`,
    );
  }
  return resolve(nodeModulesRoot, ...packageName.split("/"));
}

async function verifyPackagedRuntimeDependencyClosure({
  root,
  physicalRoot,
  targetPlatform,
  lstatOperation,
  realpathOperation,
  readFileOperation,
}) {
  const nodeModulesRoot = resolve(root, "node_modules");
  const visited = new Set();
  const verifyPackage = async (packageName) => {
    if (visited.has(packageName)) return;
    visited.add(packageName);
    const packageRoot = resolvePackagedRuntimePackageRoot(nodeModulesRoot, packageName);
    let packageStats;
    try {
      packageStats = await lstatOperation(packageRoot);
    } catch (error) {
      throw new Error(`[windows-cua-helper-assets] missing runtime dependency: ${packageName}`, {
        cause: error,
      });
    }
    if (packageStats.isSymbolicLink() || !packageStats.isDirectory()) {
      throw new Error(
        `[windows-cua-helper-assets] runtime dependency must be a regular directory, not a symbolic link: ${packageName}`,
      );
    }
    const physicalPackageRoot = await realpathOperation(packageRoot);
    assertPhysicalContainment(
      physicalRoot,
      physicalPackageRoot,
      `runtime dependency ${packageName}`,
    );

    const packageJsonPath = resolve(packageRoot, "package.json");
    const packageJsonBytes = await readRegularFileSnapshot(
      packageJsonPath,
      `runtime dependency ${packageName}/package.json`,
      { lstatOperation, readFileOperation },
    );
    const physicalPackageJsonPath = await realpathOperation(packageJsonPath);
    assertPhysicalContainment(
      physicalRoot,
      physicalPackageJsonPath,
      `runtime dependency ${packageName}/package.json`,
    );
    let packageJson;
    try {
      packageJson = JSON.parse(
        Buffer.isBuffer(packageJsonBytes)
          ? packageJsonBytes.toString("utf8")
          : String(packageJsonBytes),
      );
    } catch (error) {
      throw new Error(
        `[windows-cua-helper-assets] invalid runtime dependency package.json: ${packageName}`,
        { cause: error },
      );
    }
    if (
      !isPlainRecord(packageJson) ||
      packageJson.name !== packageName ||
      (packageJson.dependencies !== undefined && !isPlainRecord(packageJson.dependencies))
    ) {
      throw new Error(
        `[windows-cua-helper-assets] invalid runtime dependency metadata: ${packageName}`,
      );
    }
    for (const dependencyName of Object.keys(packageJson.dependencies ?? {}).sort()) {
      await verifyPackage(dependencyName);
    }
  };

  const runtimePackageNames = ["express", ...resolveSharpRuntimePackageNames(targetPlatform)];
  for (const packageName of runtimePackageNames) {
    await verifyPackage(packageName);
  }
}

/**
 * Re-verify the final install dir against the release manifest after electron-builder copies assets.
 */
async function inspectPackagedWindowsCuaHelper({
  resourcesDir,
  targetPlatform,
  electronVersion,
  verifyHashes,
  lstatOperation = lstat,
  realpathOperation = realpath,
  readFileOperation = readFile,
}) {
  if (targetPlatform?.os !== "win32") {
    return { status: "skipped", reason: "unsupported-platform" };
  }
  if (!isAbsolute(resourcesDir)) {
    throw new Error("[windows-cua-helper-assets] resourcesDir must be absolute");
  }
  const expectedMachine = PE_MACHINE_BY_ARCH[targetPlatform.arch];
  if (!expectedMachine) {
    throw new Error(
      `[windows-cua-helper-assets] unsupported Windows architecture: ${targetPlatform.arch}`,
    );
  }
  const expectedElectronVersion = electronVersion?.trim();
  if (!expectedElectronVersion) {
    throw new Error("[windows-cua-helper-assets] electronVersion is required");
  }

  const root = resolve(resourcesDir, "tools", "cua-helper");
  let rootStats;
  try {
    rootStats = await lstatOperation(root);
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] packaged root is missing: ${root}`, {
      cause: error,
    });
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(
      `[windows-cua-helper-assets] packaged root must be a regular directory: ${root}`,
    );
  }
  const [physicalResourcesDir, physicalRoot] = await Promise.all([
    realpathOperation(resourcesDir),
    realpathOperation(root),
  ]);
  // A non-link root does not preclude a junctioned parent tools dir; the whole Helper tree could still land outside resources.
  assertPhysicalContainment(physicalResourcesDir, physicalRoot, "packaged root");

  const manifestPath = resolve(root, RUNTIME_MANIFEST);
  const manifestBytes = await readRegularFileSnapshot(manifestPath, RUNTIME_MANIFEST, {
    lstatOperation,
    readFileOperation,
  });
  const physicalManifestPath = await realpathOperation(manifestPath);
  assertPhysicalContainment(physicalRoot, physicalManifestPath, RUNTIME_MANIFEST);

  let manifest;
  try {
    manifest = JSON.parse(
      Buffer.isBuffer(manifestBytes) ? manifestBytes.toString("utf8") : String(manifestBytes),
    );
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] invalid ${RUNTIME_MANIFEST}: ${manifestPath}`, {
      cause: error,
    });
  }
  if (
    !isPlainRecord(manifest) ||
    !isPlainRecord(manifest.sha256) ||
    !hasExactKeys(manifest, [
      "schemaVersion",
      "packageName",
      "packageVersion",
      "platform",
      "arch",
      "electronVersion",
      "entry",
      "addon",
      "sha256",
    ]) ||
    !hasExactKeys(manifest.sha256, ["entry", "addon"]) ||
    !isNonEmptyTrimmedString(manifest.packageVersion) ||
    typeof manifest.entry !== "string" ||
    typeof manifest.addon !== "string" ||
    typeof manifest.sha256.entry !== "string" ||
    typeof manifest.sha256.addon !== "string" ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256.entry) ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256.addon)
  ) {
    throw new Error(
      `[windows-cua-helper-assets] invalid ${RUNTIME_MANIFEST} shape: ${manifestPath}`,
    );
  }
  if (manifest.entry === manifest.addon) {
    throw new Error(
      `[windows-cua-helper-assets] ${RUNTIME_MANIFEST} entry and addon must be distinct artifacts`,
    );
  }

  const expectedManifestFields = {
    schemaVersion: 1,
    packageName: EXPECTED_PACKAGE_NAME,
    platform: "win32",
    arch: targetPlatform.arch,
    electronVersion: expectedElectronVersion,
  };
  for (const [field, expected] of Object.entries(expectedManifestFields)) {
    if (manifest[field] !== expected) {
      throw new Error(
        `[windows-cua-helper-assets] incompatible ${RUNTIME_MANIFEST} ${field}: expected ${String(expected)}`,
      );
    }
  }

  const moduleTypePackageJsonPath = resolve(root, MODULE_TYPE_PACKAGE_JSON);
  const moduleTypePackageJsonBytes = await readRegularFileSnapshot(
    moduleTypePackageJsonPath,
    MODULE_TYPE_PACKAGE_JSON,
    {
      lstatOperation,
      readFileOperation,
    },
  );
  const physicalModuleTypePackageJsonPath = await realpathOperation(moduleTypePackageJsonPath);
  assertPhysicalContainment(
    physicalRoot,
    physicalModuleTypePackageJsonPath,
    MODULE_TYPE_PACKAGE_JSON,
  );
  let moduleTypePackageJson;
  try {
    moduleTypePackageJson = JSON.parse(
      Buffer.isBuffer(moduleTypePackageJsonBytes)
        ? moduleTypePackageJsonBytes.toString("utf8")
        : String(moduleTypePackageJsonBytes),
    );
  } catch (error) {
    throw new Error(
      `[windows-cua-helper-assets] invalid ${MODULE_TYPE_PACKAGE_JSON}: ${moduleTypePackageJsonPath}`,
      { cause: error },
    );
  }
  if (
    !isPlainRecord(moduleTypePackageJson) ||
    moduleTypePackageJson.type !== "module" ||
    moduleTypePackageJson.version !== manifest.packageVersion
  ) {
    // Root cause: entry is ESM; without a module field (or declared commonjs) the module type
    // falls back to detect-module probing, and any stray package.json on the install-drive chain
    // can hard-fail the fork with SyntaxError exit 1.
    throw new Error(
      `[windows-cua-helper-assets] ${MODULE_TYPE_PACKAGE_JSON} must declare {"type":"module"} and carry the same version as ${RUNTIME_MANIFEST}: ${moduleTypePackageJsonPath}`,
    );
  }

  const entryPath = resolveCanonicalPackagedArtifact(root, manifest.entry, "entry");
  const addonPath = resolveCanonicalPackagedArtifact(root, manifest.addon, "addon");
  const [entryBytes, addonBytes] = await Promise.all([
    readRegularFileSnapshot(entryPath, "entry", {
      lstatOperation,
      readFileOperation,
    }),
    readRegularFileSnapshot(addonPath, "addon", {
      lstatOperation,
      readFileOperation,
    }),
  ]);
  const [physicalEntryPath, physicalAddonPath] = await Promise.all([
    realpathOperation(entryPath),
    realpathOperation(addonPath),
  ]);
  // Root cause: manifest's lexical paths can sit inside root yet escape via junction/reparse
  // points; afterPack must also verify realpath containment, not just resolve/relative strings.
  assertPhysicalContainment(physicalRoot, physicalEntryPath, "entry");
  assertPhysicalContainment(physicalRoot, physicalAddonPath, "addon");

  if (verifyHashes) {
    if (sha256(entryBytes) !== manifest.sha256.entry) {
      throw new Error("[windows-cua-helper-assets] entry SHA-256 hash mismatch");
    }
    if (sha256(addonBytes) !== manifest.sha256.addon) {
      throw new Error("[windows-cua-helper-assets] addon SHA-256 hash mismatch");
    }
  }
  const peMachine = parsePeMachine(addonBytes, addonPath);
  if (peMachine !== expectedMachine) {
    throw new Error(
      `[windows-cua-helper-assets] PE machine mismatch: expected 0x${expectedMachine.toString(16)}, got 0x${peMachine.toString(16)}`,
    );
  }
  // Root cause: extraResources skips node_modules directly under the from root; checking only
  // entry/addon lets an installer with a Helper main tree but missing express/Sharp closure pass
  // afterPack.
  await verifyPackagedRuntimeDependencyClosure({
    root,
    physicalRoot,
    targetPlatform,
    lstatOperation,
    realpathOperation,
    readFileOperation,
  });

  return {
    status: "verified",
    root,
    entryPath,
    addonPath,
    peMachine,
    manifestPath,
    manifest,
    entryBytes,
    addonBytes,
  };
}

function toPackagedVerificationResult(inspection) {
  if (inspection.status === "skipped") return inspection;
  return {
    status: inspection.status,
    root: inspection.root,
    entryPath: inspection.entryPath,
    addonPath: inspection.addonPath,
    peMachine: inspection.peMachine,
  };
}

/**
 * After electron-builder copies assets, strictly verify the final install dir against the
 * release manifest.
 */
export async function verifyPackagedWindowsCuaHelper(options) {
  const inspection = await inspectPackagedWindowsCuaHelper({
    ...options,
    verifyHashes: true,
  });
  return toPackagedVerificationResult(inspection);
}

/**
 * Windows extraResources natives are signed during copy; signing changes bytes, so afterPack may
 * only refresh final-artifact hashes, then re-close the loop with the same strict verifier.
 */
export async function finalizePackagedWindowsCuaHelper({
  writeFileOperation = writeFile,
  ...options
}) {
  const inspection = await inspectPackagedWindowsCuaHelper({
    ...options,
    verifyHashes: false,
  });
  if (inspection.status === "skipped") return inspection;

  const finalizedManifest = {
    ...inspection.manifest,
    sha256: {
      entry: sha256(inspection.entryBytes),
      addon: sha256(inspection.addonBytes),
    },
  };
  await writeFileOperation(
    inspection.manifestPath,
    `${JSON.stringify(finalizedManifest, null, 2)}\n`,
    "utf8",
  );
  return verifyPackagedWindowsCuaHelper(options);
}

export async function resolveWindowsCuaHelperSourceRoot({
  runtimePackageDir,
  devRoot,
  servicesPackageRoot,
}) {
  const explicitRuntimePackageDir = runtimePackageDir?.trim();
  const explicitDevRoot = devRoot?.trim();
  const explicitRoot = explicitRuntimePackageDir || explicitDevRoot;
  if (explicitRoot) {
    if (!isAbsolute(explicitRoot)) {
      const variableName = explicitRuntimePackageDir
        ? "ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR"
        : "ZCODE_CUA_DEV_ROOT";
      throw new Error(`[windows-cua-helper-assets] ${variableName} must be absolute`);
    }
    return realpath(explicitRoot);
  }

  if (!isAbsolute(servicesPackageRoot)) {
    throw new Error("[windows-cua-helper-assets] servicesPackageRoot must be absolute");
  }
  // servicesPackageRoot is pinned to this repo's packages/services; never scan upward into the
  // user dir or another repo, or a missing package in this workspace could silently bind to a
  // same-named alias above.
  const workspaceRoot = resolve(servicesPackageRoot, "..", "..");
  const workspaceMarkerPath = resolve(workspaceRoot, "pnpm-workspace.yaml");
  let markerStats;
  try {
    markerStats = await lstat(workspaceMarkerPath);
  } catch (error) {
    throw new Error(
      `[windows-cua-helper-assets] pnpm-workspace.yaml is unavailable: ${workspaceMarkerPath}`,
      { cause: error },
    );
  }
  if (!markerStats.isFile() || markerStats.isSymbolicLink()) {
    throw new Error(
      `[windows-cua-helper-assets] pnpm-workspace.yaml must be a regular file: ${workspaceMarkerPath}`,
    );
  }

  const packagePathSegments = ["node_modules", "@zcode", "zcode-cua"];
  const packageCandidates = [
    resolve(servicesPackageRoot, ...packagePathSegments),
    resolve(workspaceRoot, ...packagePathSegments),
  ];
  for (const installedPackageRoot of new Set(packageCandidates)) {
    try {
      return await realpath(installedPackageRoot);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(
          `[windows-cua-helper-assets] packaged helper runtime is unavailable: ${installedPackageRoot}`,
          { cause: error },
        );
      }
    }
  }
  throw new Error(
    `[windows-cua-helper-assets] packaged helper runtime is unavailable: ${packageCandidates.join(", ")}`,
  );
}

export async function prepareWindowsCuaHelperAssets({
  sourceRoot,
  outputRoot,
  targetPlatform,
  electronVersion,
  afterArtifactSnapshot,
  lstatOperation = lstat,
  realpathOperation = realpath,
  readFileOperation = readFile,
}) {
  if (targetPlatform?.os !== "win32") {
    return { status: "skipped", reason: "unsupported-platform" };
  }
  if (!isAbsolute(sourceRoot) || !isAbsolute(outputRoot)) {
    throw new Error("[windows-cua-helper-assets] sourceRoot and outputRoot must be absolute");
  }
  const expectedMachine = PE_MACHINE_BY_ARCH[targetPlatform.arch];
  if (!expectedMachine) {
    throw new Error(
      `[windows-cua-helper-assets] unsupported Windows architecture: ${targetPlatform.arch}`,
    );
  }
  if (!electronVersion?.trim()) {
    throw new Error("[windows-cua-helper-assets] electronVersion is required");
  }

  let sourceRootStats;
  try {
    sourceRootStats = await lstatOperation(sourceRoot);
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] source root is unavailable: ${sourceRoot}`, {
      cause: error,
    });
  }
  if (sourceRootStats.isSymbolicLink() || !sourceRootStats.isDirectory()) {
    throw new Error(
      `[windows-cua-helper-assets] source root must be a regular directory, not a symbolic link: ${sourceRoot}`,
    );
  }
  const physicalSourceRoot = await realpathOperation(sourceRoot);
  // Checking sourceRoot leaves only misses junctioned parents; the explicit build root must
  // already resolve to a physical directory.
  if (!samePhysicalPath(sourceRoot, physicalSourceRoot)) {
    throw new Error(
      `[windows-cua-helper-assets] source root physical path does not match its configured location: ${sourceRoot}`,
    );
  }

  const packageJsonPath = resolve(sourceRoot, "package.json");
  const packageJson = await readContainedJson(
    physicalSourceRoot,
    packageJsonPath,
    "source package",
    { lstatOperation, realpathOperation, readFileOperation },
  );
  if (packageJson.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(
      `[windows-cua-helper-assets] unexpected package name: ${String(packageJson.name)}`,
    );
  }
  if (!isNonEmptyTrimmedString(packageJson.version)) {
    throw new Error(
      `[windows-cua-helper-assets] invalid package version: ${String(packageJson.version)}`,
    );
  }
  // Root cause: consumer-pinned versions and artifact dirs would force every producer release to
  // update ZCode in lockstep; the package.json contract is the compatibility boundary, and version
  // stays mere provenance metadata for the installed artifact.
  const producerContract = readProducerRuntimeContract(packageJson, sourceRoot);

  const entryPath = resolveCanonicalPackagedArtifact(
    sourceRoot,
    producerContract.entry,
    "zcodeCuaRuntime.windows.entry",
  );
  const addonPath = resolveCanonicalPackagedArtifact(
    sourceRoot,
    producerContract.addon,
    "zcodeCuaRuntime.windows.nativeAddon",
  );
  const [entryBytes, addonBytes] = await Promise.all([
    readRegularFileSnapshot(entryPath, "entry", {
      lstatOperation,
      readFileOperation,
    }),
    readRegularFileSnapshot(addonPath, "addon", {
      lstatOperation,
      readFileOperation,
    }),
  ]);
  const [physicalEntryPath, physicalAddonPath] = await Promise.all([
    realpathOperation(entryPath),
    realpathOperation(addonPath),
  ]);
  // Root cause: a spec-relative path can still traverse intermediate junctions; after reading the
  // snapshot, confirm the final physical location.
  assertPhysicalContainment(physicalSourceRoot, physicalEntryPath, "entry");
  assertPhysicalContainment(physicalSourceRoot, physicalAddonPath, "addon");
  const actualMachine = parsePeMachine(addonBytes, addonPath);
  if (actualMachine !== expectedMachine) {
    throw new Error(
      `[windows-cua-helper-assets] PE machine mismatch: expected 0x${expectedMachine.toString(16)}, got 0x${actualMachine.toString(16)}`,
    );
  }
  await afterArtifactSnapshot?.();

  const targetKey = `win32-${targetPlatform.arch}`;
  const outputDir = resolve(outputRoot, targetKey, "cua-helper");
  const outputParent = dirname(outputDir);
  await mkdir(outputParent, { recursive: true });
  const stagedTempRoot = resolve(outputParent, `.cua-helper.tmp-${randomUUID()}`);
  await mkdir(stagedTempRoot, { recursive: true });

  try {
    const stagedEntryPath = resolveCanonicalPackagedArtifact(
      stagedTempRoot,
      producerContract.entry,
      "entry",
    );
    const stagedAddonPath = resolveCanonicalPackagedArtifact(
      stagedTempRoot,
      producerContract.addon,
      "addon",
    );
    await Promise.all([
      mkdir(dirname(stagedEntryPath), { recursive: true }),
      mkdir(dirname(stagedAddonPath), { recursive: true }),
      mkdir(resolve(stagedTempRoot, "node_modules"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(stagedEntryPath, entryBytes),
      writeFile(stagedAddonPath, addonBytes),
    ]);

    const moduleLookupRoots = resolveModuleLookupRoots(sourceRoot);
    const expressEntries = collectRuntimeModuleClosureEntries(["express"], moduleLookupRoots);
    const sharpModuleNames = resolveSharpRuntimePackageNames({
      os: "win32",
      arch: targetPlatform.arch,
    });
    const sharpModuleNameSet = new Set(sharpModuleNames);
    // Sharp declares optionalDependencies for every platform; keep only the current target set so
    // foreign-arch natives never enter the installer or its signing surface.
    const sharpEntries = collectRuntimeModuleClosureEntries(
      sharpModuleNames,
      moduleLookupRoots,
    ).filter((entry) => sharpModuleNameSet.has(entry.moduleName));
    const runtimeEntries = [
      ...new Map(
        [...expressEntries, ...sharpEntries].map((entry) => [entry.moduleName, entry]),
      ).values(),
    ];
    for (const entry of runtimeEntries) {
      if (!entry.sourceModulePath) {
        throw new Error(
          `[windows-cua-helper-assets] missing runtime dependency: ${entry.moduleName}`,
        );
      }
      await copyRuntimePackage(
        entry.sourceModulePath,
        resolve(stagedTempRoot, "node_modules", entry.moduleName),
      );
    }

    const [stagedEntryBytes, stagedAddonBytes] = await Promise.all([
      readFile(stagedEntryPath),
      readFile(stagedAddonPath),
    ]);
    const manifest = {
      schemaVersion: 1,
      packageName: EXPECTED_PACKAGE_NAME,
      packageVersion: producerContract.packageVersion,
      platform: "win32",
      arch: targetPlatform.arch,
      electronVersion: electronVersion.trim(),
      entry: producerContract.entry,
      addon: producerContract.addon,
      sha256: {
        entry: sha256(stagedEntryBytes),
        addon: sha256(stagedAddonBytes),
      },
    };
    await writeFile(
      resolve(stagedTempRoot, RUNTIME_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    // Root cause (ZCT-2093176018262081536): entry is ESM with bare imports; when staging copied
    // only entry/addon, the producer's package.json stayed in the source dir and module-type
    // resolution on the install drive fell back to the drive root. Node >= 22.7's detect-module
    // covers the default case, but any stray package.json with "type" on the install chain
    // disables probing and the fork dies with SyntaxError exit 1 as broker_unavailable.
    // Land an explicit module declaration in the runtime root so the entry's module type never
    // depends on probing or external dirs.
    const moduleTypePackageJson = {
      name: "@zcode/zcode-cua-helper-runtime",
      version: producerContract.packageVersion,
      type: "module",
      private: true,
      main: producerContract.entry,
    };
    await writeFile(
      resolve(stagedTempRoot, MODULE_TYPE_PACKAGE_JSON),
      `${JSON.stringify(moduleTypePackageJson, null, 2)}\n`,
      "utf8",
    );
    await atomicallyReplaceDirectory(stagedTempRoot, outputDir);
    return { status: "staged", outputDir, manifest, peMachine: actualMachine };
  } catch (error) {
    await rm(stagedTempRoot, REMOVE_DIRECTORY_OPTIONS);
    throw error;
  }
}
