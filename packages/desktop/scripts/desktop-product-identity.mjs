/**
 * Build-time flag: when true the installer uses Preview identity while the backend env stays governed by `ZCODE_ENV`.
 * Typical usage `ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1` yields a `ZCode Preview` that talks to the production
 * backend and installs side by side with the stable build.
 */
export const ZCODE_PREVIEW_IDENTITY_ENV = "ZCODE_PREVIEW_IDENTITY";

const PRODUCTION_IDENTITY = Object.freeze({
  flavor: "production",
  appId: "dev.zcode.app",
  productName: "ZCode",
  linuxExecutableName: "zcode",
  linuxPackageName: "zcode",
  cuaHelperInstallVariant: null,
});

const PREVIEW_IDENTITY = Object.freeze({
  flavor: "preview",
  appId: "dev.zcode.app.preview",
  productName: "ZCode Preview",
  linuxExecutableName: "zcode-preview",
  linuxPackageName: "zcode-preview",
  cuaHelperInstallVariant: "preview",
});

export const desktopProductIdentities = Object.freeze({
  production: PRODUCTION_IDENTITY,
  preview: PREVIEW_IDENTITY,
});

function normalizeDesktopZCodeEnv(env) {
  return env.ZCODE_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
}

/**
 * The flag has exactly one on-spelling `1` (`0`/empty = off), matching the CI workflow rule and release gate's
 * exact `$ZCODE_PREVIEW_IDENTITY == "1"` comparison. Any other spelling fails at build time so values like `true`
 * cannot slip through YAML routing yet count as on here, landing Preview packages in the production acceptance dir.
 */
export function isPreviewIdentityRequested(env = process.env) {
  const value = env[ZCODE_PREVIEW_IDENTITY_ENV]?.trim() ?? "";
  if (value === "1") {
    return true;
  }
  if (value === "" || value === "0") {
    return false;
  }
  throw new Error(
    `invalid ${ZCODE_PREVIEW_IDENTITY_ENV}=${env[ZCODE_PREVIEW_IDENTITY_ENV]}; expected 1 or 0`,
  );
}

/**
 * Product flavor and backend env (`ZCODE_ENV`) are independent axes:
 * - `ZCODE_ENV=test` is always Preview; the test backend must not overwrite the user's stable install under the stable `ZCode` identity.
 * - `ZCODE_ENV=production` defaults to stable; explicit `ZCODE_PREVIEW_IDENTITY=1` switches to Preview.
 * Unknown `ZCODE_ENV` is treated as test, matching the shared normalizeZCodeEnv fail-safe default.
 */
export function resolveDesktopProductFlavor(env = process.env) {
  if (isPreviewIdentityRequested(env)) {
    return "preview";
  }
  return normalizeDesktopZCodeEnv(env) === "production" ? "production" : "preview";
}

export function resolveDesktopProductIdentity(env = process.env) {
  return desktopProductIdentities[resolveDesktopProductFlavor(env)];
}

/**
 * The artifact filename suffix marks the backend env, not the identity: `_TEST` appears only on test-backend installers.
 * Production-backend Preview packages are distinguished by productName (`ZCode Preview-<version>-...`).
 */
export function resolveDesktopArtifactSuffix(env = process.env) {
  return normalizeDesktopZCodeEnv(env) === "test" ? "_TEST" : "";
}

/**
 * Returns the AppUserModelId used by the Windows shell.
 *
 * Packaged builds must reuse electron-builder's appId, or the shortcut AUMID, Start Menu index, and the running
 * Electron process are seen by Windows as three different apps. Dev keeps the legacy identity so local debug shortcuts
 * never pollute stable/Preview installs (and vice versa).
 */
export function resolveWindowsAppUserModelIdForFlavor(flavor, runtime = { isPackaged: true }) {
  if (runtime.isPackaged === false) {
    return "cn.aminer.zcode";
  }
  return desktopProductIdentities[flavor === "preview" ? "preview" : "production"].appId;
}

export function resolveWindowsAppUserModelId(env = process.env, runtime = { isPackaged: true }) {
  return resolveWindowsAppUserModelIdForFlavor(resolveDesktopProductFlavor(env), runtime);
}
