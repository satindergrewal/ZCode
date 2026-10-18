import type { ServiceAuthorityMode } from "@zcode/shared";

export type ZCodeAgentPresentationSurface = "desktop";

export interface ZCodeAgentPresentationHostFacts {
  runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  serviceAuthorityMode?: ServiceAuthorityMode;
  /** Main already decided server-side feature gating; when absent, legacy host assembly applies. */
  desktopContextPromptEnabled?: boolean;
}

export function resolveZCodeAgentPresentationSurface(
  facts: ZCodeAgentPresentationHostFacts,
): ZCodeAgentPresentationSurface | undefined {
  // Desktop presentation facts must derive from trusted host assembly, not per-caller flags;
  // plain HTTP/manual app-servers lack them and stay terminal.
  const isDesktopHost =
    facts.runtimeSurface === "desktop_local_host" ||
    facts.serviceAuthorityMode === "desktop-attached-remote";
  if (!isDesktopHost || facts.desktopContextPromptEnabled === false) {
    return undefined;
  }
  return "desktop";
}
