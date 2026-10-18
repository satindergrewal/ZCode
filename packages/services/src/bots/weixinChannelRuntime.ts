import type { BotConfig, BotProviderCallbackResult, BotsConfigFile } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { getWeixinUpdates } from "./providers/weixinProvider.js";
import {
  acquireWeixinPollingLock,
  assertBotCallbackSucceeded,
  BOT_RUNTIME_LOCK_RETRY_MS,
  createBotConnectionFingerprint,
  createLatestRuntimeRefreshQueue,
  type BotRuntimeLogger,
  type BotRuntimeStatusSink,
  waitFor,
} from "./channelRuntime.js";

interface WeixinChannelRuntimeDeps {
  runBackgroundTasks?: boolean;
  credentialService: ICredentialService;
  logger: BotRuntimeLogger;
  statusSink: BotRuntimeStatusSink;
  ensureBotStorageMigrated(): Promise<void>;
  readConfig(): Promise<BotsConfigFile>;
  readWeixinGetUpdatesBuf(botId: string): Promise<string | undefined>;
  writeWeixinGetUpdatesBuf(botId: string, buf: string): Promise<void>;
  processProviderCallback(provider: "weixin", payload: unknown): Promise<BotProviderCallbackResult>;
  getUpdates?: typeof getWeixinUpdates;
  acquirePollingLock?: typeof acquireWeixinPollingLock;
}

