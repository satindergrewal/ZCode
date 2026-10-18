/* eslint-disable max-lines -- BotsDialog keeps data loading, saving, and polling orchestration; the right-hand cards are split into BotsDialog/* subcomponents, keep sinking state into hooks over time. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import QRCode from "qrcode";
import { Bot, Loader2, Plus } from "lucide-react";
import type {
  BotConfig,
  BotProvider,
  BotServiceStatus,
  BotState,
  BotWorkspaceRef,
  BotsConfigFile,
} from "@zcode/shared";
import {
  ALL_BOT_WORKSPACES,
  createUuid,
  DEFAULT_BOT_REPLY_GRANULARITY,
  isFeishuBotProvider,
  normalizeBotReplyGranularity,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { logger } from "@/logger.js";
import {
  BOT_PROVIDERS,
  buildCurrentWorkspaceId,
  getBotProviderRegionTagLabelId,
  resolveBotProviderEntry,
  type BotProviderEntryId,
} from "@/botsUi.js";
import { cn } from "@/components/lib/utils.js";
import {
  BotDangerCard,
  BotReplyGranularityCard,
  BotSummaryCard,
} from "@/BotsDialog/BotSummaryCard.js";
import { ProviderSettingsCard } from "@/BotsDialog/ProviderSettingsCard.js";
import { WorkspaceAccessCard } from "@/BotsDialog/WorkspaceAccessCard.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import {
  BIND_CODE_TTL_MS,
  ProviderIcon,
  TELEGRAM_BOTFATHER_URL,
  createDefaultCommands,
  formatBotDisplayName,
  isAllWorkspacesAllowed,
  runtimeDot,
  type BindCodeState,
  type FeishuRegistrationState,
  type WeixinRegistrationState,
} from "@/BotsDialog/shared.js";

function createEmptyConfig(): BotsConfigFile {
  return { version: 3, bots: [] };
}

function createDraftBot(params: { provider: BotProvider }): BotConfig {
  // Bugfix: the bot id is only the config entity identity and must not carry a provider prefix;
  // seeing telegram-* on creation reads as if the channel were pinned to Telegram.
  const id = `bot-${createUuid()}`;
  return {
    id,
    name: "",
    provider: params.provider,
    enabled: true,
    allowedWorkspaces: [ALL_BOT_WORKSPACES],
    allowedCommands: createDefaultCommands(),
    currentOptions: {},
    replyMode: normalizeBotReplyGranularity(
      params.provider,
      DEFAULT_BOT_REPLY_GRANULARITY,
    ),
  };
}

export function BotsDialog({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
  entryProvider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  entryProvider?: BotProvider | null;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const { botsService } = useServices();
  const [config, setConfig] = useState<BotsConfigFile>(() =>
    createEmptyConfig(),
  );
  const [workspaceRefs, setWorkspaceRefs] = useState<BotWorkspaceRef[]>([]);
  const [status, setStatus] = useState<BotServiceStatus | null>(null);
  const [botStates, setBotStates] = useState<BotState[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [creatingBot, setCreatingBot] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState<BotProvider | null>(
    null,
  );
  const [bindCode, setBindCode] = useState<BindCodeState | null>(null);
  const [feishuRegistration, setFeishuRegistration] =
    useState<FeishuRegistrationState | null>(null);
  const [feishuRegistrationLoading, setFeishuRegistrationLoading] =
    useState(false);
  const [weixinRegistration, setWeixinRegistration] =
    useState<WeixinRegistrationState | null>(null);
  const [weixinRegistrationLoading, setWeixinRegistrationLoading] =
    useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [credentialValue, setCredentialValue] = useState("");
  const [secretSaving, setSecretSaving] = useState(false);
  const [workspaceAccessSaving, setWorkspaceAccessSaving] = useState(false);
  const [botNameDraft, setBotNameDraft] = useState<{
    botId: string;
    value: string;
  } | null>(null);
  const [renamingBotId, setRenamingBotId] = useState<string | null>(null);
  const botNameCompositionActiveRef = useRef(false);
  const autoQrStartedBotIdsRef = useRef(new Set<string>());
  const autoBindCreatingBotIdsRef = useRef(new Set<string>());
  const handledEntryProviderRef = useRef<BotProvider | null>(null);

  const currentWorkspaceId = useMemo(
    () => buildCurrentWorkspaceId(workspacePath, workspaceIdentity),
    [workspaceIdentity, workspacePath],
  );
  const currentWorkspace = useMemo(
    () => ({
      id: currentWorkspaceId,
      label:
        workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspacePath,
      workspacePath,
      workspaceIdentity,
    }),
    [currentWorkspaceId, workspaceIdentity, workspacePath],
  );
  const selectedBot =
    config.bots.find((bot) => bot.id === selectedBotId) ?? null;
  const selectedBotState =
    botStates.find((state) => state.botId === selectedBotId) ?? null;
  const selectedBotName =
    selectedBot && botNameDraft?.botId === selectedBot.id
      ? botNameDraft.value
      : (selectedBot?.name ?? "");
  const fallbackBotName = intl.formatMessage({
    id: "bots.newBot.fallbackName",
  });
  const selectedBotDisplayName = formatBotDisplayName(
    selectedBotName,
    fallbackBotName,
  );
  const bindRemainingMs = bindCode
    ? Math.max(0, bindCode.expiresAt - nowMs)
    : 0;
  const bindExpired = Boolean(bindCode && bindRemainingMs <= 0);
  const bindCountdownProgress = bindCode
    ? Math.max(0, Math.min(100, (bindRemainingMs / bindCode.ttlMs) * 100))
    : 0;

  useEffect(() => {
    if (!open || !bindCode) return undefined;
    setNowMs(Date.now());
    // Bugfix: after the bind code shrank to 30s, 1s refresh made the progress bar visibly jump.
    // Drive the animation at a finer cadence; the text still ticks per second via formatBindCountdown.
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [bindCode, open]);

  useEffect(() => {
    if (!open || !bindCode || bindExpired) return undefined;
    let cancelled = false;

    const pollBindResult = async () => {
      try {
        const nextConfig = await botsService.getConfig();
        if (cancelled) return;
        setConfig(nextConfig);
        const targetBot = nextConfig.bots.find(
          (bot) => bot.id === bindCode.botId,
        );
        if (targetBot?.providerUserId) {
          // Bugfix: /bind writes the config back from the third-party chat; the UI has no direct event.
          // Poll the config at a low rate while the bind code is expanded, collapse it on success.
          setBindCode(null);
        }
      } catch (error) {
        logger.warn(
          "[BotsDialog] Failed to poll bot bind result",
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    void pollBindResult();
    const timer = window.setInterval(() => {
      void pollBindResult();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bindCode, bindExpired, botsService, open]);

  useEffect(() => {
    if (
      !bindCode ||
      bindCode.botId !== selectedBot?.id ||
      !selectedBot.providerUserId
    ) {
      return;
    }
    // Bugfix: a successful /bind is an async config write-back in the service layer; even if the
    // poll is interrupted by a switch/refresh, collapse the old bind code as soon as the current
    // bot already has a providerUserId.
    setBindCode(null);
  }, [bindCode, selectedBot?.id, selectedBot?.providerUserId]);

  useEffect(() => {
    setCredentialValue("");
    setSecretSaving(false);
    setWorkspaceAccessSaving(false);
    setFeishuRegistration(null);
    setWeixinRegistration(null);
  }, [selectedBotId, selectedBot?.provider]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollStatus = async () => {
      try {
        const nextStatus = await botsService.getStatus();
        if (!cancelled) setStatus(nextStatus);
      } catch (error) {
        logger.debug("[BotsDialog] Failed to refresh bot runtime state", error);
      } finally {
        // Delivery finishes in the background; refresh serially only while the dialog is visible
        // to avoid slow-RPC pileup or write-backs after close.
        if (!cancelled) timer = setTimeout(() => void pollStatus(), 2000);
      }
    };
    void pollStatus();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [botsService, open]);

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextStatus, nextWorkspaces, nextBotStates] =
        await Promise.all([
          botsService.getConfig(),
          botsService.getStatus(),
          botsService.listWorkspaceRefs({ currentWorkspace }),
          botsService.getBotStates(),
        ]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setWorkspaceRefs(nextWorkspaces);
      setBotStates(nextBotStates);
      setConfigLoaded(true);
      setSelectedBotId((current) =>
        creatingBot ? current : (current ?? nextConfig.bots[0]?.id ?? null),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] Failed to load bots config", message);
      toast(intl.formatMessage({ id: "bots.loadFailed" }, { error: message }));
    }
  }, [botsService, creatingBot, currentWorkspace, intl]);

  useEffect(() => {
    if (
      !open ||
      selectedBot?.provider !== "weixin" ||
      !selectedBot.credentialRef ||
      selectedBotState?.weixinActivatedAt
    ) {
      return undefined;
    }
    let cancelled = false;
    const pollActivationState = async () => {
      try {
        const nextBotStates = await botsService.getBotStates();
        if (!cancelled) {
          setBotStates(nextBotStates);
        }
      } catch (error) {
        logger.warn(
          "[BotsDialog] Failed to poll WeChat bot activation state",
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    const timer = window.setInterval(() => {
      void pollActivationState();
    }, 2000);
    void pollActivationState();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    botsService,
    open,
    selectedBot?.credentialRef,
    selectedBot?.id,
    selectedBot?.provider,
    selectedBotState?.weixinActivatedAt,
  ]);

  useEffect(() => {
    if (open) {
      setConfigLoaded(false);
      void refresh();
    }
  }, [open, refresh]);

  useEffect(() => {
    handledEntryProviderRef.current = null;
  }, [entryProvider, open]);

  const saveBot = useCallback(
    async (bot: BotConfig, secrets?: { credentialValue?: string }) => {
      const saved = await botsService.saveBot({
        bot,
        credentialValue: secrets?.credentialValue,
      });
      setConfig((previous) => ({
        ...previous,
        bots: [...previous.bots.filter((item) => item.id !== saved.id), saved],
      }));
      setSelectedBotId(saved.id);
      setCreatingBot(false);
      setCredentialValue("");
      void refresh();
      return saved;
    },
    [botsService, refresh],
  );

  const createBindCodeForBot = useCallback(
    async (bot: BotConfig) => {
      const createdAt = Date.now();
      const result = await botsService.createBindCode({
        botId: bot.id,
        ttlMs: BIND_CODE_TTL_MS,
        allowedWorkspaces: bot.allowedWorkspaces,
      });
      setNowMs(createdAt);
      setBindCode({
        botId: bot.id,
        code: result.code,
        createdAt,
        expiresAt: result.expiresAt,
        ttlMs: Math.max(1, result.expiresAt - createdAt),
      });
    },
    [botsService],
  );

  useEffect(() => {
    const registration = feishuRegistration;
    if (
      !open ||
      !selectedBot ||
      !isFeishuBotProvider(selectedBot.provider) ||
      !registration
    ) {
      return undefined;
    }
    if (registration.status !== "pending") {
      return undefined;
    }

    let cancelled = false;
    const pollIntervalMs = Math.max(1, registration.interval) * 1000;

    const pollRegistration = async () => {
      try {
        const result = await botsService.pollFeishuRegistration({
          deviceCode: registration.deviceCode,
          domain: registration.domain,
          pollDomain: registration.pollDomain,
        });
        if (cancelled) {
          return;
        }
        if (result.status === "pending") {
          setFeishuRegistration((current) => {
            if (current?.deviceCode !== registration.deviceCode) {
              return current;
            }
            if (
              current.interval === result.interval &&
              current.domain === result.domain &&
              current.pollDomain === result.pollDomain
            ) {
              return current;
            }
            // Bugfix: pending poll results are usually unchanged; creating a fresh object every
            // time would flip effect dependencies, instantly restart polling, and cause a
            // millisecond-scale RPC storm.
            return {
              ...current,
              interval: result.interval,
              domain: result.domain,
              pollDomain: result.pollDomain,
            };
          });
          return;
        }
        if (result.status === "success") {
          // Bugfix: the service layer always supported Feishu QR registration, but the reworked
          // Bots UI only kept manual credentials. Reuse the saveBot secret write path on QR
          // success so the app secret never lands in a plaintext config file.
          const savedBot = await saveBot(
            {
              ...selectedBot,
              provider: selectedBot.provider,
              name: result.appName?.trim() || selectedBot.name,
              feishuAppId: result.appId,
            },
            { credentialValue: result.appSecret },
          );
          if (!cancelled) {
            // Bugfix: a successful Feishu/Lark QR scan only completes app credential onboarding;
            // the bind code comes from the shared "has credentials, not yet bound" state machine.
            // Only collapse the QR so it and the /bind panel do not fight for focus in one update.
            setConfig((previous) => ({
              ...previous,
              bots: previous.bots.map((bot) =>
                bot.id === savedBot.id ? savedBot : bot,
              ),
            }));
            setFeishuRegistration(null);
            toast(intl.formatMessage({ id: "bots.feishuRegistrationSuccess" }));
          }
          return;
        }
        setFeishuRegistration((current) =>
          current?.deviceCode === registration.deviceCode
            ? {
                ...current,
                status: result.status,
                message:
                  result.message ??
                  intl.formatMessage({
                    id: `bots.feishuRegistration.${result.status}`,
                  }),
              }
            : current,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] Failed to poll Feishu QR registration", message);
        if (!cancelled) {
          setFeishuRegistration((current) =>
            current?.deviceCode === registration.deviceCode
              ? { ...current, status: "error", message }
              : current,
          );
        }
      }
    };

    const timer = window.setInterval(() => {
      void pollRegistration();
    }, pollIntervalMs);
    void pollRegistration();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    botsService,
    createBindCodeForBot,
    feishuRegistration,
    intl,
    open,
    saveBot,
    selectedBot,
  ]);

  useEffect(() => {
    const registration = weixinRegistration;
    if (
      !open ||
      !selectedBot ||
      selectedBot.provider !== "weixin" ||
      !registration
    ) {
      return undefined;
    }
    if (
      registration.status !== "pending" &&
      registration.status !== "scanned"
    ) {
      return undefined;
    }

    let cancelled = false;
    let timer: number | undefined;
    const pollIntervalMs = Math.max(1, registration.interval) * 1000;

    const scheduleNextPoll = () => {
      if (cancelled) {
        return;
      }
      timer = window.setTimeout(() => {
        void runPoll();
      }, pollIntervalMs);
    };

    const pollRegistration = async () => {
      try {
        const result = await botsService.pollWeixinRegistration({
          qrCode: registration.qrCode,
        });
        if (cancelled) {
          return;
        }
        if (result.status === "pending" || result.status === "scanned") {
          setWeixinRegistration((current) => {
            if (current?.qrCode !== registration.qrCode) {
              return current;
            }
            if (
              current.interval === result.interval &&
              current.status === result.status
            ) {
              return current;
            }
            return {
              ...current,
              interval: result.interval,
              status: result.status,
            };
          });
          return;
        }
        if (result.status === "success") {
          await saveBot(
            {
              ...selectedBot,
              webhookUrl: undefined,
              providerUserId: result.botId ?? selectedBot.providerUserId,
              displayName: result.botId ?? selectedBot.displayName,
              name: selectedBot.name,
            },
            { credentialValue: result.botToken },
          );
          if (!cancelled) {
            // Bugfix: a successful WeChat QR scan completes the connection; keeping the QR
            // registration state would show a stale scan panel. Clearing it switches the bot
            // token row to the connected Unbind action.
            setWeixinRegistration(null);
            toast(intl.formatMessage({ id: "bots.weixinRegistrationSuccess" }));
          }
          cancelled = true;
          return;
        }
        setWeixinRegistration((current) =>
          current?.qrCode === registration.qrCode
            ? {
                ...current,
                status: result.status,
                message:
                  ("message" in result ? result.message : undefined) ??
                  intl.formatMessage({
                    id: `bots.weixinRegistration.${result.status}`,
                  }),
              }
            : current,
        );
        cancelled = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] Failed to poll WeChat QR login", message);
      }
    };

    const runPoll = async () => {
      await pollRegistration();
      scheduleNextPoll();
    };

    // Bugfix: the WeChat QR status endpoint long-polls; setInterval would pile up RPCs while the
    // previous request is still in flight. Serial polling avoids consecutive timeouts and results
    // overwriting each other's UI state.
    void runPoll();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [botsService, intl, open, saveBot, selectedBot, weixinRegistration]);

  const patchSelectedBot = useCallback(
    (patch: Partial<BotConfig>) => {
      if (!selectedBot) return;
      void saveBot({ ...selectedBot, ...patch });
    },
    [saveBot, selectedBot],
  );

  const startBotNameRename = useCallback(() => {
    if (!selectedBot) return;
    setRenamingBotId(selectedBot.id);
    setBotNameDraft({ botId: selectedBot.id, value: selectedBot.name });
  }, [selectedBot]);

  const commitBotNameDraft = useCallback(() => {
    if (!selectedBot) return;
    const nextName = selectedBotName.trim();
    setBotNameDraft(null);
    setRenamingBotId(null);
    if (nextName === selectedBot.name) return;
    // Bugfix: saving on every keystroke lets the service-side trim eat trailing spaces, blocking
    // names that contain spaces; save on commit and keep a local draft while typing. An empty
    // name is a valid unnamed state; the display layer falls back to a localized default name.
    void saveBot({ ...selectedBot, name: nextName });
  }, [saveBot, selectedBot, selectedBotName]);

  const handleBotNameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        if (
          isImeComposingKeyEvent({
            compositionActive: botNameCompositionActiveRef.current,
            nativeEvent: event.nativeEvent,
          })
        ) {
          // Bugfix: Enter during IME composition confirms a candidate, not the rename.
          // Avoid triggering blur, which would run commitBotNameDraft.
          logger.debug("[BotsDialog] ignore bot name enter during IME", {
            botId: selectedBot?.id ?? null,
          });
          return;
        }
        event.currentTarget.blur();
        return;
      }
      if (event.key === "Escape") {
        // Bugfix: Escape in the rename input must only cancel editing, not bubble into the Dialog close shortcut.
        setBotNameDraft(null);
        setRenamingBotId(null);
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [selectedBot?.id],
  );

  const handleDialogEscapeKeyDown = useCallback(
    (event: Event) => {
      if (renamingBotId === null) return;
      // Bugfix: Radix Dialog handles Escape close before the input's React onKeyDown bubbles.
      // While renaming, intercept at the Dialog close path: Esc cancels editing only.
      event.preventDefault();
      setBotNameDraft(null);
      setRenamingBotId(null);
    },
    [renamingBotId],
  );

  const patchAllowedWorkspaces = useCallback(
    async (allowedWorkspaces: string[]) => {
      if (!selectedBot) return;
      setWorkspaceAccessSaving(true);
      const normalizedAllowedWorkspaces =
        allowedWorkspaces.length > 0 ? allowedWorkspaces : [ALL_BOT_WORKSPACES];
      const previousBot = selectedBot;
      const optimisticBot = {
        ...selectedBot,
        allowedWorkspaces: normalizedAllowedWorkspaces,
      };
      setConfig((previous) => ({
        ...previous,
        bots: previous.bots.map((bot) =>
          bot.id === optimisticBot.id ? optimisticBot : bot,
        ),
      }));
      try {
        await saveBot(optimisticBot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] Failed to save workspace access scope", message);
        setConfig((previous) => ({
          ...previous,
          bots: previous.bots.map((bot) =>
            bot.id === previousBot.id ? previousBot : bot,
          ),
        }));
        toast(
          intl.formatMessage({ id: "bots.saveFailed" }, { error: message }),
        );
      } finally {
        setWorkspaceAccessSaving(false);
      }
    },
    [intl, saveBot, selectedBot],
  );

  const toggleWorkspaceAccess = useCallback(
    async (workspaceId: string, checked: boolean) => {
      if (!selectedBot) return;
      const currentAllowed = isAllWorkspacesAllowed(
        selectedBot.allowedWorkspaces,
      )
        ? workspaceRefs.map((workspace) => workspace.id)
        : selectedBot.allowedWorkspaces;
      const nextAllowed = checked
        ? [...new Set([...currentAllowed, workspaceId])]
        : currentAllowed.filter((id) => id !== workspaceId);
      await patchAllowedWorkspaces(nextAllowed);
    },
    [patchAllowedWorkspaces, selectedBot, workspaceRefs],
  );

  const handleBeginAddBot = () => {
    setCreatingBot(true);
    setCreatingProvider(null);
    setSelectedBotId(null);
    setCredentialValue("");
    setFeishuRegistration(null);
    setWeixinRegistration(null);
  };

  const handleAddBot = useCallback(
    async (provider: BotProvider) => {
      if (creatingProvider) return;
      setCreatingProvider(provider);
      const bot = createDraftBot({
        provider,
      });
      try {
        await saveBot({
          ...bot,
          name: "",
          ...(provider === "webhook"
            ? { webhookAuthHeaderName: "x-zcode-bot-secret" }
            : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] Failed to create bot", message);
        toast(
          intl.formatMessage({ id: "bots.saveFailed" }, { error: message }),
        );
      } finally {
        setCreatingProvider(null);
      }
    },
    [creatingProvider, intl, saveBot],
  );

  useEffect(() => {
    if (!open || !entryProvider || !configLoaded) {
      return;
    }
    if (handledEntryProviderRef.current === entryProvider) {
      return;
    }

    const entry = resolveBotProviderEntry(config.bots, entryProvider);
    handledEntryProviderRef.current = entryProvider;
    setCredentialValue("");
    setFeishuRegistration(null);
    setWeixinRegistration(null);

    if (entry.mode === "select") {
      setCreatingBot(false);
      setCreatingProvider(null);
      setSelectedBotId(entry.botId);
      return;
    }

    // Bugfix: after the remote-control dialog gained a Bot Channel shortcut, entering BotsDialog
    // must not land on the empty selection page. Decide and create only after config loads, so a
    // not-yet-refreshed bot list cannot duplicate the bot.
    setCreatingBot(true);
    setSelectedBotId(null);
    void handleAddBot(entry.provider);
  }, [config.bots, configLoaded, entryProvider, handleAddBot, open]);

  const handleCreateBindCode = async () => {
    if (!selectedBot) return;
    await createBindCodeForBot(selectedBot);
  };

  const handleSaveSecret = async () => {
    if (!selectedBot || secretSaving) return;
    setSecretSaving(true);
    try {
      await saveBot(selectedBot, { credentialValue });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] Failed to save bot secret", message);
      toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
    } finally {
      setSecretSaving(false);
    }
  };

  const handleStartFeishuRegistration = useCallback(async () => {
    if (!selectedBot || !isFeishuBotProvider(selectedBot.provider)) return;
    setFeishuRegistrationLoading(true);
    try {
      const result = await botsService.beginFeishuRegistration({
        domain: selectedBot.provider,
      });
      let qrDataUrl: string | null = null;
      try {
        qrDataUrl = await QRCode.toDataURL(result.qrUrl, {
          margin: 1,
          width: 220,
        });
      } catch (error) {
        logger.error(
          "[BotsDialog] Failed to generate Feishu registration QR code",
          error instanceof Error ? error.message : String(error),
        );
      }
      setFeishuRegistration({
        botId: selectedBot.id,
        deviceCode: result.deviceCode,
        qrUrl: result.qrUrl,
        qrDataUrl,
        userCode: result.userCode,
        interval: result.interval,
        expiresAt: result.expiresAt,
        domain: result.domain,
        pollDomain: result.pollDomain,
        status: "pending",
      });
      toast(intl.formatMessage({ id: "bots.feishuRegistrationStarted" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] Failed to start Feishu QR registration", message);
      toast(
        intl.formatMessage(
          { id: "bots.feishuRegistrationFailed" },
          { error: message },
        ),
      );
    } finally {
      setFeishuRegistrationLoading(false);
    }
  }, [botsService, intl, selectedBot]);

  const handleStartWeixinRegistration = useCallback(async () => {
    if (!selectedBot || selectedBot.provider !== "weixin") return;
    setWeixinRegistrationLoading(true);
    try {
      const result = await botsService.beginWeixinRegistration();
      let qrDataUrl: string | null = null;
      try {
        qrDataUrl = await QRCode.toDataURL(result.qrUrl, {
          margin: 1,
          width: 220,
        });
      } catch (error) {
        logger.error(
          "[BotsDialog] Failed to generate WeChat login QR code",
          error instanceof Error ? error.message : String(error),
        );
      }
      setWeixinRegistration({
        botId: selectedBot.id,
        qrCode: result.qrCode,
        qrUrl: result.qrUrl,
        qrDataUrl,
        interval: result.interval,
        expiresAt: result.expiresAt,
        status: "pending",
      });
      toast(intl.formatMessage({ id: "bots.weixinRegistrationStarted" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] Failed to start WeChat QR login", message);
      toast(
        intl.formatMessage(
          { id: "bots.weixinRegistrationFailed" },
          { error: message },
        ),
      );
    } finally {
      setWeixinRegistrationLoading(false);
    }
  }, [botsService, intl, selectedBot]);

  useEffect(() => {
    if (!open || creatingBot || !selectedBot) {
      return;
    }

    if (isFeishuBotProvider(selectedBot.provider)) {
      if (!selectedBot.credentialRef) {
        if (feishuRegistrationLoading) {
          return;
        }
        if (feishuRegistration?.botId === selectedBot.id) {
          return;
        }

        const autoKey = `${selectedBot.id}:feishu-registration`;
        if (autoQrStartedBotIdsRef.current.has(autoKey)) {
          return;
        }

        // Bugfix: a Feishu/Lark bot without a token shows only the "Scan QR" button on first
        // open, reading as an extra required step; auto-start the QR flow once so the
        // missing-credentials default state is actionable immediately.
        autoQrStartedBotIdsRef.current.add(autoKey);
        void handleStartFeishuRegistration();
        return;
      }

      if (!selectedBot.providerUserId) {
        if (bindCode?.botId === selectedBot.id && !bindExpired) {
          return;
        }
        if (autoBindCreatingBotIdsRef.current.has(selectedBot.id)) {
          return;
        }

        // Bugfix: Feishu/Lark onboarding splits credentials and chat binding; with credentials
        // but no binding, auto-show /bind. Bind codes now last 30s, so mint a fresh one when the
        // old code would interrupt the automatic binding flow.
        autoBindCreatingBotIdsRef.current.add(selectedBot.id);
        void createBindCodeForBot(selectedBot).finally(() => {
          autoBindCreatingBotIdsRef.current.delete(selectedBot.id);
        });
      }
      return;
    }

    if (selectedBot.provider === "telegram") {
      if (!selectedBot.credentialRef || selectedBot.providerUserId) {
        return;
      }
      if (bindCode?.botId === selectedBot.id && !bindExpired) {
        return;
      }
      if (autoBindCreatingBotIdsRef.current.has(selectedBot.id)) {
        return;
      }

      // Bugfix: Telegram splits onboarding into credentials and direct-chat binding like
      // Feishu/Lark; auto-show /bind after the token is saved and refresh expired bind codes so
      // the 30s TTL never leaves the user stuck on a dead code.
      autoBindCreatingBotIdsRef.current.add(selectedBot.id);
      void createBindCodeForBot(selectedBot).finally(() => {
        autoBindCreatingBotIdsRef.current.delete(selectedBot.id);
      });
      return;
    }

    if (selectedBot.provider !== "weixin") {
      return;
    }
    if (selectedBot.credentialRef || weixinRegistrationLoading) {
      return;
    }
    if (weixinRegistration?.botId === selectedBot.id) {
      return;
    }

    const autoKey = `${selectedBot.id}:weixin-registration`;
    if (autoQrStartedBotIdsRef.current.has(autoKey)) {
      return;
    }

    // Bugfix: a WeChat bot without token/binding state needs the login QR immediately, otherwise
    // a fresh bot only exposes the button and breaks the "scan to connect" primary flow.
    autoQrStartedBotIdsRef.current.add(autoKey);
    void handleStartWeixinRegistration();
  }, [
    creatingBot,
    feishuRegistration,
    feishuRegistrationLoading,
    bindCode,
    bindExpired,
    createBindCodeForBot,
    handleStartFeishuRegistration,
    handleStartWeixinRegistration,
    open,
    selectedBot,
    weixinRegistration,
    weixinRegistrationLoading,
  ]);

  const handleOpenTelegramBotFather = () => {
    platform.openExternal(TELEGRAM_BOTFATHER_URL);
  };

  const copyBindCommand = async () => {
    if (!bindCode || bindExpired) return;
    const command = `/bind ${bindCode.code}`;
    await navigator.clipboard?.writeText(command).catch((error: unknown) => {
      logger.warn(
        "[BotsDialog] Failed to copy bind command",
        error instanceof Error ? error.message : String(error),
      );
    });
    toast(intl.formatMessage({ id: "bots.bindCommandCopied" }));
  };

  const handleUnbind = async () => {
    if (!selectedBot) return;
    await saveBot({
      ...selectedBot,
      providerUserId: undefined,
      displayName: undefined,
    });
    await botsService.resetBotState(selectedBot.id);
  };

  const handleRemoveSecret = async () => {
    if (!selectedBot) return;
    try {
      const saved = await botsService.removeBotSecret(selectedBot.id);
      autoQrStartedBotIdsRef.current.delete(
        `${selectedBot.id}:feishu-registration`,
      );
      autoQrStartedBotIdsRef.current.delete(
        `${selectedBot.id}:weixin-registration`,
      );
      autoBindCreatingBotIdsRef.current.delete(selectedBot.id);
      setConfig((previous) => ({
        ...previous,
        bots: previous.bots.map((item) =>
          item.id === saved.id ? saved : item,
        ),
      }));
      setCredentialValue("");
      setBindCode(null);
      void refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] Failed to remove bot secret", message);
      toast(
        intl.formatMessage(
          { id: "bots.removeSecretFailed" },
          { error: message },
        ),
      );
    }
  };

  const handleDelete = async () => {
    if (!selectedBot) return;
    // Bugfix: deleting a bot had no confirmation, so an accidental click dropped credentials and
    // the binding entry. Reuse the project-wide ConfirmDialog to stay consistent with other
    // settings pages for destructive actions.
    const confirmed = await confirmDialog({
      title: intl.formatMessage(
        { id: "bots.deleteConfirmTitle" },
        { name: formatBotDisplayName(selectedBot.name, fallbackBotName) },
      ),
      description: intl.formatMessage({ id: "bots.deleteConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "bots.delete" }),
    });
    if (!confirmed) return;

    try {
      await botsService.deleteBot(selectedBot.id);
      setSelectedBotId(null);
      void refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] Failed to delete bot", message);
      toast(
        intl.formatMessage({ id: "bots.deleteFailed" }, { error: message }),
      );
    }
  };

  const selectedRuntime = selectedBot
    ? status?.botRuntime.find((item) => item.botId === selectedBot.id)
    : undefined;
  const formatChannelName = (provider: BotProviderEntryId) =>
    intl.formatMessage({ id: `bots.channel.${provider}` });
  const renderChannelName = (provider: BotProviderEntryId) => {
    const regionTagLabelId = getBotProviderRegionTagLabelId(provider);

    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate">{formatChannelName(provider)}</span>
        {regionTagLabelId ? (
          <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
            {intl.formatMessage({ id: regionTagLabelId })}
          </span>
        ) : null}
      </span>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[calc(100vh-6rem)] max-h-168 max-w-4xl flex-col overflow-hidden rounded-2xl"
        onEscapeKeyDown={handleDialogEscapeKeyDown}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Bot className="size-5 text-foreground" />
            <DialogTitle className="text-lg font-medium text-foreground">
              {intl.formatMessage({ id: "bots.title" })}
            </DialogTitle>
            <DialogDescription className="ml-3">
              {intl.formatMessage({ id: "bots.description" })}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-3">
          <aside className="flex w-64 shrink-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={handleBeginAddBot}
                className="mb-3 w-full justify-start gap-2 rounded-xl"
              >
                <Plus className="size-4" />
                <span className="min-w-0 truncate">
                  {intl.formatMessage({ id: "bots.addBot" })}
                </span>
              </Button>
              {config.bots.length === 0 ? (
                <div className="p-4 text-ui-base text-foreground-subtle">
                  {creatingBot
                    ? intl.formatMessage({
                        id: "bots.newBot.selectProviderHint",
                      })
                    : intl.formatMessage({ id: "bots.empty" })}
                </div>
              ) : (
                config.bots.map((bot) => {
                  const runtime = status?.botRuntime.find(
                    (item) => item.botId === bot.id,
                  );
                  const selected = bot.id === selectedBotId;
                  return (
                    <button
                      key={bot.id}
                      type="button"
                      onClick={() => {
                        setCreatingBot(false);
                        setSelectedBotId(bot.id);
                      }}
                      className={cn(
                        "mb-1 w-full rounded-xl px-2.5 pr-4 py-3 text-left transition-colors",
                        selected
                          ? "bg-surface-hover text-foreground"
                          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <ProviderIcon
                          provider={bot.provider}
                          className="size-10 shrink-0 object-contain text-foreground-subtle"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-foreground truncate text-ui-base font-medium">
                            {formatBotDisplayName(bot.name, fallbackBotName)}
                          </span>
                          <span className="mt-0.5 flex min-w-0 text-ui-base text-foreground-subtle">
                            {renderChannelName(bot.provider)}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            runtimeDot(runtime, bot.enabled),
                          )}
                        />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-border bg-background p-4">
            {creatingBot ? (
              <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-start gap-6">
                <div className="space-y-2">
                  <div className="text-ui-lg font-medium">
                    {intl.formatMessage({ id: "bots.newBot.title" })}
                  </div>
                  <p className="max-w-2xl text-ui-base leading-6 text-foreground-subtle">
                    {intl.formatMessage({ id: "bots.newBot.description" })}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {BOT_PROVIDERS.filter(
                    (provider) => provider.id !== "webhook",
                  ).map((provider) => {
                    const implemented = provider.implemented;
                    const isCreatingThisProvider =
                      creatingProvider === provider.id;
                    const isCreatingAnyProvider = creatingProvider !== null;
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        disabled={!implemented || isCreatingAnyProvider}
                        aria-busy={isCreatingThisProvider}
                        onClick={() =>
                          implemented
                            ? void handleAddBot(provider.id)
                            : undefined
                        }
                        className={cn(
                          "flex items-start gap-3 rounded-lg border border-card-border bg-card py-4 px-3 text-left transition-colors",
                          implemented && !isCreatingAnyProvider
                            ? "hover:border-input-border-focused hover:bg-surface-hover"
                            : "cursor-not-allowed opacity-60",
                          isCreatingThisProvider &&
                            "border-input-border-focused bg-surface-hover opacity-100",
                        )}
                      >
                        {isCreatingThisProvider ? (
                          <div className="flex size-10 items-center justify-center">
                            <Loader2 className="size-6 shrink-0 animate-spin text-foreground-subtle" />
                          </div>
                        ) : (
                          <ProviderIcon
                            provider={provider.id}
                            className="size-10 shrink-0 text-foreground"
                          />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 text-ui-lg font-medium">
                            {renderChannelName(provider.id)}
                          </span>
                          <span className="mt-1 block text-ui-base text-foreground-subtle">
                            {implemented
                              ? intl.formatMessage({
                                  id: `bots.newBot.providerDescription.${provider.id}`,
                                })
                              : intl.formatMessage({
                                  id: "bots.newBot.comingSoon",
                                })}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : !selectedBot ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-ui-base text-foreground-subtle">
                <Bot className="size-8" />
                <div>{intl.formatMessage({ id: "bots.empty" })}</div>
                <Button variant="outline" size="lg" onClick={handleBeginAddBot}>
                  <Plus className="size-4" />
                  {intl.formatMessage({ id: "bots.addBot" })}
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <BotSummaryCard
                  bot={selectedBot}
                  runtime={selectedRuntime}
                  selectedBotDisplayName={selectedBotDisplayName}
                  selectedBotName={selectedBotName}
                  fallbackBotName={fallbackBotName}
                  renaming={renamingBotId === selectedBot.id}
                  onStartRename={startBotNameRename}
                  onCommitNameDraft={commitBotNameDraft}
                  onNameDraftChange={(value) =>
                    setBotNameDraft({ botId: selectedBot.id, value })
                  }
                  onNameCompositionEnd={() => {
                    botNameCompositionActiveRef.current = false;
                  }}
                  onNameCompositionStart={() => {
                    botNameCompositionActiveRef.current = true;
                  }}
                  onNameInputKeyDown={handleBotNameKeyDown}
                  onPatchBot={patchSelectedBot}
                />

                <ProviderSettingsCard
                  bot={selectedBot}
                  runtime={selectedRuntime}
                  credentialValue={credentialValue}
                  bindCode={bindCode}
                  bindExpired={bindExpired}
                  bindRemainingMs={bindRemainingMs}
                  bindCountdownProgress={bindCountdownProgress}
                  feishuRegistration={feishuRegistration}
                  feishuRegistrationLoading={feishuRegistrationLoading}
                  weixinRegistration={weixinRegistration}
                  weixinRegistrationLoading={weixinRegistrationLoading}
                  weixinActivated={Boolean(selectedBotState?.weixinActivatedAt)}
                  secretSaving={secretSaving}
                  onCredentialValueChange={setCredentialValue}
                  onSaveSecret={() => void handleSaveSecret()}
                  onRemoveSecret={() => void handleRemoveSecret()}
                  onOpenTelegramBotFather={handleOpenTelegramBotFather}
                  onStartWeixinRegistration={() =>
                    void handleStartWeixinRegistration()
                  }
                  onStartFeishuRegistration={() =>
                    void handleStartFeishuRegistration()
                  }
                  onCreateBindCode={() => void handleCreateBindCode()}
                  onUnbind={() => void handleUnbind()}
                  onCopyBindCommand={() => void copyBindCommand()}
                />

                <SettingsGroupCard>
                  <BotReplyGranularityCard
                    bot={selectedBot}
                    onPatchBot={patchSelectedBot}
                  />

                  {/*
                    Command permission editing is intentionally not exposed for now, so users cannot
                    disable key commands before the bot works. To restore the UI, render
                    selectedBot.allowedCommands and save via patchSelectedBot.
                  */}

                  <WorkspaceAccessCard
                    bot={selectedBot}
                    workspaceRefs={workspaceRefs}
                    currentWorkspace={currentWorkspace}
                    loading={workspaceAccessSaving}
                    onPatchAllowedWorkspaces={patchAllowedWorkspaces}
                    onToggleWorkspaceAccess={toggleWorkspaceAccess}
                  />
                </SettingsGroupCard>

                <BotDangerCard onDelete={() => void handleDelete()} />
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
