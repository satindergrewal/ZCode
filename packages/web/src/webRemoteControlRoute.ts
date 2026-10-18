import { resolveWebRemoteControlRoutePathFromBaseUrl } from "@zcode/shared";

interface WebRemoteControlRouteEnv {
  readonly VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?: string;
  readonly BASE_URL: string;
}

/**
 * Page routes and asset dirs stay separate: multi-version OSS releases serve `/remote/v4/<version>/` as the Vite base,
 * so every subresource carries its version while the page entry remains `/remote/v4`. Inject the route var at build time to override;
 * when absent (Docker, v3, dev `/remote`) fall back to the BASE_URL derivation, matching legacy behavior.
 */
export function resolveWebRemoteControlRoutePath(env: WebRemoteControlRouteEnv): string {
  const explicitRoutePath = env.VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?.trim();
  return resolveWebRemoteControlRoutePathFromBaseUrl(explicitRoutePath || env.BASE_URL);
}
