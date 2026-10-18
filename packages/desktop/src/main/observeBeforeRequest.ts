import type { WebRequest, OnBeforeRequestListenerDetails } from "electron";

type Observer = (details: OnBeforeRequestListenerDetails) => void;
type RequestSource = Pick<WebRequest, "onBeforeRequest">;
const sources = new WeakMap<RequestSource, Map<Observer, { urls: string[]; patterns: RegExp[] }>>();

/** Electron keeps only the last listener per event; observers must share this read-only dispatch entry. */
export function subscribeBeforeRequest(
  source: RequestSource,
  urls: string[],
  observer: Observer,
): () => void {
  let observers = sources.get(source);
  if (!observers) {
    observers = new Map();
    sources.set(source, observers);
  }
  const entries = observers;
  const update = () => {
    if (!entries.size) {
      source.onBeforeRequest(null);
      sources.delete(source);
      return;
    }
    source.onBeforeRequest(
      { urls: [...new Set([...entries.values()].flatMap((entry) => entry.urls))] },
      (details, callback) => {
        callback({});
        for (const [listener, entry] of entries) {
          try {
            if (entry.patterns.some((pattern) => pattern.test(details.url))) listener(details);
          } catch {
            /* Observation errors must never block the network or other observers */
          }
        }
      },
    );
  };
  const patterns = urls.map(
    (pattern) =>
      new RegExp(
        `^${pattern
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ),
  );
  entries.set(observer, { urls, patterns });
  update();
  return () => {
    entries.delete(observer);
    update();
  };
}
