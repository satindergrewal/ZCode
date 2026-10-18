import type { ApplicationIconRequest } from "@zcode/shared";

/**
 * Maps a producer appKey to a platform icon locator.
 *
 * appKey comes from zcode-cua deriveApplicationKey as `<scheme>:<value>`:
 * `darwin:<bundleId>` (lowercase), `windows-aumid:<aumid>`, `windows-exe:<canonical path>`,
 * `linux-exe:<path>`. The session protocol carries only the string; platform services fetch icon bytes live.
 *
 * Linux has no ApplicationIconLocator kind and desktop has no resolver; return null so callers
 * fall back to their generic icon.
 */
const APP_KEY_LOCATOR_KINDS = {
  darwin: "darwin-bundle-id",
  "windows-aumid": "windows-aumid",
  "windows-exe": "windows-executable-path",
} as const satisfies Record<string, ApplicationIconRequest["locators"][number]["kind"]>;

export function cuaAppKeyToIconRequest(
  appKey: string | undefined | null,
): ApplicationIconRequest | null {
  if (!appKey) return null;
  // Split on the first colon only: Windows exe paths carry drive colons and a global split cuts c:\... to c.
  const separator = appKey.indexOf(":");
  if (separator <= 0) return null;
  const scheme = appKey.slice(0, separator);
  const value = appKey.slice(separator + 1).trim();
  if (!value) return null;
  const kind = (APP_KEY_LOCATOR_KINDS as Record<string, string | undefined>)[scheme];
  if (!kind) return null;
  return { locators: [{ kind, value } as ApplicationIconRequest["locators"][number]] };
}
