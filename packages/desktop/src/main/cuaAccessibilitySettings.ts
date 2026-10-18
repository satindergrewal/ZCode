/* eslint-disable max-lines -- installer verification, the main-level permission session and the drag TOCTOU guard jointly uphold one Helper identity */
// The grant flow triggers no macOS native permission dialog. Routing every TCC stage through
// LaunchServices to run the Helper in one-shot permission-request mode, hitting
// AXIsProcessTrustedWithOptions{prompt:true} / CGRequestScreenCaptureAccess in-process to
// "appear in the list automatically", costs an interrupting system dialog. We only open the
// matching settings pane; getting the Helper into the TCC list is done by the user dragging the
// .app in from the floating panel (in testing auth_value reads 2 right after the drag — one step
// fewer than the dialog, which merely creates the entry and still makes the user find and tick it).
// Each stage's verification fingerprint is no longer a final check before open(2); it is recorded
// on the session and consumed by the synchronous comparison before dragstart.
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { shell } from "electron";
import type { CuaHelperInstallerOptions } from "@zcode/services/node";
import {
  resolveHelperPermissionSubjectIdentity,
  type HelperPermissionSubjectIdentity,
} from "@zcode/services/cua-permission-broker";
import type {
  CuaAccessibilitySettingsResult,
  CuaPermissionKind,
  PrepareCuaHelperPermissionDragResult,
} from "@zcode/shared";
import { createDesktopCuaHelperInstaller } from "./desktopCuaHelperInstaller.js";

