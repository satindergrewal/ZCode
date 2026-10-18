function parseVersion(version) {
  const match =
    typeof version === "string" &&
    version.match(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
    );
  const prerelease = match && match[4] ? match[4].split(".") : [];
  if (!match || match[0] !== version || prerelease.some((part) => /^0\d+$/.test(part))) {
    throw new Error("Expected a package version such as 3.12.2");
  }
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

/** Version resolution shared by build and release; copied into Docker with packages/web so it never needs root scripts. */
export function resolveRemoteFrontendVersion(packageVersion, override) {
  const version = override?.trim() || packageVersion;
  parseVersion(version);
  return version;
}

/** SemVer precedence: numeric per-segment core compare, releases above prereleases, build metadata ignored. */
export function compareRemoteFrontendVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  for (let index = 0; index < 3; index += 1) {
    const order = compare(left.core[index], right.core[index]);
    if (order) return order;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length ? -1 : right.prerelease.length ? 1 : 0;
  }
  for (
    let index = 0;
    index < Math.min(left.prerelease.length, right.prerelease.length);
    index += 1
  ) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    const order =
      numericA && numericB
        ? compare(BigInt(a), BigInt(b))
        : numericA !== numericB
          ? numericA
            ? -1
            : 1
          : compare(a, b);
    if (order) return order;
  }
  return compare(left.prerelease.length, right.prerelease.length);
}
