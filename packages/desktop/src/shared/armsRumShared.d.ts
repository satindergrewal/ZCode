import { type ZCodeRuntimeEnv } from "@zcode/shared";
/** browserCollectors for the main init, injected into the renderer RumSDK.init(collectors) via autoInject. */
export declare const ARMS_BROWSER_COLLECTORS: {
  readonly perf: true;
  readonly webvitals: true;
  readonly exception: true;
  readonly whiteScreen: true;
  readonly api: true;
  readonly staticResource: true;
  readonly click: true;
  readonly longTask: true;
};
/** ARMS view-name resolution: one rule for file:// and dev-server, shared by main parseViewName and renderer. */
export declare function parseArmsViewName(url: string): string;
/** Renderer Browser SDK init config (endpoint/env/version aligned with main). */
export declare function buildArmsBrowserInitConfig(runtimeEnv: ZCodeRuntimeEnv): {
  enable: boolean;
  version: string;
  endpoint: string;
  env: import("@zcode/shared").ArmsRumEnv;
  sessionConfig: {
    sampleRate: number;
  };
  spaMode: false;
  parseViewName: typeof parseArmsViewName;
  collectors: {
    perf: true;
    webvitals: true;
    exception: true;
    whiteScreen: true;
    api: true;
    staticResource: true;
    click: true;
    longTask: true;
  };
};
//# sourceMappingURL=armsRumShared.d.ts.map
