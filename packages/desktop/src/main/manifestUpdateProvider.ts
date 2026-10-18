import { posix } from "node:path";
import type { CustomPublishOptions, PackageFileInfo } from "builder-util-runtime";
import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  normalizeZCodeEndpointOrigin,
  type ElectronReleaseChannel,
} from "@zcode/shared";
import {
  Provider,
  AppImageUpdater,
  DebUpdater,
  RpmUpdater,
  PacmanUpdater,
  type AppUpdater,
  type ResolvedUpdateFileInfo,
  type UpdateFileInfo,
  type UpdateInfo,
} from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import { parse as parseYaml } from "yaml";

const ELECTRON_MANIFEST_API_PATH = "/api/v1/releases/electron/manifest";

const MANIFEST_ACCEPT_HEADER = "application/x-yaml,text/yaml,text/plain,*/*";

interface ManifestUpdateProviderOptions extends CustomPublishOptions {
  endpointOrigin?: string;
  manifestUrl?: string;
  deviceMid?: string;
  releasePlatform?: string;
  releaseChannel?: ElectronReleaseChannel;
  resolveEndpointOrigin?: () => string | Promise<string>;
  resolveReleaseChannel?: () => ElectronReleaseChannel | Promise<ElectronReleaseChannel>;
}

function normalizeReleaseChannel(channel: string | null | undefined): ElectronReleaseChannel {
  return channel === "preview" ? "preview" : "stable";
}

function mapReleaseChannelToApiValue(channel: ElectronReleaseChannel): string {
  return channel === "preview" ? "3" : "1";
}

function mapElectronReleaseArch(arch: string): string {
  switch (arch) {
    case "arm64":
      return "aarch64";
    case "x64":
      return "x86_64";
    case "ia32":
      return "x86";
    default:
      return arch;
  }
}

function mapElectronReleasePlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      return platform;
  }
}

export function getElectronReleasePlatform(
  platform: NodeJS.Platform = process.platform,
  arch = process.env["TEST_UPDATER_ARCH"] || process.arch,
): string {
  return `${mapElectronReleasePlatform(platform)}-${mapElectronReleaseArch(arch)}`;
}