export const MACOS_ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
export const MACOS_SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export interface OpenCuaAccessibilitySettingsOptions {
  initialPermission?: CuaPermissionKind;
  requiredPermissions?: CuaPermissionKind[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  /** Renderer/webContents identity injected via main IPC; repeated joins from one host grant recovery once. */
  participantKey?: string;
  sessionTimeoutMs?: number;
  settingsReturnTimeoutMs?: number;
  logger?: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  ensureHelperInstalled?: () => Promise<string>;
  /** Test/host override; production resolves the bundled Helper from Electron Resources. */
  bundledHelperAppPath?: string;
  /** Re-run full install verification before each TCC stage; production defaults to installer.verifyInstalled. */
  verifyHelperInstalled?: (appPath: string) => Promise<void>;
  resolveHelperIdentity?: (appPath: string) => Promise<HelperPermissionSubjectIdentity>;
  openSettingsUrl?: (url: string) => Promise<void>;
  /**
   * Register the return signal before openSettings so a System Settings switch-away/return never lands in a listener gap.
   * The production IPC adapter listens on Electron app/browser-window; pure unit tests can run openSettings inline.
   */
  openSettingsAndWaitForReturn?: (options: {
    permission: CuaPermissionKind;
    sessionId: string;
    timeoutMs: number;
    signal: AbortSignal;
    openSettings: () => Promise<void>;
  }) => Promise<void>;
}

// Only the machine phase (did System Settings appear?) is wall-clock bounded; once the page is
// foreground, the user's checkbox is no longer timed -- it ends on surface cancel, origin destroyed, or app quit.
const DEFAULT_SETTINGS_RETURN_TIMEOUT_MS = 2 * 60_000;
// The legacy drag guide listed Screen Recording first, opposite of the on-screen permission order;
// when both are missing, handle Accessibility first, then Screen Recording.
const PERMISSION_STAGE_ORDER: readonly CuaPermissionKind[] = ["accessibility", "screen_recording"];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Drag TOCTOU gate: a .app verified during prepare can be overwritten by a same-UID attacker before
// the drag lands, and TCC binds the dragged bundle's identity. The drag moment needs synchronous
// bytes-unchanged-since-verify proof -- codesign over a 120MB bundle is too slow for the dragstart
// gesture. Use a light stat fingerprint: ino/ctime/size of key files (ctime = inode change time,
// not backdatable) -- any Mach-O/signature-manifest/Info.plist swap alters it. Snapshot at prepare,
// compare at dragstart, reject+reprepare on mismatch; the residual window is microseconds.
export type CuaHelperBundleFingerprint = string;

function statSignature(path: string): string {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.ino}:${st.ctimeNs}:${st.size}`;
  } catch {
    return "MISSING";
  }
}

function bundleTreeFingerprint(root: string, maxEntries = 512): string {
  const pending: Array<{ absolutePath: string; relativePath: string }> = [
    { absolutePath: root, relativePath: "." },
  ];
  const parts: string[] = [];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (parts.length >= maxEntries) return `${parts.join(",")},TOO_MANY`;
    parts.push(`${current.relativePath}:${statSignature(current.absolutePath)}`);
    let children: string[];
    try {
      children = readdirSync(current.absolutePath).sort();
    } catch {
      continue;
    }
    for (const child of children) {
      pending.push({
        absolutePath: join(current.absolutePath, child),
        relativePath: `${current.relativePath}/${child}`,
      });
    }
  }
  return parts.join(",");
}

export function captureCuaHelperBundleFingerprint(appPath: string): CuaHelperBundleFingerprint {
  const parts = [
    `app=${statSignature(appPath)}`,
    `sig=${statSignature(join(appPath, "Contents", "_CodeSignature", "CodeResources"))}`,
    `info=${statSignature(join(appPath, "Contents", "Info.plist"))}`,
    // ax_macos.node and the SEA-shipped runtime dylib both live in Resources. Statting only CodeResources
    // misses in-place resource overwrites; recursive inode/ctime/size catches them before dragstart.
    `resources=${bundleTreeFingerprint(join(appPath, "Contents", "Resources"))}`,
  ];
  try {
    const macosDir = join(appPath, "Contents", "MacOS");
    const entries = readdirSync(macosDir).sort();
    parts.push(
      `macos=${entries.map((entry) => `${entry}:${statSignature(join(macosDir, entry))}`).join(",")}`,
    );
  } catch {
    parts.push("macos=MISSING");
  }
  return parts.join("|");
}

export function cuaHelperBundleFingerprintUnchanged(
  appPath: string,
  fingerprint: CuaHelperBundleFingerprint,
): boolean {
  return captureCuaHelperBundleFingerprint(appPath) === fingerprint;
}

function normalizePermission(value: unknown): CuaPermissionKind {
  return value === "screen_recording" ? "screen_recording" : "accessibility";
}

function normalizeRequiredPermissions(
  options: OpenCuaAccessibilitySettingsOptions,
): CuaPermissionKind[] {
  const requested = Array.isArray(options.requiredPermissions)
    ? options.requiredPermissions
    : [normalizePermission(options.initialPermission)];
  const requestedSet = new Set(
    requested.filter(
      (permission): permission is CuaPermissionKind =>
        permission === "screen_recording" || permission === "accessibility",
    ),
  );
  return PERMISSION_STAGE_ORDER.filter((permission) => requestedSet.has(permission));
}

function settingsUrlForPermission(permission: CuaPermissionKind): string {
  return permission === "screen_recording"
    ? MACOS_SCREEN_RECORDING_SETTINGS_URL
    : MACOS_ACCESSIBILITY_SETTINGS_URL;
}

function sameHelperPermissionIdentity(
  expected: HelperPermissionSubjectIdentity,
  actual: HelperPermissionSubjectIdentity,
): boolean {
  return (
    expected.appPath === actual.appPath &&
    expected.executablePath === actual.executablePath &&
    expected.displayName === actual.displayName &&
    expected.bundleId === actual.bundleId
  );
}

async function verifyHelperPermissionIdentityUnchanged(
  identity: HelperPermissionSubjectIdentity,
  options: OpenCuaAccessibilitySettingsOptions,
  phase: "launch" | "post-settings",
): Promise<CuaHelperBundleFingerprint> {
  const fingerprint = captureCuaHelperBundleFingerprint(identity.appPath);
  await options.verifyHelperInstalled?.(identity.appPath);
  if (!cuaHelperBundleFingerprintUnchanged(identity.appPath, fingerprint)) {
    throw new Error(`ZCode Computer Use changed while its ${phase} signature was being verified`);
  }
  const currentIdentity = await (
    options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity
  )(identity.appPath);
  if (!sameHelperPermissionIdentity(identity, currentIdentity)) {
    throw new Error(`ZCode Computer Use permission identity changed during ${phase} verification`);
  }
  if (!cuaHelperBundleFingerprintUnchanged(identity.appPath, fingerprint)) {
    throw new Error(
      `ZCode Computer Use changed while its ${phase} permission identity was being resolved`,
    );
  }
  return fingerprint;
}

type CuaHelperInstallerLogger = NonNullable<CuaHelperInstallerOptions["logger"]>;

function toInstallerLogger(
  logger: OpenCuaAccessibilitySettingsOptions["logger"],
): CuaHelperInstallerLogger | undefined {
  if (!logger) return undefined;
  return {
    debug: (_traceId, ...args) => logger.debug?.(...args),
    info: (_traceId, ...args) => (logger.info ?? logger.warn)(...args),
    warn: (_traceId, ...args) => logger.warn(...args),
    error: (_traceId, ...args) => (logger.error ?? logger.warn)(...args),
  };
}

interface ActiveOnboardingSession {
  identity: HelperPermissionSubjectIdentity;
  sessionId: string;
  controller: AbortController;
  activeParticipants: Set<number>;
  requiredPermissions: Set<CuaPermissionKind>;
  processedPermissions: Set<CuaPermissionKind>;
  openedPermissions: CuaPermissionKind[];
  acceptingRequirements: boolean;
  recoveryOwnerParticipantKeys: Set<string>;
  /**
   * Per-stage verification fingerprint evidence, consumed by the synchronous pre-dragstart check
   * (the dragged bundle is what TCC binds).
   */
  launchFingerprint?: CuaHelperBundleFingerprint;
  promise?: Promise<CuaAccessibilitySettingsResult>;
}

/**
 * Main-process coordinator keyed by the Helper's exact authorized identity, not renderer/window/workspace:
 * TCC honors only that principal, and two concurrent native prompts for it steal focus and mid-state.
 */
class CuaPermissionOnboardingCoordinator {
  private readonly sessions = new Map<string, ActiveOnboardingSession>();
  private nextParticipantId = 0;

  constructor(private readonly createSessionId: () => string = randomUUID) {}

  run(
    identity: HelperPermissionSubjectIdentity,
    requiredPermissions: CuaPermissionKind[],
    options: OpenCuaAccessibilitySettingsOptions,
  ): Promise<CuaAccessibilitySettingsResult> {
    // bundle id + displayName are not the exact Helper identity: during dev/upgrade windows two
    // bundles with different paths/executables share both strings; merging sessions wrongly binds the
    // later window's grant to the first app. The key covers every immutable post-verify identity field.
    const identityKey = [
      identity.bundleId,
      identity.displayName,
      identity.appPath,
      identity.executablePath,
    ].join("\0");
    const existing = this.sessions.get(identityKey);
    if (existing?.promise) {
      if (existing.acceptingRequirements) {
        for (const permission of requiredPermissions) {
          existing.requiredPermissions.add(permission);
        }
        options.logger?.info?.(
          "[cua-permission-onboarding] joined active Helper permission session",
          existing.sessionId,
          identity.bundleId,
        );
        return this.joinSession(existing, options.signal, options.participantKey);
      }
      // The previous session went terminal but async cleanup of the exact-permission Helper still runs.
      // Retry only after the identity key is truly released; never overlap LaunchServices instances.
      return existing.promise.then(() => {
        if (options.signal?.aborted) {
          return this.canceledParticipantResult(existing, options.signal.reason);
        }
        return this.run(identity, requiredPermissions, options);
      });
    }

    const session: ActiveOnboardingSession = {
      identity,
      sessionId: this.createSessionId(),
      controller: new AbortController(),
      activeParticipants: new Set(),
      requiredPermissions: new Set(requiredPermissions),
      processedPermissions: new Set(),
      openedPermissions: [],
      acceptingRequirements: true,
      recoveryOwnerParticipantKeys: new Set(),
    };
    const promise = this.runSession(session, options).finally(() => {
      if (this.sessions.get(identityKey) === session) {
        this.sessions.delete(identityKey);
      }
    });
    session.promise = promise;
    this.sessions.set(identityKey, session);
    return this.joinSession(session, options.signal, options.participantKey);
  }

  private joinSession(
    session: ActiveOnboardingSession,
    signal?: AbortSignal,
    participantKey?: string,
  ): Promise<CuaAccessibilitySettingsResult> {
    this.nextParticipantId += 1;
    const participantId = this.nextParticipantId;
    const recoveryParticipantKey = participantKey?.trim() || `participant:${participantId}`;
    session.activeParticipants.add(participantId);

    return new Promise<CuaAccessibilitySettingsResult>((resolve) => {
      let active = true;
      const detach = () => {
        signal?.removeEventListener("abort", onAbort);
        session.activeParticipants.delete(participantId);
      };
      const onAbort = () => {
        if (!active) return;
        active = false;
        detach();
        resolve(this.canceledParticipantResult(session, signal?.reason));
        if (session.activeParticipants.size === 0 && !session.controller.signal.aborted) {
          // A shared session cannot be owned by the first caller's signal. Each window close removes
          // itself; only the last participant cancels the native flow, with the join gate closed first.
          session.acceptingRequirements = false;
          session.controller.abort(
            signal?.reason ?? new Error("all CUA permission onboarding windows closed"),
          );
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      void session.promise!.then((result) => {
        if (!active) return;
        active = false;
        detach();
        const returned =
          result.success === true &&
          result.returnedFromSettings === true &&
          typeof result.sessionId === "string";
        // Promise continuations run serially on the main loop; per renderer/webContents only one
        // call wins recovery. Different windows have separate hosts/Helpers -- never dedupe globally.
        const ownsRecovery =
          returned && !session.recoveryOwnerParticipantKeys.has(recoveryParticipantKey);
        if (ownsRecovery) session.recoveryOwnerParticipantKeys.add(recoveryParticipantKey);
        resolve({
          ...result,
          ...(returned ? { restartHelperAfterReturn: ownsRecovery } : {}),
        });
      });
    });
  }

  private canceledParticipantResult(
    session: ActiveOnboardingSession,
    reason: unknown,
  ): CuaAccessibilitySettingsResult {
    return {
      success: false,
      canceled: true,
      sessionId: session.sessionId,
      returnedFromSettings: false,
      error: `permission onboarding canceled: ${messageOf(
        reason ?? new Error("origin window closed"),
      )}`,
    };
  }

  private async runSession(
    session: ActiveOnboardingSession,
    options: OpenCuaAccessibilitySettingsOptions,
  ): Promise<CuaAccessibilitySettingsResult> {
    const configuredSessionTimeoutMs = options.sessionTimeoutMs;
    const sessionTimeoutMs =
      typeof configuredSessionTimeoutMs === "number" && Number.isFinite(configuredSessionTimeoutMs)
        ? Math.max(1, configuredSessionTimeoutMs)
        : null;
    const startedAt = Date.now();
    const controller = session.controller;
    const sessionTimer =
      sessionTimeoutMs === null
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                new Error(`CUA permission onboarding session exceeded ${sessionTimeoutMs}ms`),
              ),
            sessionTimeoutMs,
          );
    let returnedCount = 0;

    try {
      while (true) {
        const permission = PERMISSION_STAGE_ORDER.find(
          (candidate) =>
            session.requiredPermissions.has(candidate) &&
            !session.processedPermissions.has(candidate),
        );
        if (!permission) {
          // The identity recheck after the final page still awaits; a still-open join gate would silently
          // fold a new request into the finished loop with fake success. Close the gate synchronously.
          session.acceptingRequirements = false;
          break;
        }
        session.processedPermissions.add(permission);
        const remainingMs =
          sessionTimeoutMs === null
            ? Number.POSITIVE_INFINITY
            : sessionTimeoutMs - (Date.now() - startedAt);
        if (Number.isFinite(remainingMs) && remainingMs <= 0) {
          controller.abort(new Error("CUA permission onboarding session timed out"));
          throw controller.signal.reason;
        }
        // ensureInstalled verification evidence cannot stay trusted across the settings-page dwell: a
        // same-UID process can swap the install dir between stages. Re-establish per stage: snapshot ->
        // full verify -> exact-identity recheck -> snapshot; any change fails closed.
        //
        // Final pre-drag synchronous compare: TCC binds the dragged bundle, so bytes-unchanged at drag
        // time is the real risk window. The fingerprint is session-registered for the drag cache
        // (see desktopCuaPermissionIpc).
        session.launchFingerprint = await verifyHelperPermissionIdentityUnchanged(
          session.identity,
          options,
          "launch",
        );
        if (controller.signal.aborted) throw controller.signal.reason;

        const openSettingsUrl =
          options.openSettingsUrl ?? ((url: string) => shell.openExternal(url));
        const openSettings = async () => {
          await openSettingsUrl(settingsUrlForPermission(permission));
          if (!session.openedPermissions.includes(permission)) {
            session.openedPermissions.push(permission);
          }
        };
        const returnTimeoutMs = Math.min(
          options.settingsReturnTimeoutMs ?? DEFAULT_SETTINGS_RETURN_TIMEOUT_MS,
          sessionTimeoutMs === null
            ? Number.POSITIVE_INFINITY
            : Math.max(1, sessionTimeoutMs - (Date.now() - startedAt)),
        );
        if (options.openSettingsAndWaitForReturn) {
          await options.openSettingsAndWaitForReturn({
            permission,
            sessionId: session.sessionId,
            timeoutMs: returnTimeoutMs,
            signal: controller.signal,
            openSettings,
          });
          if (controller.signal.aborted) throw controller.signal.reason;
          returnedCount += 1;
        } else {
          // The legacy API has no main return signal: keep opening the settings page, never fake return=true.
          await openSettings();
          if (controller.signal.aborted) throw controller.signal.reason;
        }
      }

      // Helper upgrade/replacement can still happen between last-page return and restart. A background
      // drag-cache refresh is not grant evidence: re-verify and rebind the identity before success, else fail closed.
      if (session.openedPermissions.length > 0) {
        await verifyHelperPermissionIdentityUnchanged(session.identity, options, "post-settings");
        if (controller.signal.aborted) throw controller.signal.reason;
      }
      return {
        success: true,
        sessionId: session.sessionId,
        returnedFromSettings:
          session.openedPermissions.length > 0 &&
          returnedCount === session.openedPermissions.length,
        error: undefined,
      };
    } catch (error) {
      session.acceptingRequirements = false;
      return {
        success: false,
        canceled: controller.signal.aborted || undefined,
        sessionId: session.sessionId,
        returnedFromSettings: false,
        error: `permission onboarding failed: ${messageOf(error)}`,
      };
    } finally {
      if (sessionTimer) clearTimeout(sessionTimer);
    }
  }
}

const mainCuaPermissionOnboardingCoordinator = new CuaPermissionOnboardingCoordinator();

export async function openCuaPermissionOnboarding(
  options: OpenCuaAccessibilitySettingsOptions = {},
): Promise<CuaAccessibilitySettingsResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      success: false,
      error: "ZCode Computer Use permissions are only available on macOS.",
    };
  }
  const env = options.env ?? process.env;
  const defaultInstaller = options.ensureHelperInstalled
    ? null
    : createDesktopCuaHelperInstaller({
        logger: toInstallerLogger(options.logger),
        env,
        bundledHelperAppPath: options.bundledHelperAppPath,
        platform,
      });
  let helperAppPath: string;
  try {
    helperAppPath = await (options.ensureHelperInstalled ?? defaultInstaller!.ensureInstalled)();
  } catch (error) {
    // Security boundary: on install/verify failure
    // fail closed -- never fall back to an unverified exists-on-path Helper, or users would grant
    // Accessibility/Screen Recording to an old/badly-signed/wrong-Team/replaced bundle, breaking the
    // invariant that the Helper is an independent TeamIdentifier-pinned principal. Dev is handled
    // inside the installer via ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: when dev verification passes,
    // ensureInstalled returns the local app and never reaches this catch; only real failures do.
    return {
      success: false,
      error: `ZCode Computer Use is unavailable (install/verification failed): ${messageOf(error)}`,
    };
  }

  let identity: HelperPermissionSubjectIdentity;
  try {
    identity = await (options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity)(
      helperAppPath,
    );
  } catch (error) {
    return {
      success: false,
      returnedFromSettings: false,
      error: `ZCode Computer Use permission identity verification failed: ${messageOf(error)}`,
    };
  }
  const verifiedOptions: OpenCuaAccessibilitySettingsOptions = {
    ...options,
    ...(options.verifyHelperInstalled
      ? { verifyHelperInstalled: options.verifyHelperInstalled }
      : defaultInstaller
        ? { verifyHelperInstalled: defaultInstaller.verifyInstalled }
        : {}),
  };
  return mainCuaPermissionOnboardingCoordinator.run(
    identity,
    normalizeRequiredPermissions(options),
    verifiedOptions,
  );
}

// The 2026-08 audit removed the drag flow as dead code (no renderer callers; the native prompt let the
// Helper self-register). With the prompt gone, dragging is again the only route into the TCC list, so it
// is restored. openCuaAccessibilitySettings (legacy confirm-dialog channel) stays removed, superseded by onboarding.

export interface PrepareCuaHelperPermissionDragOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  logger?: OpenCuaAccessibilitySettingsOptions["logger"];
  /** Shared with onboarding via the desktop installer factory install+verify. Injectable in tests. */
  ensureHelperInstalled?: () => Promise<string>;
  bundledHelperAppPath?: string;
  verifyHelperInstalled?: (appPath: string) => Promise<void>;
  resolveHelperIdentity?: (appPath: string) => Promise<HelperPermissionSubjectIdentity>;
}

export interface PrepareCuaHelperPermissionDragMainResult extends PrepareCuaHelperPermissionDragResult {
  /**
   * Synchronous bundle fingerprint bound across this full verify. Main-memory cache only -- the IPC handler
   * must strip it before returning to the renderer (useless cross-process, widens the attack surface).
   */
  helperBundleFingerprint?: CuaHelperBundleFingerprint;
}

// Drag grant and onboarding end at the same TCC principal, so the security checks must match: a .app
// replaced on disk by an old/badly-signed/wrong-Team/same-user-writable copy would grant the wrong
// principal if dragged into Accessibility/Screen Recording, defeating TeamIdentifier pinning. Drags
// therefore run the same install+verify (bundle id/version/arch/codesign/TeamIdentifier/Gatekeeper).
//
// But Electron native drag requires event.sender.startDrag() synchronously inside the dragstart chain --
// no time for this async I/O or the OS gesture is missed. So install+verify is split out: the panel
// prewarms path+fingerprint at mount; dragstart reads the cache and compares synchronously.
// desktopCuaPermissionIpc）。
export async function prepareCuaHelperPermissionDrag(
  options: PrepareCuaHelperPermissionDragOptions = {},
): Promise<PrepareCuaHelperPermissionDragMainResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      success: false,
      error: "ZCode Computer Use permissions are only available on macOS.",
    };
  }
  const env = options.env ?? process.env;
  const defaultInstaller = options.ensureHelperInstalled
    ? null
    : createDesktopCuaHelperInstaller({
        logger: toInstallerLogger(options.logger),
        env,
        bundledHelperAppPath: options.bundledHelperAppPath,
        platform,
      });
  try {
    const helperAppPath = await (
      options.ensureHelperInstalled ?? defaultInstaller!.ensureInstalled
    )();
    // Order matters: snapshot, full verify, recheck after verify and after the identity read. A fingerprint
    // taken after ensure/verify return lets an attacker swap the .app in between and bless malicious
    // bytes as the verified fingerprint; only fully unchanged bytes reach the dragstart cache.
    const verifiedFingerprint = captureCuaHelperBundleFingerprint(helperAppPath);
    await (options.verifyHelperInstalled ?? defaultInstaller?.verifyInstalled)?.(helperAppPath);
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, verifiedFingerprint)) {
      throw new Error("ZCode Computer Use changed while its drag signature was being verified");
    }
    const identity = await (
      options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity
    )(helperAppPath);
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, verifiedFingerprint)) {
      throw new Error("ZCode Computer Use changed while its drag identity was being resolved");
    }
    return {
      success: true,
      helperAppPath,
      helperDisplayName: identity.displayName,
      helperBundleId: identity.bundleId,
      helperBundleFingerprint: verifiedFingerprint,
    };
  } catch (error) {
    const message = messageOf(error);
    options.logger?.warn(
      "[cua-permission-onboarding] helper install/verify failed; refusing to prepare drag of an unverified Helper",
      message,
    );
    return { success: false, error: message };
  }
}
