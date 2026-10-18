import { posix } from "node:path";

export interface RemoteCdnBaseOptions {
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
}

export function resolveRemoteCdnBaseUrls(options: RemoteCdnBaseOptions): string[] {
  const candidates = [...(options.remoteCdnBaseUrls ?? []), options.remoteCdnBaseUrl ?? ""]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(candidates));
}

export function buildReleaseBaseCandidates(remoteCdnBaseUrls: string[], version: string): string[] {
  const candidates = remoteCdnBaseUrls.flatMap((remoteCdnBaseUrl) => {
    const normalizedBase = remoteCdnBaseUrl.replace(/\/+$/, "");
    // When the caller already passed a versioned CDN base, blindly appending
    // `${base}/${version}` first walks a guaranteed-fail double-version path
    // (e.g. .../0.2.10/0.2.10) and adds pointless 404 noise. Detect the
    // already-pinned-to-current-version case and use the base as is.
    if (normalizedBase.endsWith(`/${version}`)) {
      return [normalizedBase];
    }
    return [`${normalizedBase}/${version}`, normalizedBase];
  });
  return Array.from(new Set(candidates));
}

export function buildReleaseAssetUrlCandidates(
  releaseBaseCandidates: string[],
  fileCandidates: string[],
): string[] {
  const urls: string[] = [];
  for (const fileCandidate of fileCandidates) {
    const normalizedFileCandidate = normalizeRemoteAssetRelativePath(
      fileCandidate,
      "release asset path",
    );
    for (const releaseBaseCandidate of releaseBaseCandidates) {
      urls.push(joinCdnUrl(releaseBaseCandidate, normalizedFileCandidate));
    }
  }
  return Array.from(new Set(urls));
}

export function buildArtifactUrlCandidates(
  remoteCdnBaseUrls: string[],
  artifactPath: string,
): string[] {
  const normalizedArtifactPath = normalizeRemoteAssetRelativePath(artifactPath, "artifactPath");
  const urls = remoteCdnBaseUrls.map((remoteCdnBaseUrl) =>
    joinCdnUrl(remoteCdnBaseUrl, normalizedArtifactPath),
  );
  return Array.from(new Set(urls));
}

export function buildComponentArtifactUrlCandidates(
  releaseBaseCandidates: string[],
  artifactPath: string,
  version: string,
): string[] {
  return buildArtifactUrlCandidates(
    buildComponentReleaseBaseCandidates(releaseBaseCandidates, version),
    artifactPath,
  );
}

export function buildComponentReleaseBaseCandidates(
  releaseBaseCandidates: string[],
  version: string,
): string[] {
  const candidates = releaseBaseCandidates.flatMap((releaseBaseCandidate) => {
    const normalizedBase = releaseBaseCandidate.replace(/\/+$/, "");
    if (normalizedBase.endsWith(`/${version}`)) {
      // CI today uploads component artifacts only to the cross-version
      // components root, so probe the parent release root first and save every
      // component a doomed hit on the retired versioned path.
      return [normalizedBase.slice(0, -version.length - 1), normalizedBase];
    }
    return [normalizedBase];
  });
  return Array.from(new Set(candidates.filter((candidate) => candidate.length > 0)));
}

export function normalizeRemoteAssetRelativePath(rawPath: string, label: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error(`[remote-assets] ${label} is empty`);
  }
  if (trimmed.includes("\\")) {
    throw new Error(`[remote-assets] ${label} must not contain backslash: ${rawPath}`);
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:/u.test(trimmed)) {
    throw new Error(`[remote-assets] ${label} must be relative path: ${rawPath}`);
  }

  const rawSegments = trimmed.split("/");
  if (rawSegments.some((segment) => segment.length === 0)) {
    throw new Error(`[remote-assets] ${label} contains empty path segment: ${rawPath}`);
  }
  if (rawSegments.includes("..")) {
    throw new Error(`[remote-assets] ${label} must not contain '..': ${rawPath}`);
  }
  if (rawSegments.includes(".")) {
    throw new Error(`[remote-assets] ${label} must not contain '.': ${rawPath}`);
  }

  const normalized = posix.normalize(trimmed);
  const normalizedSegments = normalized.split("/");
  if (
    normalizedSegments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`[remote-assets] ${label} is invalid after normalize: ${rawPath}`);
  }

  return normalizedSegments.join("/");
}

export function assertRemoteCdnBaseVersionMatches(
  remoteCdnBaseUrls: string[],
  expectedVersion: string,
): void {
  const mismatchedBases = remoteCdnBaseUrls.flatMap((remoteCdnBaseUrl) => {
    const pinnedVersion = extractPinnedReleaseVersionFromCdnBaseUrl(remoteCdnBaseUrl);
    if (!pinnedVersion || pinnedVersion === expectedVersion) {
      return [];
    }

    return [{ remoteCdnBaseUrl, pinnedVersion }];
  });
  if (mismatchedBases.length === 0) {
    return;
  }

  // Dev frequently overrides ZCODE_REMOTE_ASSET_CDN_BASE_URL for branch
  // testing. A base pinned to an old version (e.g. .../0.2.7) with a 0.2.10
  // client used to land old remote-assets in the new version's cache dir and
  // only fail at deploy with a bundle version mismatch. Validate the version
  // lock up front to avoid the misleading "downloaded ok, deployed broken" flow.
  throw new Error(
    `[remote-assets] remoteCdnBaseUrl version mismatch: app version is ${expectedVersion} but these bases are pinned elsewhere: ` +
      `${mismatchedBases.map(({ remoteCdnBaseUrl, pinnedVersion }) => `${pinnedVersion} (${remoteCdnBaseUrl})`).join(", ")}. ` +
      `Point ZCODE_REMOTE_ASSET_CDN_BASE_URL at the versionless release root or at the ${expectedVersion} dir.`,
  );
}

function joinCdnUrl(baseUrl: string, relativePath: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  // Component versions carry '+' (e.g. v1.3.0+abcd); naive concatenation 404s on
  // some CDNs. Encode per path segment so the object key matches the download URL (+ -> %2B).
  const encodedRelativePath = encodeRelativePathForUrl(relativePath);
  return `${normalizedBase}/${encodedRelativePath}`;
}

function encodeRelativePathForUrl(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) => encodePathSegment(segment))
    .join("/");
}

function encodePathSegment(segment: string): string {
  // Tolerate pre-encoded input: decode-then-encode so %2B is not re-encoded to %252B.
  // Fall back to plain encoding on malformed '%' sequences so this never throws.
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}

function extractPinnedReleaseVersionFromCdnBaseUrl(remoteCdnBaseUrl: string): string | null {
  const normalizedBase = remoteCdnBaseUrl.replace(/\/+$/, "");
  const parsedPathname = tryParseUrlPathname(normalizedBase);
  const pathname = parsedPathname ?? normalizedBase;
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const lastSegment = segments.at(-1);
  if (!lastSegment) {
    return null;
  }

  return isSemverLike(lastSegment) ? lastSegment : null;
}

function tryParseUrlPathname(urlOrPath: string): string | null {
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    return null;
  }
}

function isSemverLike(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}