function buildElectronManifestUrl(options: {
  endpointOrigin: string;
  manifestUrl?: string;
  platform: string;
  deviceMid?: string;
  channel: ElectronReleaseChannel;
}): URL {
  const url = options.manifestUrl?.trim()
    ? new URL(options.manifestUrl.trim())
    : new URL(ELECTRON_MANIFEST_API_PATH, normalizeZCodeEndpointOrigin(options.endpointOrigin));
  url.searchParams.set("platform", options.platform);
  if (options.deviceMid?.trim()) {
    url.searchParams.set("device_mid", options.deviceMid.trim());
  }
  url.searchParams.set("channel", mapReleaseChannelToApiValue(options.channel));
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readManifestFileList(updateInfo: UpdateInfo): UpdateFileInfo[] {
  if (Array.isArray(updateInfo.files) && updateInfo.files.length > 0) {
    return updateInfo.files;
  }

  const legacyInfo = updateInfo as UpdateInfo & {
    path?: unknown;
    sha2?: unknown;
    sha512?: unknown;
  };
  if (typeof legacyInfo.path === "string") {
    return [
      {
        url: legacyInfo.path,
        ...(typeof legacyInfo.sha2 === "string" ? { sha2: legacyInfo.sha2 } : {}),
        ...(typeof legacyInfo.sha512 === "string" ? { sha512: legacyInfo.sha512 } : {}),
      } as UpdateFileInfo,
    ];
  }

  throw new Error("Manifest update info does not contain files or path");
}

function resolveManifestUrl(pathname: string, baseUrl: URL): URL {
  return new URL(pathname, baseUrl);
}

function getLinuxUpdateExtensions(updater: AppUpdater): readonly string[] | null {
  // The Linux updater depends on the package type; never treat deb/rpm/pacman as one
  // no-update artifact and delete it; reuse the existing updater so install-type reads cannot diverge.
  if (updater instanceof AppImageUpdater) return [".appimage"];
  if (updater instanceof DebUpdater) return [".deb"];
  if (updater instanceof RpmUpdater) return [".rpm"];
  if (updater instanceof PacmanUpdater) return [".pkg.tar.zst", ".pacman"];
  return null;
}

function resolveManifestFiles(
  updateInfo: UpdateInfo,
  baseUrl: URL,
  linuxExtensions: readonly string[] | null,
): ResolvedUpdateFileInfo[] {
  const updateFiles = readManifestFileList(updateInfo).filter((file) => {
    const pathname = resolveManifestUrl(file.url, baseUrl).pathname.toLowerCase();
    return !linuxExtensions || linuxExtensions.some((extension) => pathname.endsWith(extension));
  });
  // Without the current format, upstream findFile falls back to other artifacts or undefined,
  // then fails on cache paths/TypeError. Fail at the resolution boundary; never update across formats.
  if (updateFiles.length === 0) {
    throw new Error(`Manifest contains no update file for ${linuxExtensions?.join(" / ")}`);
  }
  const resolved: ResolvedUpdateFileInfo[] = updateFiles.map((fileInfo) => {
    if (!fileInfo.sha512 && !("sha2" in fileInfo && fileInfo.sha2)) {
      throw new Error(`Manifest file is missing checksum: ${fileInfo.url}`);
    }

    const url = resolveManifestUrl(fileInfo.url, baseUrl);
    // PacmanUpdater matches cache names by .pacman; .pkg.tar.zst falls back to info.url,
    // so hand the cache a bare filename, never a full URL baked into pending/temp-https:/....
    const info = linuxExtensions?.includes(".pkg.tar.zst")
      ? { ...fileInfo, url: posix.basename(decodeURIComponent(url.pathname)) }
      : fileInfo;
    return {
      url,
      info,
    } satisfies ResolvedUpdateFileInfo;
  });

  const packages = isRecord((updateInfo as { packages?: unknown }).packages)
    ? ((updateInfo as { packages?: Record<string, PackageFileInfo> }).packages ?? null)
    : null;
  const packageInfo = packages?.[process.arch] ?? packages?.ia32;
  if (packageInfo && resolved[0]) {
    resolved[0].packageInfo = {
      ...packageInfo,
      path: resolveManifestUrl(packageInfo.path, baseUrl).href,
    };
  }

  return resolved;
}

export class ManifestUpdateProvider extends Provider<UpdateInfo> {
  private readonly options: ManifestUpdateProviderOptions;
  private readonly releasePlatform: string;
  private readonly linuxExtensions: readonly string[] | null;
  private resolveBaseUrl = new URL(DEFAULT_ZCODE_ENDPOINT_ORIGIN);

  constructor(
    options: ManifestUpdateProviderOptions,
    updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(runtimeOptions);
    this.options = options;
    this.linuxExtensions = getLinuxUpdateExtensions(updater);
    this.releasePlatform = options.releasePlatform?.trim() || getElectronReleasePlatform();
    this.resolveBaseUrl = new URL(
      normalizeZCodeEndpointOrigin(options.endpointOrigin ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN),
    );
  }

  override get isUseMultipleRangeRequest(): boolean {
    return false;
  }

  override async getLatestVersion(): Promise<UpdateInfo> {
    const endpointOrigin = await this.resolveEndpointOrigin();
    const releaseChannel = await this.resolveReleaseChannel();
    const manifestUrl = buildElectronManifestUrl({
      endpointOrigin,
      manifestUrl: this.options.manifestUrl,
      platform: this.releasePlatform,
      deviceMid: this.options.deviceMid,
      channel: releaseChannel,
    });
    this.resolveBaseUrl = new URL("/", manifestUrl);
    const releaseChannelApiValue = mapReleaseChannelToApiValue(releaseChannel);

    const raw = await this.httpRequest(manifestUrl, {
      accept: MANIFEST_ACCEPT_HEADER,
      "X-Platform": this.releasePlatform,
      "X-Release-Channel": releaseChannelApiValue,
      ...(this.options.deviceMid?.trim() ? { "X-Device-Mid": this.options.deviceMid.trim() } : {}),
    });
    if (!raw) {
      throw new Error(`Empty electron update manifest: ${manifestUrl.toString()}`);
    }

    const parsed = parseYaml(raw);
    if (!isRecord(parsed) || typeof parsed.version !== "string") {
      throw new Error(`Invalid electron update manifest: ${manifestUrl.toString()}`);
    }

    return {
      ...(parsed as UpdateInfo),
      // After a preview/stable flip the old manifest response can land after the new one.
      // update-available carries no channel, so main cannot tell stale results;
      // attach the request channel to UpdateInfo so old channels never overwrite the dialog.
      zcodeReleaseChannel: releaseChannel,
    } as UpdateInfo;
  }

  override resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    return resolveManifestFiles(updateInfo, this.resolveBaseUrl, this.linuxExtensions);
  }

  private async resolveEndpointOrigin(): Promise<string> {
    const resolved =
      (await this.options.resolveEndpointOrigin?.()) ??
      this.options.endpointOrigin ??
      DEFAULT_ZCODE_ENDPOINT_ORIGIN;
    return normalizeZCodeEndpointOrigin(resolved);
  }

  private async resolveReleaseChannel(): Promise<ElectronReleaseChannel> {
    const resolved =
      (await this.options.resolveReleaseChannel?.()) ?? this.options.releaseChannel ?? "stable";
    return normalizeReleaseChannel(resolved);
  }
}