export function createWeixinChannelRuntime(deps: WeixinChannelRuntimeDeps) {
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
      bot.credentialRef ?? "",
      credential ?? "",
    ]);
  }

  async function pollBot(bot: BotConfig, signal: AbortSignal): Promise<void> {
    const token = bot.credentialRef ? await deps.credentialService.load(bot.credentialRef) : null;
    if (!token?.trim()) {
      deps.statusSink.setRuntimeStatus({
        botId: bot.id,
        provider: "weixin",
        status: "error",
        message: "Weixin bot token is missing.",
      });
      return;
    }

    while (!signal.aborted) {
      let lock: Awaited<ReturnType<typeof acquireWeixinPollingLock>>;
      try {
        lock = await (deps.acquirePollingLock ?? acquireWeixinPollingLock)(token, bot.id);
      } catch (error) {
        if (signal.aborted) return;
        // Bugfix: every window has its own host; WeChat lock I/O failures must backoff-retry, never kill the background promise.
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "error",
          message: `Weixin polling lock failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        await waitFor(5_000, signal);
        continue;
      }
      if (!lock) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "idle",
          message: "Weixin long polling is handled by another ZCode window.",
        });
        await waitFor(BOT_RUNTIME_LOCK_RETRY_MS, signal);
        continue;
      }
      try {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "polling",
          // Fix: run state renders directly in the UI; add messageId so the frontend renders per
          // locale, with message kept only as a legacy fallback.
          message: "Weixin long polling is running.",
          messageId: "bots.runtime.weixinLongPollingRunning",
        });
        while (!signal.aborted) {
          const buf = await deps.readWeixinGetUpdatesBuf(bot.id);
          const result = await (deps.getUpdates ?? getWeixinUpdates)({
            bot,
            deps: { loadCredential: (key) => deps.credentialService.load(key) },
            buf,
            signal,
          });
          if (signal.aborted) {
            return;
          }
          if ((result.rawMessageCount ?? 0) > 0 || result.messages.length > 0) {
            const attachmentCount = result.messages.reduce(
              (count, message) => count + (message.attachments?.length ?? 0),
              0,
            );
            // Debug: WeChat attachments may come with no text; log raw/parsed counts to locate provider-level filtering.
            deps.logger.debug(
              undefined,
              `weixin polling received bot=${bot.id} raw=${result.rawMessageCount ?? 0} parsed=${result.messages.length} attachments=${attachmentCount}`,
            );
            if (result.messages.length === 0) {
              // Debug: log field shapes only (never bodies) to locate why WeChat images/attachments are filtered.
              deps.logger.debug(
                undefined,
                `weixin polling diagnostics bot=${bot.id} ${(result.rawMessageDiagnostics ?? []).join(" | ")}`,
              );
            }
          }
          for (const inbound of result.messages) {
            if (signal.aborted) {
              return;
            }
            const callbackResult = await deps.processProviderCallback("weixin", {
              botId: bot.id,
              messages: [
                {
                  id: inbound.actor.providerMessageId,
                  text: inbound.text,
                  from: inbound.actor.providerUserId,
                  chatId: inbound.actor.chatId,
                  displayName: inbound.actor.displayName,
                  context_token: inbound.actor.providerContextToken,
                  // Bugfix: attachments already parsed by the WeChat poll must survive re-wrapping
                  // for the callback pipeline, or image-only messages go silent once text is empty
                  // and attachments are dropped.
                  attachments: inbound.attachments,
                },
              ],
              ...(result.buf ? { buf: result.buf } : {}),
            });
            assertBotCallbackSucceeded("Weixin", callbackResult);
          }
          if (result.buf) {
            // Bugfix: the WeChat get_updates_buf is the server-side cursor; persist only after the
            // whole batch enters business handling. Persisting first let a mid-flight crash skip
            // unfinished messages, scrambling/dropping AskUserQuestion replies.
            await deps.writeWeixinGetUpdatesBuf(bot.id, result.buf);
          }
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "weixin",
            status: "polling",
            // Fix: run state renders directly in the UI; add messageId so the frontend renders per
            // locale, with message kept only as a legacy fallback.
            message: "Weixin long polling is running.",
            messageId: "bots.runtime.weixinLongPollingRunning",
          });
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "error",
          message: `Weixin polling failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        await waitFor(5_000, signal);
      } finally {
        // Bugfix: the WeChat buf is the third-party queue commit point; only the lock owner may
        // consume/write, and exit must release it for another host to take over.
        await lock.release().catch((error: unknown) => {
          deps.logger.debug(
            undefined,
            `release Weixin polling lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }

  async function stopPolling(botId: string): Promise<void> {
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
        messageId: "bots.runtime.weixinLongPollingStopped",
        message: "Weixin long polling is stopped.",
      });
    }
  }

  function startPolling(bot: BotConfig, fingerprint: string): void {
    if (runtimes.has(bot.id)) {
      return;
    }
    const controller = new AbortController();
    deps.statusSink.setRuntimeStatus({
      botId: bot.id,
      provider: "weixin",
      status: "polling",
      messageId: "bots.runtime.weixinLongPollingStarting",
      message: "Weixin long polling is starting.",
    });
    const runtime: RuntimeEntry = {
      controller,
      fingerprint,
      done: Promise.resolve(),
    };
    runtime.done = pollBot(bot, controller.signal).finally(() => {
      if (runtimes.get(bot.id) === runtime) {
        runtimes.delete(bot.id);
        const previous = deps.statusSink.getRuntimeStatus(bot.id);
        if (previous?.status === "polling") {
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "weixin",
            status: "idle",
            messageId: "bots.runtime.weixinLongPollingStopped",
            message: "Weixin long polling is stopped.",
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
    const activeWeixinIds = new Set(
      currentConfig.bots
        .filter((bot) => bot.provider === "weixin" && bot.enabled && bot.credentialRef)
        .map((bot) => bot.id),
    );
    for (const botId of runtimes.keys()) {
      if (!activeWeixinIds.has(botId)) {
        await stopPolling(botId);
        if (!isLatest()) {
          return;
        }
      }
    }
    for (const bot of currentConfig.bots) {
      if (bot.provider === "weixin" && bot.enabled && bot.credentialRef) {
        const fingerprint = await getConnectionFingerprint(bot);
        if (!isLatest()) {
          return;
        }
        const runtime = runtimes.get(bot.id);
        if (runtime && runtime.fingerprint !== fingerprint) {
          // Bugfix: after a credential change the old getupdates loop still closures the old
          // BotConfig. Take over only after the old request exits, or the old account keeps
          // consuming and both cursors advance concurrently.
          await stopPolling(bot.id);
          if (!isLatest()) {
            return;
          }
        }
        startPolling(bot, fingerprint);
      } else if (bot.provider === "weixin" && !bot.enabled) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
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
      // Fix: post-config-change WeChat long polling is local-desktop-host background work;
      // attached remotes only expose the remote file/agent control plane.
      return;
    }
    void refresh(config).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `refresh Weixin polling failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function dispose(): Promise<void> {
    refreshQueue.invalidate();
    const activeRuntimes = [...runtimes.values()];
    for (const runtime of activeRuntimes) {
      runtime.controller.abort();
    }
    // Bugfix: only the lock owner commits the WeChat buf; destruction completes only after the
    // request exits and finally releases the lock.
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
    stopPolling,
  };
}
