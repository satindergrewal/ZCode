import {
  mapZCodeEnvToArmsRumEnv,
  type ZCodeRuntimeEnv,
  ZCODE_ARMS_RUM_ENDPOINT,
  ZCODE_VERSION,
} from "@zcode/shared";

/** browserCollectors for the main init, injected into the renderer RumSDK.init(collectors) via autoInject. */
export const ARMS_BROWSER_COLLECTORS = {
  perf: true,
  webvitals: true,
  exception: true,
  whiteScreen: true,
  api: true,
  staticResource: true,
  // Click capture on: desktop interaction is dense, so expect higher volume/noise -- watch ARMS usage.
  click: true,
  longTask: true,
} as const;

/** ARMS view-name resolution: one rule for file:// and dev-server, shared by main parseViewName and renderer. */
export function parseArmsViewName(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      const fileName = parsed.pathname.split("/").pop() ?? "index.html";
      return fileName.replace(/\.html$/i, "") || "index";
    }
    const path = parsed.pathname || "/";
    return path.length > 120 ? `${path.slice(0, 120)}…` : path;
  } catch {
    return url.length > 120 ? `${url.slice(0, 120)}…` : url;
  }
}

/** Renderer Browser SDK init config (endpoint/env/version aligned with main). */
export function buildArmsBrowserInitConfig(runtimeEnv: ZCodeRuntimeEnv) {
  return {
    enable: ZCODE_ARMS_RUM_ENDPOINT !== "",
    version: ZCODE_VERSION,
    endpoint: ZCODE_ARMS_RUM_ENDPOINT,
    env: mapZCodeEnvToArmsRumEnv(runtimeEnv),
    sessionConfig: {
      sampleRate: 1,
    },
    spaMode: false as const,
    parseViewName: parseArmsViewName,
    collectors: { ...ARMS_BROWSER_COLLECTORS },
  };
}
