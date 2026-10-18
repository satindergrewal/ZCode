import type {
  ListResourceTemplatesResult,
  ListResourcesResult,
  ReadResourceResult,
} from "@modelcontextprotocol/client";
import { INVALID_PARAMS, ProtocolError } from "@modelcontextprotocol/client";
import type { IPluginUiBridgeService, PluginUiPluginScope } from "@zcode/services";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";

/**
 * MCP resource requests from one sandbox instance (read/list/templates/subscribe/unsubscribe) land on the official AppBridge:
 * same plugin server, ownership agent-validated. Subscriptions book by uri per agent generation: per-instance repeats (incl. in-flight) merge;
 * late successes (instance dead or guest replaced) unsubscribe immediately; unsubscribeAll unwinds per uri on guest change and dispose
 * (best effort; session close is the backstop).
 */
export interface PluginUiResourceSubscriptionsDeps {
  bridge: Pick<
    IPluginUiBridgeService,
    | "readResource"
    | "listResources"
    | "listResourceTemplates"
    | "subscribeResource"
    | "unsubscribeResource"
  >;
  pluginScope(): PluginUiPluginScope;
  scopeId: string;
  /** Current agent generation; undefined until the instance is ready. */
  currentGeneration(): number | undefined;
  isDisposed(): boolean;
}

export interface PluginUiResourceSubscriptions {
  /** Attach resources/read, list, templates/list, subscribe, unsubscribe handlers to the current AppBridge. */
  install(bridge: PluginUiHostBridge): void;
  /** Whether this instance subscribed to the uri (notices go to subscribers only). */
  has(uri: string): boolean;
  unsubscribeAll(): void;
}

export function createPluginUiResourceSubscriptions(
  deps: PluginUiResourceSubscriptionsDeps,
): PluginUiResourceSubscriptions {
  const subscribed = new Map<string, number>();
  const inflight = new Map<string, Promise<void>>();
  const params = (uri: string, generation: number) => ({
    ...deps.pluginScope(),
    scopeId: deps.pluginScope().instance.token,
    generation,
    uri,
  });
  const unsubscribeQuietly = (uri: string, generation: number) => {
    void deps.bridge.unsubscribeResource(params(uri, generation)).catch(() => undefined);
  };

  const assertCurrent = () => {
    if (deps.isDisposed()) throw new Error("MCP App instance was closed");
  };
  const subscribe = (uri: string): Promise<void> => {
    assertCurrent();
    const generation = deps.currentGeneration();
    if (generation === undefined) {
      throw new ProtocolError(INVALID_PARAMS, "sandbox is not attached");
    }
    if (subscribed.get(uri) === generation) return Promise.resolve();
    let run = inflight.get(uri);
    if (!run) {
      const bound = params(uri, generation);
      run = deps.bridge
        .subscribeResource(bound)
        .then(() => {
          if (deps.isDisposed() || deps.currentGeneration() !== generation) {
            void deps.bridge.unsubscribeResource(bound).catch(() => undefined);
            return;
          }
          subscribed.set(uri, generation);
        })
        .finally(() => {
          if (inflight.get(uri) === run) inflight.delete(uri);
        });
      inflight.set(uri, run);
    }
    return run;
  };

  return {
    install(bridge) {
      bridge.onreadresource = async (request) => {
        assertCurrent();
        return (await deps.bridge.readResource({
          ...deps.pluginScope(),
          uri: request.uri,
        })) as unknown as ReadResourceResult;
      };
      bridge.onlistresources = async (request) => {
        assertCurrent();
        return (await deps.bridge.listResources({
          ...deps.pluginScope(),
          ...(request?.cursor ? { cursor: request.cursor } : {}),
        })) as unknown as ListResourcesResult;
      };
      bridge.onlistresourcetemplates = async (request) => {
        assertCurrent();
        return (await deps.bridge.listResourceTemplates({
          ...deps.pluginScope(),
          ...(request?.cursor ? { cursor: request.cursor } : {}),
        })) as unknown as ListResourceTemplatesResult;
      };
      // resources/subscribe is a ZCode extension (experimental zcode/resourceSubscribe); spec methods use the two-arg form.
      bridge.setRequestHandler("resources/subscribe", async (request) => {
        await subscribe(request.params.uri);
        return {};
      });
      bridge.setRequestHandler("resources/unsubscribe", async (request) => {
        const uri = request.params.uri;
        const generation = subscribed.get(uri);
        if (generation === undefined) return {};
        subscribed.delete(uri);
        await deps.bridge.unsubscribeResource(params(uri, generation));
        return {};
      });
    },
    has: (uri) => subscribed.has(uri),
    unsubscribeAll() {
      for (const [uri, generation] of subscribed) unsubscribeQuietly(uri, generation);
      subscribed.clear();
    },
  };
}
