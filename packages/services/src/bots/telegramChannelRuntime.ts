import type { BotConfig, BotProviderCallbackResult, BotsConfigFile } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { BotProviderAdapter } from "./providers/types.js";
import { fetchBotProvider, fetchBotProviderJson } from "./providers/providerRequest.js";
import {
  acquireTelegramPollingLock,
  assertBotCallbackSucceeded,
  BOT_RUNTIME_LOCK_RETRY_MS,
  createBotConnectionFingerprint,
  createLatestRuntimeRefreshQueue,
  type BotRuntimeLogger,
  type BotRuntimeStatusSink,
  waitFor,
} from "./channelRuntime.js";

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: unknown[];
  description?: string;
}

// Telegram server-side long polling waits up to 25s; the client adds transport headroom but must
// cover body reads so a half-open connection never pins the polling lock and blocks config refresh.
const TELEGRAM_LONG_POLL_REQUEST_TIMEOUT_MS = 40_000;

interface TelegramChannelRuntimeDeps {
  runBackgroundTasks?: boolean;
  credentialService: ICredentialService;
  telegramProvider: BotProviderAdapter | null;
  logger: BotRuntimeLogger;
  statusSink: BotRuntimeStatusSink;
  ensureBotStorageMigrated(): Promise<void>;
  readConfig(): Promise<BotsConfigFile>;
  readTelegramOffset(botId: string): Promise<number | undefined>;
  writeTelegramOffset(botId: string, offset: number): Promise<void>;
  processProviderCallback(
    provider: "telegram",
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
  acquirePollingLock?: typeof acquireTelegramPollingLock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createTelegramChannelRuntime(deps: TelegramChannelRuntimeDeps) {
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

  async function syncCommands(bot: BotConfig): Promise<void> {
    if (deps.runBackgroundTasks === false) {
      // Fix: desktop-attached remotes do not own the Telegram runtime; bot deletion/disabling
      // must not hit third-party APIs just to clear commands.
      return;
    }
    await deps.telegramProvider?.syncCommands?.(bot).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `sync Telegram commands failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function pollBot(bot: BotConfig, signal: AbortSignal): Promise<void> {
    const token = bot.credentialRef ? await deps.credentialService.load(bot.credentialRef) : null;
    if (!token?.trim()) {
      deps.statusSink.setRuntimeStatus({
        botId: bot.id,
        provider: "telegram",
        status: "error",
        messageId: "bots.runtime.telegramTokenMissing",
        message: "Telegram bot token is missing.",
      });
      return;
    }

    while (!signal.aborted) {
      let lock: Awaited<ReturnType<typeof acquireTelegramPollingLock>>;
      try {
        lock = await (deps.acquirePollingLock ?? acquireTelegramPollingLock)(token, bot.id);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        // Bugfix: transient lock-dir/rename I/O errors outside the polling try kill the background
        // promise. The lock is part of the runtime lifecycle and must retry with observable,
        // cancellable backoff.
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "error",
          message: `Telegram polling lock failed: ${error instanceof Error ? error.message : String(error)}`,
          offset: await deps.readTelegramOffset(bot.id),
        });
        await waitFor(5_000, signal);
        continue;
      }
      if (!lock) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "idle",
          messageId: "bots.runtime.telegramLongPollingHandledElsewhere",
          message: "Telegram long polling is handled by another ZCode window.",
          offset: await deps.readTelegramOffset(bot.id),
        });
        await waitFor(BOT_RUNTIME_LOCK_RETRY_MS, signal);
        continue;
      }
      try {
        try {
          await fetchBotProvider(`https://api.telegram.org/bot${token}/deleteWebhook`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ drop_pending_updates: false }),
            signal,
          });
        } catch {
          if (signal.aborted) {
            return;
          }
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "polling",
          // Fix: run state renders directly in the UI; add messageId so the frontend renders per
          // locale, with message kept only as a legacy fallback.
          message: "Telegram long polling is running.",
          messageId: "bots.runtime.telegramLongPollingRunning",
          offset: await deps.readTelegramOffset(bot.id),
        });

        while (!signal.aborted) {
          const offset = await deps.readTelegramOffset(bot.id);
          const response = await fetchBotProviderJson<TelegramGetUpdatesResponse>(
            `https://api.telegram.org/bot${token}/getUpdates`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                timeout: 25,
                ...(offset !== undefined ? { offset } : {}),
                allowed_updates: ["message", "callback_query"],
              }),
              signal,
            },
            TELEGRAM_LONG_POLL_REQUEST_TIMEOUT_MS,
          );
          if (!response.ok) {
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: "telegram",
              status: "error",
              message:
                response.status === 409
                  ? "Telegram token is already used by another polling client."
                  : `Telegram getUpdates failed: HTTP ${response.status}`,
              offset,
            });
            await waitFor(response.status === 409 ? 10_000 : 5_000, signal);
            continue;
          }
          const payload = response.payload;
          if (payload?.ok !== true || !Array.isArray(payload.result)) {
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: "telegram",
              status: "error",
              message: payload?.description ?? "Telegram getUpdates returned an invalid response.",
              offset,
            });
            await waitFor(5_000, signal);
            continue;
          }
          if (signal.aborted) {
            return;
          }
          for (const update of payload.result) {
            if (signal.aborted) {
              return;
            }
            const updateId =
              isRecord(update) && typeof update.update_id === "number" ? update.update_id : null;
            const callbackResult = await deps.processProviderCallback("telegram", {
              botId: bot.id,
              update,
            });
            assertBotCallbackSucceeded("Telegram", callbackResult);
            if (updateId !== null) {
              // Bugfix: the offset is Telegram's consumption commit point. Advancing before the
              // business callback succeeds permanently skips messages/permissions/elicitation
              // responses; commit one-by-one after success so retries are safe.
              await deps.writeTelegramOffset(bot.id, updateId + 1);
            }
          }
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "telegram",
            status: "polling",
            // Fix: run state renders directly in the UI; add messageId so the frontend renders per
            // locale, with message kept only as a legacy fallback.
            message: "Telegram long polling is running.",
            messageId: "bots.runtime.telegramLongPollingRunning",
            offset: await deps.readTelegramOffset(bot.id),
          });
        }
      } catch {
        if (signal.aborted) {
          return;
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "error",
          messageId: "bots.runtime.telegramPollingFailedRetrying",
          message: "Telegram polling failed; retrying.",
          offset: await deps.readTelegramOffset(bot.id),
        });
        await waitFor(5_000, signal);
      } finally {
        await lock.release().catch((error: unknown) => {
          deps.logger.debug(
            undefined,
            `release Telegram polling lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
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
        messageId: "bots.runtime.telegramLongPollingStopped",
        message: "Telegram long polling is stopped.",
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
      provider: "telegram",
      status: "polling",
      messageId: "bots.runtime.telegramLongPollingStarting",
      message: "Telegram long polling is starting.",
    });
    const runtime: RuntimeEntry = {
      controller,
      fingerprint,
      done: Promise.resolve(),
    };
    runtime.done = pollBot(bot, controller.signal)
      .catch((error: unknown) => {
        // Bugfix: settle the background runtime's final promise explicitly so its errors never become host-level unhandled rejections.
        deps.logger.warn(
          undefined,
          `Telegram polling stopped unexpectedly bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (runtimes.get(bot.id) === runtime) {
          runtimes.delete(bot.id);
          const previous = deps.statusSink.getRuntimeStatus(bot.id);
          if (previous?.status === "polling") {
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: "telegram",
              status: "idle",
              messageId: "bots.runtime.telegramLongPollingStopped",
              message: "Telegram long polling is stopped.",
              offset: previous.offset,
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
    // Bugfix: the polling cursor and WeChat buf persist into bot-state.v3.json. Finish legacy
    // state migration before polling starts or the migration write-back can clobber a freshly
    // updated third-party cursor.
    await deps.ensureBotStorageMigrated();
    const currentConfig = config ?? (await deps.readConfig());
    if (!isLatest()) {
      return;
    }
    const activeTelegramIds = new Set(
      currentConfig.bots
        .filter((bot) => bot.provider === "telegram" && bot.enabled && bot.credentialRef)
        .map((bot) => bot.id),
    );
    for (const botId of runtimes.keys()) {
      if (!activeTelegramIds.has(botId)) {
        await stopPolling(botId);
        if (!isLatest()) {
          return;
        }
      }
    }
    for (const bot of currentConfig.bots) {
      if (bot.provider === "telegram" && bot.enabled && bot.credentialRef) {
        await syncCommands(bot);
        if (!isLatest()) {
          return;
        }
        const fingerprint = await getConnectionFingerprint(bot);
        if (!isLatest()) {
          return;
        }
        const runtime = runtimes.get(bot.id);
        if (runtime && runtime.fingerprint !== fingerprint) {
          // Bugfix: an unchanged bot id does not mean an unchanged connection identity. Wait for
          // the old token's polling and lock to fully exit before starting the new credentials,
          // or the background keeps consuming the old account or two instances briefly overlap.
          await stopPolling(bot.id);
          if (!isLatest()) {
            return;
          }
        }
        startPolling(bot, fingerprint);
      } else if (bot.provider === "telegram" && !bot.enabled) {
        await syncCommands(bot);
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
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
      // Fix: post-config-change polling refresh is a bot-runtime background job too; attached
      // remotes must not bypass the construction-time guard to start Telegram polling.
      return;
    }
    void refresh(config).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `refresh Telegram polling failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function dispose(): Promise<void> {
    refreshQueue.invalidate();
    const activeRuntimes = [...runtimes.values()];
    for (const runtime of activeRuntimes) {
      runtime.controller.abort();
    }
    // Bugfix: destruction must await long-polling exit and token-lock release, or the next host
    // stalls until a later retry round.
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
    syncCommands,
  };
}
