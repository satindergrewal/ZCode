import type { BrowserWindow, NativeImage } from "electron";
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN, buildZCodeEndpointUrls, type Locale } from "@zcode/shared";

export interface ArchitectureMismatch {
  /** Architecture of the running binary, e.g. x64. */
  binaryArch: string;
  /** The recommended native arch; today translation falls back to arm64 only. */
  nativeArch: string;
}

export interface DetectArchitectureMismatchOptions {
  platform?: NodeJS.Platform;
  binaryArch?: string;
  /**
   * Electron app.runningUnderARM64Translation:
   * true when an x64/x86 installer runs translated on arm64 hardware
   * (Rosetta on macOS, Windows on ARM) -- the classic wrong-arch install.
   */
  runningUnderARM64Translation?: boolean;
}

/**
 * Whether the current process runs under the wrong architecture.
 *
 * Decided via runningUnderARM64Translation, not process.arch vs os.arch(): on Apple silicon, x64 builds
 * also report os.arch() === "x64" under transparent Rosetta, so a plain compare sees no difference.
 * The translation flag is the only reliable signal.
 */
export function detectArchitectureMismatch(
  options: DetectArchitectureMismatchOptions = {},
): ArchitectureMismatch | null {
  const platform = options.platform ?? process.platform;
  const binaryArch = options.binaryArch ?? process.arch;
  const translated = options.runningUnderARM64Translation ?? false;

  if (!translated) {
    return null;
  }
  // Only macOS/Windows have ARM64 translation; pass other platforms through to avoid false positives.
  if (platform !== "darwin" && platform !== "win32") {
    return null;
  }

  return { binaryArch, nativeArch: "arm64" };
}

export function resolveArchitectureDownloadUrl(
  locale: Locale,
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
): string {
  // Same locale split as the changelog links: route to the matching download page.
  const origin = buildZCodeEndpointUrls(endpointOrigin).origin;
  return locale === "zh-CN" ? `${origin}/cn` : `${origin}/en`;
}

interface ArchitectureMismatchDialogText {
  title: string;
  message: string;
  detail: string;
  downloadButton: string;
  dismissButton: string;
}

export function formatArchitectureMismatchDialogText(
  mismatch: ArchitectureMismatch,
  locale: Locale,
): ArchitectureMismatchDialogText {
  const isZh = locale === "zh-CN";
  if (isZh) {
    return {
      title: "架构不匹配",
      message: "当前安装的不是适配本机的版本",
      detail:
        `你正在运行 ${mismatch.binaryArch} 版本，但本机是 ${mismatch.nativeArch}（Apple 芯片）架构，` +
        `当前通过系统转译运行，会更慢、更耗电。\n\n` +
        `建议前往官网下载并安装 ${mismatch.nativeArch} 原生版本以获得最佳性能。`,
      downloadButton: "前往下载",
      dismissButton: "暂不处理",
    };
  }

  return {
    title: "Architecture Mismatch",
    message: "The installed build does not match your machine",
    detail:
      `You are running the ${mismatch.binaryArch} build, but this machine is ${mismatch.nativeArch}. ` +
      `It is currently running through system translation, which is slower and less power-efficient.\n\n` +
      `Please download and install the native ${mismatch.nativeArch} build for the best performance.`,
    downloadButton: "Download",
    dismissButton: "Not now",
  };
}

export interface ArchitectureGuardLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * Detect an architecture mismatch at startup; on a wrong-arch install, prompt for the native build.
 * Non-blocking: the dialog fires asynchronously after detection; UI loading continues.
 */
export async function maybeWarnArchitectureMismatch(options: {
  locale: Locale;
  logger: ArchitectureGuardLogger;
  parentWindow?: BrowserWindow | null;
  icon?: NativeImage;
}): Promise<void> {
  const { app, dialog, shell } = await import("electron");

  const mismatch = detectArchitectureMismatch({
    runningUnderARM64Translation: app.runningUnderARM64Translation,
  });
  if (!mismatch) {
    return;
  }

  options.logger.warn(
    `[architecture] mismatch: running ${mismatch.binaryArch}, host ${mismatch.nativeArch} (translated)`,
  );

  const text = formatArchitectureMismatchDialogText(mismatch, options.locale);
  const dialogOptions = {
    type: "warning" as const,
    buttons: [text.downloadButton, text.dismissButton],
    defaultId: 0,
    cancelId: 1,
    title: text.title,
    message: text.message,
    detail: text.detail,
    ...(options.icon && !options.icon.isEmpty() ? { icon: options.icon } : {}),
  };

  const { response } =
    options.parentWindow && !options.parentWindow.isDestroyed()
      ? await dialog.showMessageBox(options.parentWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions);

  if (response === 0) {
    const url = resolveArchitectureDownloadUrl(options.locale);
    options.logger.info(`[architecture] user chose to download: ${url}`);
    await shell.openExternal(url);
  }
}
