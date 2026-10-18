import { isIP } from "node:net";
import type { BrowserInfo } from "./facade.js";

export type BrowserTabsByBrowserId = ReadonlyMap<string, readonly string[]>;

function isPreferredExtension(info: BrowserInfo): boolean {
  return (
    info.type === "extension" &&
    (info.metadata?.preferred === "true" ||
      info.metadata?.preferredInstance === "true" ||
      info.metadata?.profileIsLastUsed === "true" ||
      info.metadata?.profileOrdering === "0")
  );
}

function backendFallbackRank(info: BrowserInfo): number {
  if (info.type === "iab") return 0;
  if (isPreferredExtension(info)) return 1;
  if (info.type === "extension") return 2;
  return 3;
}

export function selectDefaultBrowser(infos: readonly BrowserInfo[]): BrowserInfo | undefined {
  return [...infos].sort(
    (left, right) => backendFallbackRank(left) - backendFallbackRank(right),
  )[0];
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`Invalid browser target URL: ${value}`);
  }
}

function isLocalTarget(url: URL): boolean {
  if (url.protocol === "file:") return true;
  const host = url.hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function withoutHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

function urlMatchRank(target: URL, candidate: URL): number | undefined {
  if (withoutHash(target) === withoutHash(candidate)) return 0;
  if (target.origin === candidate.origin && target.pathname === candidate.pathname) return 1;
  if (target.hostname === candidate.hostname) return 2;
  const targetHost = target.hostname.toLowerCase();
  const candidateHost = candidate.hostname.toLowerCase();

  const isParentHost = (parent: string, child: string) =>
    parent.includes(".") && isIP(parent) === 0 && child.endsWith(`.${parent}`);
  if (isParentHost(candidateHost, targetHost) || isParentHost(targetHost, candidateHost)) return 3;
  return undefined;
}

/**
  * Tab-reuse matching for open(url): pick the agent-owned tab most worth navigating in place.
  * Reuse threshold rank <= 2 (same hostname); rank 3 parent/child domains may be different sites — too risky to navigate, do not copy.
  * On equal rank prefer the active tab, otherwise the newest (latest) in the list.
  * Pure function like selectBrowserForUrl, so contract cases can be shared.
 */
export function selectTabForUrl<T extends { url?: string; active?: boolean }>(
  targetValue: string,
  tabs: readonly T[],
): T | undefined {
  const target = parseUrl(targetValue);
  let best: { tab: T; rank: number } | undefined;
  for (const tab of tabs) {
    if (!tab.url) continue;
    let rank: number | undefined;
    try {
      rank = urlMatchRank(target, parseUrl(tab.url));
    } catch {
      continue; // One bad URL must not invalidate reuse matching.
    }
    if (rank === undefined || rank > 2) continue;
    if (
      best === undefined ||
      rank < best.rank ||
            // Equal rank: active wins; otherwise the later (newer) entry in the list.
      (rank === best.rank && (tab.active === true || best.tab.active !== true))
    ) {
      best = { tab, rank };
    }
  }
  return best?.tab;
}

/**
  * URL selection is pure so one set of contract cases can pin IAB/extension/CDP.
  * Explicit browser selection bypasses this path, so this fallback can never switch backends silently.
 */
export function selectBrowserForUrl(
  infos: readonly BrowserInfo[],
  targetValue: string,
  tabsByBrowserId: BrowserTabsByBrowserId,
): BrowserInfo {
  if (infos.length === 0) {
    throw new Error("No browser backend is available");
  }
  if (infos.length === 1) {
    return infos[0];
  }

  const target = parseUrl(targetValue);
  if (isLocalTarget(target)) {
    const iab = infos.find((info) => info.type === "iab");
    if (iab) return iab;
  }

  const matches = infos.flatMap((info) => {
    let best: number | undefined;
    for (const value of tabsByBrowserId.get(info.id) ?? []) {
      try {
        const rank = urlMatchRank(target, parseUrl(value));
        if (rank !== undefined && (best === undefined || rank < best)) best = rank;
      } catch {
                // One bad URL from the backend must not invalidate the whole registry.
      }
    }
    return best === undefined ? [] : [{ info, matchRank: best }];
  });
  matches.sort(
    (left, right) =>
      left.matchRank - right.matchRank ||
      backendFallbackRank(left.info) - backendFallbackRank(right.info),
  );
  return matches[0]?.info ?? selectDefaultBrowser(infos) ?? infos[0];
}
