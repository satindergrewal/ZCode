/* eslint-disable max-lines */
// Security note: signature pinning, process spawn, and protocol parsing share one audit boundary;
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ZCODE_COMMIT, ZCODE_VERSION } from "@zcode/shared";
import {
  createEncodedPowerShellArgs,
  createWindowsPowerShellSecurityArgs,
} from "../../scripts/powershell-command.mjs";
import { isElectronAppPackaged } from "./desktopElectronApp.js";

const HELPER_PROTOCOL = "ZCODE_BROWSER_IMPORT_V1";
const HELPER_VERSION_PROTOCOL = "ZCODE_BROWSER_IMPORT_HELPER";
const HELPER_VERSION = "2";
const HELPER_TIMEOUT_MS = 90_000;
const HELPER_MAX_OUTPUT_BYTES = 128 * 1024;
const HELPER_FILENAME = "zcode-browser-import-helper.exe";
const APP_BOUND_HELPER_FAILURE_REASONS = new Set([
  "helper_failed",
  "broker_initialization_failed",
  "controller_handshake_failed",
  "service_channel_failed",
  "elevation_failed",
  "timeout",
  "peer_verification_failed",
  "service_failed",
  "validation_failed",
  "unsupported_key",
  "cng_failed",
  "decryption_failed",
  "service_cleanup_failed",
]);
const TRUSTED_WINDOWS_POWERSHELL_ALIAS =
  "\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

interface BrowserDataLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

type WindowsChromeAppBoundImportErrorCode =
  | "chrome_cookie_elevation_cancelled"
  | "chrome_cookie_helper_verification_failed"
  | "chrome_cookie_app_bound_decryption_failed";

export class WindowsChromeAppBoundImportError extends Error {
  constructor(readonly code: WindowsChromeAppBoundImportErrorCode) {
    super(code);
    this.name = "WindowsChromeAppBoundImportError";
  }
}

function throwAppBoundDecryptionFailure(logger: BrowserDataLogger, reason: string): never {
  // The helper used to return stable sub-error codes; generic mappings lose the root cause. Log allowlisted
  logger.warn("[browser-data] Windows Chrome App-Bound helper returned failure", {
    reason: APP_BOUND_HELPER_FAILURE_REASONS.has(reason) ? reason : "invalid_response",
  });
  throw new WindowsChromeAppBoundImportError("chrome_cookie_app_bound_decryption_failed");
}

export type WindowsChromeAppBoundKeyReader = (options: {
  chromeExecutablePath: string;
  expectedAppVersion?: string;
  expectedBuildCommit?: string;
  logger: BrowserDataLogger;
  userDataDir: string;
}) => Promise<Buffer>;

interface HelperProcessResult {
  exitCode: number | null;
  stdout: string;
}

interface ReadAppBoundKeyOptions {
  appExecutablePath?: string;
  chromeExecutablePath: string;
  helperPath?: string;
  isPackaged?: boolean;
  logger: BrowserDataLogger;
  processArch?: string;
  resourcesPath?: string;
  runHelper?: (
    executablePath: string,
    args: string[],
    input?: string,
    beforeInput?: () => Promise<void>,
  ) => Promise<HelperProcessResult>;
  userDataDir: string;
  trustedPowerShellPath?: string;
  verifySignature?: (helperPath: string, appExecutablePath: string) => Promise<boolean | string>;
}

function toSafeProcessError(error: unknown): { code?: string; name: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name || "Error", ...(code ? { code } : {}) };
}

