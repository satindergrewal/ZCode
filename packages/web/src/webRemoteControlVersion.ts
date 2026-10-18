import type { WebRemoteControlWindowBootstrapResult } from "@zcode/shared";

interface WebRemoteControlVersionGuardOptions {
  requestBootstrap(): Promise<WebRemoteControlWindowBootstrapResult>;
  getUrl(): string;
  isPageReady(): boolean;
  navigate(url: string): void;
  onMismatch(desktopVersion: string): void;
}

/** Owns version checks for the current phone connection only; asset routing is the server's job. */
export function createWebRemoteControlVersionGuard(options: WebRemoteControlVersionGuardOptions) {
  let generation = 0;
  let disposed = false;
  let pendingUrl: string | undefined;
  let navigated = false;
  let inFlight: Promise<WebRemoteControlWindowBootstrapResult | undefined> | undefined;

  const confirm = () => {
    if (disposed || navigated || !pendingUrl) return;
    navigated = true;
    options.navigate(pendingUrl);
  };

  const invalidate = () => {
    generation += 1;
    inFlight = undefined;
  };

  return {
    isBlocked: () => pendingUrl !== undefined,
    confirm,
    invalidate,
    dispose() {
      disposed = true;
      invalidate();
    },
    check(): Promise<WebRemoteControlWindowBootstrapResult | undefined> {
      if (disposed || pendingUrl) return Promise.resolve(undefined);
      if (inFlight) return inFlight;
      const requestGeneration = generation;
      const request = Promise.resolve()
        .then(() => options.requestBootstrap())
        .then((result) => {
          // A reconnect lets stale responses land after the new connection; never navigate or boot on the old desktop's version.
          if (disposed || requestGeneration !== generation) return undefined;
          const version = result.desktopAppVersion?.trim();
          if (!version) return result;
          const url = new URL(options.getUrl());
          if (url.pathname.replace(/\/+$/, "") !== "/remote/v4") return result;
          if (url.searchParams.get("app_version") === version) return result;
          url.searchParams.set("app_version", version);
          pendingUrl = url.toString();
          if (options.isPageReady()) options.onMismatch(version);
          else confirm();
          return undefined;
        })
        .catch((error: unknown) => {
          if (disposed || requestGeneration !== generation) return undefined;
          throw error;
        })
        .finally(() => {
          if (inFlight === request) inFlight = undefined;
        });
      inFlight = request;
      return request;
    },
  };
}
