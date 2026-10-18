import {
  isFeishuBotProvider,
  type BotConfig,
  type BotProvider,
  type BotProviderCallbackResult,
  type BotsConfigFile,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { startFeishuBotWebSocket, type FeishuWebSocketClient } from "./providers/feishuProvider.js";
import {
  acquireFeishuWebSocketLock,
  assertBotCallbackSucceeded,
  BOT_RUNTIME_LOCK_RETRY_MS,
  createBotConnectionFingerprint,
  createLatestRuntimeRefreshQueue,
  type BotRuntimeLogger,
  type BotRuntimeStatusSink,
  waitFor,
  waitForAbort,
} from "./channelRuntime.js";

interface FeishuChannelRuntimeDeps {
  runBackgroundTasks?: boolean;
  onConnectionInvalidated?(botId: string): void;
  credentialService: ICredentialService;
  logger: BotRuntimeLogger;
  statusSink: BotRuntimeStatusSink;
  ensureBotStorageMigrated(): Promise<void>;
  readConfig(): Promise<BotsConfigFile>;
  summarizeCallbackPayload(payload: unknown): string;
  processProviderCallback(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
  acquireWebSocketLock?: typeof acquireFeishuWebSocketLock;
  startWebSocket?: typeof startFeishuBotWebSocket;
}

export function createFeishuChannelRuntime(deps: FeishuChannelRuntimeDeps) {
  interface RuntimeEntry {
    controller: AbortController;
    fingerprint: string;
    done: Promise<void>;
  }

  const runtimes = new Map<string, RuntimeEntry>();
  const refreshQueue = createLatestRuntimeRefreshQueue();

  async function getConnectionFingerprint(bot: BotConfig): Promise<string> {
    const credential = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    return createBotConnectionFingerprint([
      bot.provider,
      bot.feishuAppId ?? "",
      bot.credentialRef ?? "",
      credential ?? "",
    ]);
  }

  async function runBot(bot: BotConfig, signal: AbortSignal): Promise<void> {
    let client: FeishuWebSocketClient | null = null;
    while (!signal.aborted) {
      let lock: Awaited<ReturnType<typeof acquireFeishuWebSocketLock>>;
      try {
        lock = await (deps.acquireWebSocketLock ?? acquireFeishuWebSocketLock)(bot);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        // Bugfix: when the runtime stops or the lock dir misbehaves, lock creation can fail before
        // the connection try block; acquire must join the recoverable loop or a multi-window close
        // leaves an unhandled rejection.
        deps.logger.warn(
          undefined,
          `acquire Feishu WebSocket lock failed bot=${bot.id}: ${error instanceof Error ? `${error.message}${"code" in error && typeof error.code === "string" ? ` code=${error.code}` : ""}` : String(error)}`,
        );
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "error",
          message: `Feishu WebSocket lock failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        await waitFor(5_000, signal);
        continue;
      }
      if (!lock) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "idle",
          message: "Feishu WebSocket is handled by another ZCode window.",
        });
        await waitFor(BOT_RUNTIME_LOCK_RETRY_MS, signal);
        continue;
      }
      let retryAfterError = false;
      try {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "connected",
          messageId: "bots.runtime.feishuWebSocketConnecting",
          message: "Feishu WebSocket is connecting.",
        });
        deps.onConnectionInvalidated?.(bot.id);
        client = await (deps.startWebSocket ?? startFeishuBotWebSocket)({
          bot,
          signal,
          onConnectionStateChange: (state) => {
            if (state === "reconnecting") deps.onConnectionInvalidated?.(bot.id);
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: bot.provider,
              status: "connected",
              message:
                state === "reconnecting"
                  ? "Feishu WebSocket is reconnecting."
                  : "Feishu WebSocket is running.",
              messageId:
                state === "reconnecting"
                  ? "bots.runtime.feishuWebSocketConnecting"
                  : "bots.runtime.feishuWebSocketRunning",
            });
          },
          deps: {
            loadCredential: (key) => deps.credentialService.load(key),
          },
          onPayload: async (payload) => {
            if (signal.aborted) {
              return;
            }
            deps.logger.debug(
              undefined,
              `feishu websocket payload bot=${bot.id} ${deps.summarizeCallbackPayload(payload)}`,
            );
            const callbackResult = await deps.processProviderCallback(bot.provider, payload);
            assertBotCallbackSucceeded(bot.provider === "lark" ? "Lark" : "Feishu", callbackResult);
            return callbackResult.replies[0];
          },
        });
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "connected",
          // Fix: run state renders directly in the UI; add messageId so the frontend renders per
          // locale, with message kept only as a legacy fallback.
          message: "Feishu WebSocket is running.",
          messageId: "bots.runtime.feishuWebSocketRunning",
        });
        // Bugfix: first ready is not the end of the long-connection lifecycle; exhausted SDK
        // reconnects must reach the catch to update error state, close the client, release the
        // cross-window lock and re-enter the outer recovery loop.
        await Promise.race([
          waitForAbort(signal),
          client.terminated ?? new Promise<void>(() => undefined),
        ]);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "error",
          message: `Feishu WebSocket failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        retryAfterError = true;
      } finally {
        if (client) {
          try {
            client.close();
          } catch (error) {
            deps.logger.debug(
              undefined,
              `close Feishu WebSocket failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          client = null;
        }
        await lock.release().catch((error: unknown) => {
          deps.logger.warn(
            undefined,
            `release Feishu WebSocket lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      // Fix: retry backoff must not hold the old client and cross-window lock while waiting; fully release resources first.
      if (retryAfterError) {
        await waitFor(5_000, signal);
      }
    }
  }

  async function stopWebSocket(botId: string): Promise<void> {
    const runtime = runtimes.get(botId);
    runtime?.controller.abort();
    if (runtime) {
      await runtime.done;
      if (runtimes.get(botId) === runtime) {
        runtimes.delete(botId);
      }
    }
    const previous = deps.statusSink.getRuntimeStatus(botId);
    if (previous) {
      deps.statusSink.setRuntimeStatus({
        ...previous,
        status: "idle",
        messageId: "bots.runtime.feishuWebSocketStopped",
        message: "Feishu WebSocket is stopped.",
      });
    }
  }

  function startWebSocket(bot: BotConfig, fingerprint: string): void {
    if (runtimes.has(bot.id)) {
      return;
    }
    const controller = new AbortController();
    deps.statusSink.setRuntimeStatus({
      botId: bot.id,
      provider: bot.provider,
      status: "connected",
      messageId: "bots.runtime.feishuWebSocketStarting",
      message: "Feishu WebSocket is starting.",
    });
    const runtime: RuntimeEntry = {
      controller,
      fingerprint,
      done: Promise.resolve(),
    };
    runtime.done = runBot(bot, controller.signal).finally(() => {
      if (runtimes.get(bot.id) === runtime) {
        runtimes.delete(bot.id);
        const previous = deps.statusSink.getRuntimeStatus(bot.id);
        if (previous?.status === "connected") {
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: bot.provider,
            status: "idle",
            messageId: "bots.runtime.feishuWebSocketStopped",
            message: "Feishu WebSocket is stopped.",
          });
        }
      }
    });
    runtimes.set(bot.id, runtime);
  }

  async function reconcile(
    config: BotsConfigFile | undefined,
    isLatest: () => boolean,
  ): Promise<void> {
    await deps.ensureBotStorageMigrated();
    const currentConfig = config ?? (await deps.readConfig());
    if (!isLatest()) {
      return;
    }
    const activeFeishuIds = new Set(
      currentConfig.bots
        .filter(
          (bot) =>
            isFeishuBotProvider(bot.provider) &&
            bot.enabled &&
            bot.credentialRef &&
            bot.feishuAppId,
        )
        .map((bot) => bot.id),
    );
    for (const botId of runtimes.keys()) {
      if (!activeFeishuIds.has(botId)) {
        await stopWebSocket(botId);
        if (!isLatest()) {
          return;
        }
      }
    }
    for (const bot of currentConfig.bots) {
      if (
        isFeishuBotProvider(bot.provider) &&
        bot.enabled &&
        bot.credentialRef &&
        bot.feishuAppId
      ) {
        const fingerprint = await getConnectionFingerprint(bot);
        if (!isLatest()) {
          return;
        }
        const runtime = runtimes.get(bot.id);
        if (runtime && runtime.fingerprint !== fingerprint) {
          // Bugfix: after a Feishu/Lark provider/app-id/credential change the old WebSocket still
          // holds the old config. Await old-client and cross-window-lock release before the new
          // connection so only one config generation per bot is live.
          await stopWebSocket(bot.id);
          if (!isLatest()) {
            return;
          }
        }
        startWebSocket(bot, fingerprint);
      } else if (isFeishuBotProvider(bot.provider) && !bot.enabled) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "disabled",
          messageId: "bots.runtime.botDisabled",
          message: "Bot is disabled.",
        });
      }
    }
  }

  function refresh(config?: BotsConfigFile): Promise<void> {
    return refreshQueue.enqueue((isLatest) => reconcile(config, isLatest));
  }

  function scheduleRefresh(config?: BotsConfigFile): void {
    if (deps.runBackgroundTasks === false) {
      // Fix: remote workspace hosts / desktop-attached remotes expose control-plane services only;
      // the bot runtime background connection stays on the local desktop host so a config change
      // cannot race ahead again.
      return;
    }
    void refresh(config).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `refresh Feishu WebSocket failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function dispose(): Promise<void> {
    refreshQueue.invalidate();
    const activeRuntimes = [...runtimes.values()];
    for (const runtime of activeRuntimes) {
      runtime.controller.abort();
    }
    // Bugfix: abort only signals cancellation; destroyed state must await WebSocket close and the finally-released cross-process lock.
    await Promise.allSettled(activeRuntimes.map((runtime) => runtime.done));
    for (const [botId, runtime] of runtimes) {
      if (activeRuntimes.includes(runtime)) {
        runtimes.delete(botId);
      }
    }
  }

  return {
    dispose,
    refresh,
    scheduleRefresh,
    stopWebSocket,
  };
}