function getTargetKey(processArch: string = process.arch): string {
  if (processArch !== "x64" && processArch !== "arm64") {
    throw new WindowsChromeAppBoundImportError("chrome_cookie_helper_verification_failed");
  }
  return `win32-${processArch}`;
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function resolveHelperPath(options: ReadAppBoundKeyOptions): Promise<string> {
  if (options.helperPath) return resolve(options.helperPath);
  const targetKey = getTargetKey(options.processArch);
  if (options.isPackaged ?? isElectronAppPackaged()) {
    return join(options.resourcesPath ?? process.resourcesPath, "browser-import", HELPER_FILENAME);
  }

  const candidates = [
    join(process.cwd(), "bundled-tools", targetKey, "browser-import", HELPER_FILENAME),
    join(
      process.cwd(),
      "packages",
      "desktop",
      "bundled-tools",
      targetKey,
      "browser-import",
      HELPER_FILENAME,
    ),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return candidates[0]!;
}

function createSanitizedHelperEnvironment(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = [
    "COMSPEC",
    "LOCALAPPDATA",
    "PATH",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ];
  // Windows PowerShell needs PATHEXT even for full-path .exe invocation; without it the version handshake returns empty.
  // Allow .EXE only: trusted helper launch, no inheritance of injectable script extensions.
  const env: NodeJS.ProcessEnv = { PATHEXT: ".EXE" };
  for (const name of allowed) {
    const value = sourceEnv[name];
    if (value) env[name] = value;
  }
  return env;
}

function runHelperProcess(
  executablePath: string,
  args: string[],
  input?: string,
  beforeInput?: () => Promise<void>,
): Promise<HelperProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executablePath, args, {
      env: createSanitizedHelperEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finishReject(
        Object.assign(new Error("browser_import_helper_timeout"), { code: "ETIMEDOUT" }),
      );
    }, HELPER_TIMEOUT_MS);

    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const finishResolve = (result: HelperProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(result);
    };

    child.once("error", finishReject);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > HELPER_MAX_OUTPUT_BYTES) {
        child.kill();
        finishReject(new Error("browser_import_helper_output_too_large"));
        return;
      }
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.once("close", (exitCode) => {
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stdout = stdoutBuffer.toString("utf8").trim();
      stdoutBuffer.fill(0);
      for (const chunk of stdoutChunks) chunk.fill(0);
      finishResolve({
        exitCode,
        stdout,
      });
    });
    void (async () => {
      try {
        await beforeInput?.();
        if (!settled) child.stdin.end(input);
      } catch (error) {
        child.kill();
        finishReject(error);
      }
    })();
  });
}

