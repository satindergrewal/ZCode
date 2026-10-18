/**
 * Renderer-side logger.
 * Ships logs over IPC to the main process, which writes ~/.zcode/v2/logs/YYYY-MM-DD.log
 * while mirroring to console for local debugging.
 */
import { formatLogPrefix } from "@zcode/shared";
import { isRendererProductionBuild } from "./rendererLoggingEnv.js";

export const logger = {
  info(...args: unknown[]) {
    if (isRendererProductionBuild()) return;
    console.log(formatLogPrefix("renderer"), ...args);
    window.zcode?.log("info", args);
  },
  warn(...args: unknown[]) {
    if (isRendererProductionBuild()) return;
    console.warn(formatLogPrefix("renderer"), ...args);
    window.zcode?.log("warn", args);
  },
  error(...args: unknown[]) {
    if (isRendererProductionBuild()) return;
    console.error(formatLogPrefix("renderer"), ...args);
    window.zcode?.log("error", args);
  },
};
