import { ZCODE_VERSION, type ZCodeEnv } from "@zcode/shared";

declare const __ZCODE_REMOTE_CDN_RELEASE_ROOTS__: readonly string[] | undefined;

const REMOTE_CDN_RELEASE_ROOTS = {
  domestic: "https://cdn.codegeex.cn/zcode/electron/releases",
  // Dev builds without CDN_DOMAIN injected must still use the current release domain, not the old one.
  overseas: "https://cdn-zcode.z.ai/zcode/electron/releases",
} as const;
const TEST_REMOTE_CDN_RELEASE_ROOT = "http://intranet.example.invalid:12345/ssh-remote-assets";

export interface ResolveRemoteCdnOptions {
  env?: ZCodeEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  version?: string;
  now?: Date;
}

function isChineseLocale(locale?: string | null): boolean {
  return locale?.trim().toLowerCase().startsWith("zh") ?? false;
}

function resolveLocalTimeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function isUtcPlusEightTimeZone(timeZone?: string | null, now: Date = new Date()): boolean {
  const normalizedTimeZone = timeZone?.trim();
  if (!normalizedTimeZone) {
    return false;
  }

  const offsetMinutes = resolveTimeZoneOffsetMinutes(normalizedTimeZone, now);
  return offsetMinutes === 8 * 60;
}

export function shouldPreferDomesticRemoteCdn(
  options: Pick<ResolveRemoteCdnOptions, "locale" | "timeZone" | "now">,
): boolean {
  const timeZone = options.timeZone ?? resolveLocalTimeZone();
  return isChineseLocale(options.locale) && isUtcPlusEightTimeZone(timeZone, options.now);
}

export function resolveRemoteCdnBaseUrls(options: ResolveRemoteCdnOptions = {}): string[] {
  const overrideBaseUrl = options.overrideBaseUrl?.trim();
  if (overrideBaseUrl) {
    return [normalizeBaseUrl(overrideBaseUrl)];
  }

  const orderedReleaseRoots = shouldPreferDomesticRemoteCdn(options)
    ? [REMOTE_CDN_RELEASE_ROOTS.domestic, REMOTE_CDN_RELEASE_ROOTS.overseas]
    : [REMOTE_CDN_RELEASE_ROOTS.overseas, REMOTE_CDN_RELEASE_ROOTS.domestic];
  const version = options.version ?? ZCODE_VERSION;

  if (options.env === "test") {
    return [`${TEST_REMOTE_CDN_RELEASE_ROOT}/${version}`];
  }

  const configuredReleaseRoots =
    typeof __ZCODE_REMOTE_CDN_RELEASE_ROOTS__ === "undefined"
      ? []
      : __ZCODE_REMOTE_CDN_RELEASE_ROOTS__;
  if (configuredReleaseRoots.length > 0) {
    // Bugfix: the remote runtime manifest/components download root must not hardcode the old CDN.
    // The ordered list is injected at build time from CI's CDN_DOMAIN/OSS_PATH_PREFIX; switching
    // means changing CI variables only.
    return configuredReleaseRoots.map(
      (releaseRoot) => `${normalizeBaseUrl(releaseRoot)}/${version}`,
    );
  }

  return orderedReleaseRoots.map((releaseRoot) => `${releaseRoot}/${version}`);
}

export function resolvePrimaryRemoteCdnBaseUrl(
  options: ResolveRemoteCdnOptions = {},
): string | undefined {
  return resolveRemoteCdnBaseUrls(options)[0];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function resolveTimeZoneOffsetMinutes(timeZone: string, now: Date): number | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(now);
    const values = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
    );
    const year = Number(values.year);
    const month = Number(values.month);
    const day = Number(values.day);
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    const second = Number(values.second);
    if ([year, month, day, hour, minute, second].some((value) => Number.isNaN(value))) {
      return null;
    }

    // Reverse the target timezone's formatted wall time back to UTC to get its true offset from
    // UTC; a whitelist of common Asian cities would misjudge UTC+8 zones with non-Chinese names.
    const targetUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const currentUtcMs = now.getTime();
    return Math.round((targetUtcMs - currentUtcMs) / 60_000);
  } catch {
    return null;
  }
}