async function hashHelperFile(helperPath: string): Promise<string> {
  const bytes = await readFile(helperPath);
  try {
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}

async function verifyAuthenticodePair(
  helperPath: string,
  appExecutablePath: string,
): Promise<string | false> {
  // SYSTEMROOT/WINDIR are launcher-overridable; not trust roots for release-signature verification.
  // GLOBALROOT\\SystemRoot is kernel-resolved to the real system dir, then to a CreateProcess DOS path.
  const powershellPath = await realpath(TRUSTED_WINDOWS_POWERSHELL_ALIAS);
  const script = [
    "$stream=[IO.File]::Open($zcodeArg0,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);",
    "try{",
    "$helper=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $zcodeArg0;",
    "$app=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $zcodeArg1;",
    "if($helper.Status -ne 'Valid' -or $app.Status -ne 'Valid'){throw 'invalid_signature'};",
    "if($null -eq $helper.SignerCertificate -or $null -eq $app.SignerCertificate){throw 'missing_signer'};",
    "if($helper.SignerCertificate.Thumbprint -ne $app.SignerCertificate.Thumbprint){throw 'signer_mismatch'};",
    "$sha=[Security.Cryptography.SHA256]::Create();",
    "try{$stream.Position=0;$hash=$sha.ComputeHash($stream);",
    "[Console]::Out.WriteLine(([BitConverter]::ToString($hash)).Replace('-','').ToLowerInvariant())}",
    "finally{$sha.Dispose()}",
    "}finally{$stream.Dispose()}",
  ].join("");
  // Windows PowerShell 5.1 -Command concatenates trailing argv and never fills $args;
  // a bare path argument would hand the signature check an empty path and fail closed. Encode script+args
  // and load Security from the invoking powershell.exe PSHOME, tolerating spaced paths and dirty PSModulePath.
  const result = await runHelperProcess(
    powershellPath,
    createWindowsPowerShellSecurityArgs(script, [helperPath, appExecutablePath]),
  );
  return result.exitCode === 0 && /^[0-9a-f]{64}$/.test(result.stdout) ? result.stdout : false;
}

async function runLockedPackagedHelper(options: {
  helperPath: string;
  input?: string;
  mode: "broker" | "version";
  runHelper: NonNullable<ReadAppBoundKeyOptions["runHelper"]>;
  trustedPowerShellPath?: string;
  verifiedHelperHash: string;
}): Promise<HelperProcessResult> {
  const powershellPath =
    options.trustedPowerShellPath ?? (await realpath(TRUSTED_WINDOWS_POWERSHELL_ALIAS));
  const hashMismatchResponse =
    options.mode === "broker"
      ? `[Console]::Out.WriteLine('${HELPER_PROTOCOL}\tERR\thelper_verification_failed');return`
      : "return";
  const invocation =
    options.mode === "broker"
      ? "$request=[Console]::In.ReadToEnd();$response=$request | & $zcodeArg0 --broker --parent-pid $zcodeArg2;"
      : "$response=& $zcodeArg0 --version;";
  const script = [
    "$stream=[IO.File]::Open($zcodeArg0,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);",
    "try{",
    "$sha=[Security.Cryptography.SHA256]::Create();",
    "try{$stream.Position=0;$hash=$sha.ComputeHash($stream);",
    "$digest=([BitConverter]::ToString($hash)).Replace('-','').ToLowerInvariant()}",
    "finally{$sha.Dispose()};",
    `if($digest -ne $zcodeArg1){${hashMismatchResponse}};`,
    invocation,
    "if($null -ne $response){[Console]::Out.WriteLine(($response -join [Environment]::NewLine))}",
    "}finally{$stream.Dispose()}",
  ].join("");
  // The trusted PowerShell holds no-write/no-delete handles for the helper lifetime; version handshake
  // and broker only ever run that one verified file -- no spawn-then-verify window.
  return options.runHelper(
    powershellPath,
    createEncodedPowerShellArgs(script, [
      options.helperPath,
      options.verifiedHelperHash,
      String(process.pid),
    ]),
    options.input,
  );
}

async function verifyHelper(helperPath: string, options: ReadAppBoundKeyOptions): Promise<string> {
  const packaged = options.isPackaged ?? isElectronAppPackaged();
  const expectedRoot = packaged
    ? join(options.resourcesPath ?? process.resourcesPath, "browser-import")
    : resolve(helperPath, "..");
  try {
    const [helperInfo, resolvedHelper, resolvedRoot] = await Promise.all([
      lstat(helperPath),
      realpath(helperPath),
      realpath(expectedRoot),
    ]);
    if (!helperInfo.isFile() || helperInfo.isSymbolicLink()) throw new Error("invalid_helper_file");
    const relativePath = relative(resolvedRoot, resolvedHelper);
    if (relativePath.startsWith("..") || relativePath.includes(":")) {
      throw new Error("helper_outside_trusted_root");
    }

    const verifiedHash = await hashHelperFile(helperPath);

    if (packaged) {
      const verifySignature = options.verifySignature ?? verifyAuthenticodePair;
      const signatureResult = await verifySignature(
        helperPath,
        options.appExecutablePath ?? process.execPath,
      );
      if (!signatureResult) {
        throw new Error("helper_signature_mismatch");
      }
      if (typeof signatureResult === "string" && signatureResult !== verifiedHash) {
        throw new Error("helper_signature_file_mismatch");
      }
      if ((await hashHelperFile(helperPath)) !== verifiedHash) {
        throw new Error("helper_changed_during_signature_verification");
      }
    }

    const runHelper = options.runHelper ?? runHelperProcess;
    const version = packaged
      ? await runLockedPackagedHelper({
          helperPath,
          mode: "version",
          runHelper,
          trustedPowerShellPath: options.trustedPowerShellPath,
          verifiedHelperHash: verifiedHash,
        })
      : await runHelper(helperPath, ["--version"]);
    const fields = version.stdout.split("\t");
    const expectedAppVersion = options.expectedAppVersion ?? ZCODE_VERSION;
    const expectedBuildCommit = options.expectedBuildCommit ?? ZCODE_COMMIT;
    if (
      version.exitCode !== 0 ||
      fields.length !== 5 ||
      fields[0] !== HELPER_VERSION_PROTOCOL ||
      fields[1] !== HELPER_VERSION ||
      fields[2] !== (options.processArch ?? process.arch) ||
      (packaged && (fields[3] !== expectedAppVersion || fields[4] !== expectedBuildCommit))
    ) {
      throw new Error("helper_version_or_arch_mismatch");
    }
    if ((await hashHelperFile(helperPath)) !== verifiedHash) {
      throw new Error("helper_changed_during_version_verification");
    }
    return verifiedHash;
  } catch (error) {
    options.logger.warn(
      "[browser-data] Windows Chrome App-Bound helper verification failed",
      toSafeProcessError(error),
    );
    throw new WindowsChromeAppBoundImportError("chrome_cookie_helper_verification_failed");
  }
}

function parseHelperResponse(response: HelperProcessResult, logger: BrowserDataLogger): Buffer {
  const fields = response.stdout.split("\t");
  if (fields.length !== 3 || fields[0] !== HELPER_PROTOCOL) {
    throwAppBoundDecryptionFailure(logger, "invalid_response");
  }
  if (fields[1] === "ERR") {
    if (fields[2] === "elevation_cancelled") {
      throw new WindowsChromeAppBoundImportError("chrome_cookie_elevation_cancelled");
    }
    if (fields[2] === "helper_verification_failed") {
      throw new WindowsChromeAppBoundImportError("chrome_cookie_helper_verification_failed");
    }
    throwAppBoundDecryptionFailure(logger, fields[2]!);
  }
  if (fields[1] !== "OK" || response.exitCode !== 0) {
    throwAppBoundDecryptionFailure(logger, "invalid_response");
  }
  const encodedKey = fields[2];
  if (!encodedKey) {
    throwAppBoundDecryptionFailure(logger, "invalid_response");
  }
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    key.fill(0);
    throwAppBoundDecryptionFailure(logger, "invalid_response");
  }
  return key;
}

