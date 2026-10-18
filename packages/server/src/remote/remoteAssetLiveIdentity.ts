import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ZCODE_VERSION } from "@zcode/shared";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import type { RemoteEnvironment } from "@zcode/server/remote/backend.js";
import {
  REMOTE_BASE,
  type DeployLoggers,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import {
  buildWriteLiteralFileCommand,
  quotePosixPathArg,
} from "@zcode/server/remote/posixShell.js";
import {
  fetchRemoteAssetManifestRefFromCdn,
  type RemoteAssetManifest,
  type RemoteAssetManifestRef,
} from "@zcode/server/remote/remoteAssetCache.js";
import {
  buildReleaseBaseCandidates,
  resolveRemoteCdnBaseUrls,
} from "@zcode/server/remote/remoteAssetCdn.js";
import type { RemoteAssetNetworkPort } from "@zcode/server/remote/remoteAssetNetwork.js";

const REMOTE_ASSET_COMPONENT_META_DIR = `${REMOTE_BASE}/.asset-components`;

export interface RemoteAssetIdentityResolverOptions {
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  manifestRequestTimeoutMs?: number;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}

export function createFreshRemoteAssetManifestRefResolver(
  options: RemoteAssetIdentityResolverOptions,
  env: RemoteEnvironment,
  loggers: DeployLoggers,
): () => Promise<RemoteAssetManifestRef | null> {
  let manifestPromise: Promise<RemoteAssetManifestRef | null> | null = null;
  return () => {
    manifestPromise ??= resolveFreshComponentManifest(options, env, loggers);
    return manifestPromise;
  };
}

export interface RemoteAssetComponentIdentity {
  sha256: string;
}

export interface RemoteAssetComponentMeta {
  id: string;
  version?: string;
  sha256?: string;
  pendingRefreshAppVersion?: string;
  platformArch: string;
}

export type RemoteAssetComponentIdentityDecision =
  | { shouldDeploy: false }
  | { shouldDeploy: true; reason: string };

export async function checkRemoteAssetComponentIdentity(
  backend: IRemoteBackend,
  options: {
    componentId: string;
    platformArch: string;
    expectedIdentity: RemoteAssetComponentIdentity;
  },
): Promise<RemoteAssetComponentIdentityDecision> {
  const remoteMeta = await readRemoteAssetComponentMeta(backend, options.componentId);
  if (!remoteMeta) {
    return {
      shouldDeploy: true,
      reason: `remote component meta missing expected=${formatIdentity(options.expectedIdentity)}`,
    };
  }
  if (remoteMeta.id !== options.componentId) {
    return {
      shouldDeploy: true,
      reason: `remote component id mismatch remote=${remoteMeta.id} expected=${options.componentId}`,
    };
  }
  if (remoteMeta.platformArch !== options.platformArch) {
    return {
      shouldDeploy: true,
      reason: `remote platform mismatch remote=${remoteMeta.platformArch} expected=${options.platformArch}`,
    };
  }
  if (!remoteMeta.sha256) {
    // The legacy live marker records the version only and cannot prove the live
    // dir came from the current manifest artifact. On first read of a legacy
    // marker, redeploy and write the SHA instead of skipping by semver.
    return {
      shouldDeploy: true,
      reason: `remote component SHA missing expected=${options.expectedIdentity.sha256}`,
    };
  }
  if (
    remoteMeta.sha256.trim().toLowerCase() !== options.expectedIdentity.sha256.trim().toLowerCase()
  ) {
    return {
      shouldDeploy: true,
      reason: `remote SHA mismatch remote=${remoteMeta.sha256} expected=${options.expectedIdentity.sha256}`,
    };
  }

  return { shouldDeploy: false };
}

export async function readRemoteAssetComponentMeta(
  backend: IRemoteBackend,
  componentId: string,
): Promise<RemoteAssetComponentMeta | null> {
  try {
    const content = await backend.readFile(buildRemoteAssetComponentMetaPath(componentId));
    const parsed = JSON.parse(content) as Partial<RemoteAssetComponentMeta>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.platformArch !== "string" ||
      (parsed.version !== undefined && typeof parsed.version !== "string") ||
      (parsed.sha256 !== undefined && typeof parsed.sha256 !== "string") ||
      (parsed.pendingRefreshAppVersion !== undefined &&
        typeof parsed.pendingRefreshAppVersion !== "string")
    ) {
      return null;
    }
    return {
      id: parsed.id,
      ...(parsed.version ? { version: parsed.version } : {}),
      ...(parsed.sha256 ? { sha256: parsed.sha256 } : {}),
      ...(parsed.pendingRefreshAppVersion
        ? { pendingRefreshAppVersion: parsed.pendingRefreshAppVersion }
        : {}),
      platformArch: parsed.platformArch,
    };
  } catch {
    return null;
  }
}

