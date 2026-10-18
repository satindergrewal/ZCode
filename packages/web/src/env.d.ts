declare module "*.css";
declare module "@zcode/ui/styles.css";

interface ImportMetaEnv {
  // Hand-written Vite env shape; BASE_URL must be declared explicitly too, otherwise
  // phone remote control cannot pass typecheck when telling /remote and /remote/v3 apart
  // by build base.
  readonly BASE_URL: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly VITE_DEV_ORIGIN?: string;
  readonly VITE_CONVERSATION_SHARE_PREVIEW_MOCK?: string;
  readonly VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO?: string;
  // With versioned OSS releases the asset base carries the version dir; page routing comes
  // from this variable explicitly.
  readonly VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?: string;
  readonly VITE_ZCODE_BASE_URL?: string;
  readonly VITE_ZCODE_ENDPOINT_ORIGIN?: string;
  readonly VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
