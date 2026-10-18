import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createEncodedPowerShellArgs } from "../../scripts/powershell-command.mjs";

const SYSTEM_CREDENTIAL_TIMEOUT_MS = 15_000;
// macOS security folds OSStatus into an 8-bit process exit code:
// errSecInteractionNotAllowed(-25308) -> 36、errSecAuthFailed(-25293) -> 51、
// errSecUserCanceled(-128) -> 128. All three mean this user grant never completed.
const MAC_KEYCHAIN_ACCESS_DENIED_EXIT_CODES = new Set([36, 51, 128]);

export type MacChromeSafeStorageSecretReader = () => Promise<string>;

export class ChromeCookieAccessDeniedError extends Error {
  readonly code = "chrome_cookie_access_denied";

  constructor() {
    super("chrome_cookie_access_denied");
    this.name = "ChromeCookieAccessDeniedError";
  }
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        // The system credential dialog can be buried or ignored; never block the import forever.
        timeout: SYSTEM_CREDENTIAL_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function isMacKeychainAccessDenied(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = error.code;
  return typeof code === "number" && MAC_KEYCHAIN_ACCESS_DENIED_EXIT_CODES.has(code);
}

export async function readMacChromeSafeStorageSecret(
  secretReader: MacChromeSafeStorageSecretReader = () =>
    execFileText("security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage"]),
): Promise<string> {
  try {
    // Secrets are consumed in main memory only; keep them out of logs and IPC payloads.
    return await secretReader();
  } catch (error) {
    // A denied/cancelled keychain grant terminates the whole import -- not a per-cookie
    // failure to swallow, or the upper layer keeps writing LocalStorage against the user's choice.
    if (isMacKeychainAccessDenied(error)) throw new ChromeCookieAccessDeniedError();
    throw error;
  }
}

export async function readWindowsChromeMasterKey(userDataDir: string): Promise<Buffer> {
  const localState = JSON.parse(await readFile(join(userDataDir, "Local State"), "utf8")) as {
    os_crypt?: { encrypted_key?: string };
  };
  const encryptedKey = localState.os_crypt?.encrypted_key;
  if (!encryptedKey) throw new Error("chrome_master_key_missing");
  const script = [
    "Add-Type -AssemblyName System.Security;",
    "$data=[Convert]::FromBase64String($zcodeArg0);",
    "if ([Text.Encoding]::ASCII.GetString($data,0,5) -eq 'DPAPI') {$data=$data[5..($data.Length-1)]};",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Convert]::ToBase64String($plain)",
  ].join("");
  // A plain -Command does not inject the trailing encryptedKey into $args; the Windows import gets empty params.
  // Pass values via EncodedCommand: no second shell parse, DPAPI ciphertext boundaries intact.
  const output = await execFileText(
    "powershell.exe",
    createEncodedPowerShellArgs(script, [encryptedKey]),
  );
  return Buffer.from(output, "base64");
}