export async function writeRemoteAssetComponentMeta(
  backend: IRemoteBackend,
  meta: RemoteAssetComponentMeta,
): Promise<void> {
  // Other resource packages keep the legacy semantics: with an unresolvable version, write no unknown marker that would mismatch forever.
  if (meta.version === "unknown" && !meta.sha256) {
    return;
  }
  const stream = await backend.exec(
    [
      `mkdir -p ${quotePosixPathArg(REMOTE_ASSET_COMPONENT_META_DIR)}`,
      buildWriteLiteralFileCommand(
        buildRemoteAssetComponentMetaPath(meta.id),
        `${JSON.stringify(meta)}\n`,
      ),
    ].join(" && "),
  );
  await waitForClose(stream);
}

export async function markRemoteAssetComponentRefreshPending(
  backend: IRemoteBackend,
  options: {
    componentId: string;
    platformArch: string;
    appVersion: string;
  },
): Promise<void> {
  await writeRemoteAssetComponentMeta(backend, {
    id: options.componentId,
    platformArch: options.platformArch,
    pendingRefreshAppVersion: options.appVersion,
  });
}

export async function hasRemoteAssetComponentRefreshPending(
  backend: IRemoteBackend,
  options: { componentId: string; platformArch: string },
): Promise<boolean> {
  const meta = await readRemoteAssetComponentMeta(backend, options.componentId);
  return Boolean(
    meta &&
    meta.id === options.componentId &&
    meta.platformArch === options.platformArch &&
    meta.pendingRefreshAppVersion,
  );
}

function buildRemoteAssetComponentMetaPath(componentId: string): string {
  return `${REMOTE_ASSET_COMPONENT_META_DIR}/${componentId}.json`;
}

function formatIdentity(identity: RemoteAssetComponentIdentity): string {
  return identity.sha256;
}

async function resolveFreshComponentManifest(
  options: RemoteAssetIdentityResolverOptions,
  env: RemoteEnvironment,
  loggers: DeployLoggers,
): Promise<RemoteAssetManifestRef | null> {
  const platformArch = `${env.platform}-${env.arch}`;
  if (options.mockCdnDir) {
    try {
      const content = await readFile(
        join(options.mockCdnDir, "releases", ZCODE_VERSION, `manifest-${platformArch}.json`),
        "utf8",
      );
      return {
        manifest: JSON.parse(content) as RemoteAssetManifest,
        releaseBaseCandidatesForComponents: buildReleaseBaseCandidates(
          resolveRemoteCdnBaseUrls(options),
          ZCODE_VERSION,
        ),
      };
    } catch (error) {
      loggers.logWarn(
        `[remote-assets] mock component manifest unavailable, fallback to release checks: ${String(error)}`,
      );
      return null;
    }
  }

  try {
    const manifestRef = await fetchRemoteAssetManifestRefFromCdn(
      {
        remoteCdnBaseUrl: options.remoteCdnBaseUrl,
        remoteCdnBaseUrls: options.remoteCdnBaseUrls,
        remoteCacheDir: options.remoteCacheDir,
        version: ZCODE_VERSION,
        platformArch,
        manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
        remoteAssetNetwork: options.remoteAssetNetwork,
        // server-bundle/GLM allow re-published artifacts at the same app/version;
        // every deploy must re-fetch the manifest rather than reuse the in-process
        // SHA. The promise keeps this to one refresh per deploy.
        refreshManifest: true,
      },
      loggers,
    );
    const hasConfiguredManifestSource =
      Boolean(options.remoteCacheDir?.trim()) &&
      (Boolean(options.remoteCdnBaseUrl?.trim()) ||
        Boolean(options.remoteCdnBaseUrls?.some((baseUrl) => baseUrl.trim().length > 0)));
    if (!manifestRef && hasConfiguredManifestSource) {
      // server-bundle identity check and install must come from one manifest;
      // after a 404, do not let the installer request again or a publish
      // switchover could deploy a different artifact.
      throw new Error(
        `[remote-assets] manifest not found for ${platformArch}: manifest-${platformArch}.json`,
      );
    }
    return manifestRef;
  } catch (error) {
    loggers.logWarn(`[remote-assets] component manifest request failed: ${String(error)}`);
    // This is the pinned-identity input for content-addressed components in this
    // deploy transaction. On network timeout/parse failure do not degrade to
    // "manifest missing" and retry; that would drop the original diagnostics and
    // double the deadline.
    throw error;
  }
}
