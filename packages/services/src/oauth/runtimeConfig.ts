import type { OAuthProviderId } from "@zcode/shared";
import { createBigModelProviderRuntimeConfig } from "./providers/bigmodelProviderConfig.js";
import { createZaiProviderRuntimeConfig } from "./providers/zaiProviderConfig.js";

/** Provider runtime config (host process only) */
export interface OAuthProviderRuntimeConfig {
  id: OAuthProviderId;
  displayName: string;
  enabled: boolean;
  order: number;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  appId: string;
  redirectUri: string;
  businessLoginUrl?: string;
  appSecret?: string;
}

/** OAuth global runtime config */
export interface OAuthRuntimeConfig {
  providers: OAuthProviderRuntimeConfig[];
}

/**
 * Build OAuth config from runtime env.
 *
 * Host process only, keeping sensitive config away from the renderer.
 */
export function createOAuthRuntimeConfig(env: NodeJS.ProcessEnv = process.env): OAuthRuntimeConfig {
  return {
    providers: [createBigModelProviderRuntimeConfig(env), createZaiProviderRuntimeConfig(env)],
  };
}