export async function readWindowsChromeAppBoundKey(
  options: ReadAppBoundKeyOptions,
): Promise<Buffer> {
  const localState = JSON.parse(
    await readFile(join(options.userDataDir, "Local State"), "utf8"),
  ) as {
    os_crypt?: { app_bound_encrypted_key?: string };
  };
  const encodedKey = localState.os_crypt?.app_bound_encrypted_key;
  if (!encodedKey) {
    throw new WindowsChromeAppBoundImportError("chrome_cookie_app_bound_decryption_failed");
  }
  const appBoundKey = Buffer.from(encodedKey, "base64");
  if (appBoundKey.length <= 4 || appBoundKey.subarray(0, 4).toString("ascii") !== "APPB") {
    appBoundKey.fill(0);
    throw new WindowsChromeAppBoundImportError("chrome_cookie_app_bound_decryption_failed");
  }

  try {
    const helperPath = await resolveHelperPath(options);
    const verifiedHelperHash = await verifyHelper(helperPath, options);
    const encryptedKey = appBoundKey.subarray(4);
    const request = [
      HELPER_PROTOCOL,
      encryptedKey.toString("base64"),
      Buffer.from(options.chromeExecutablePath, "utf8").toString("base64"),
    ].join("\t");
    const runHelper = options.runHelper ?? runHelperProcess;
    const packaged = options.isPackaged ?? isElectronAppPackaged();
    const response = packaged
      ? await runLockedPackagedHelper({
          helperPath,
          input: `${request}\n`,
          mode: "broker",
          runHelper,
          trustedPowerShellPath: options.trustedPowerShellPath,
          verifiedHelperHash,
        })
      : await runHelper(
          helperPath,
          ["--broker", "--parent-pid", String(process.pid)],
          `${request}\n`,
          async () => {
            if ((await hashHelperFile(helperPath)) !== verifiedHelperHash) {
              throw new WindowsChromeAppBoundImportError(
                "chrome_cookie_helper_verification_failed",
              );
            }
          },
        );
    return parseHelperResponse(response, options.logger);
  } catch (error) {
    if (error instanceof WindowsChromeAppBoundImportError) throw error;
    options.logger.warn(
      "[browser-data] Windows Chrome App-Bound helper run failed",
      toSafeProcessError(error),
    );
    throw new WindowsChromeAppBoundImportError("chrome_cookie_app_bound_decryption_failed");
  } finally {
    // APPB ciphertext is not a plaintext key, but it should not linger in a reusable main-process buffer.
    appBoundKey.fill(0);
  }
}
