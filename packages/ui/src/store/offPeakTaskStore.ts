import { create } from "zustand";
import {
  normalizeProviderFamilyDomain,
  type AppSettings,
  type OffPeakCodingPlanSupport,
  type OffPeakTaskCreateResult,
  type OffPeakTakeNumberAvailability,
  type ZCodeOffPeakTask,
  type ModelSelection,
} from "@zcode/shared";
import type {
  ICodingPlanSubscriptionService,
  IOffPeakTaskService,
  OffPeakClientConfig,
} from "@zcode/services";
import { logger } from "@/logger.js";

// Off-peak task store (independent of automationManagementStore): all access via the IOffPeakTaskService RPC.
// Order/status refresh by list polling (host offPeakTaskSync writes sqlite; the renderer reads snapshots only).

interface CreateOffPeakTaskInput {
  title: string;
  prompt: string;
  /** The four permission tiers (build/edit/plan/yolo); narrowing happens at the server argument boundary. */
  permissionMode: string;
  modelSelection: ModelSelection;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface UpdateOffPeakTaskInput {
  title?: string;
  prompt?: string;
  permissionMode?: string;
  modelSelection?: ModelSelection | null;
}

/** Prefill draft carried from a New-task template card into the Automations create form (template = prefill). */
export interface OffPeakCreateDraft {
  title?: string;
  prompt?: string;
  telemetrySource?: {
    eventRegion: "app.session" | "app.automations";
    templateId: string;
  };
}

/** The availability request state is separate from the server quota snapshot; only ready + canTakeNumber=true admits. */
export type OffPeakTakeNumberAvailabilityStatus = "idle" | "loading" | "ready" | "error";

interface OffPeakTaskState {
  tasks: ZCodeOffPeakTask[];
  loading: boolean;
  error: string | null;
  operationId: string | null;
  /** Rollout config: null = not loaded. No hit/disabled means the entry is not rendered at all. */
  grayConfig: OffPeakClientConfig | null;
  /** Redacted credential-support snapshot for the selected provider/connection; no JWT/API keys inside. */
  codingPlanSupport: OffPeakCodingPlanSupport | null;
  /** Live server number-taking quota snapshot; null = no successful response yet. */
  takeNumberAvailability: OffPeakTakeNumberAvailability | null;
  /** loading/idle/error all block entry, so a dependency failure is never mistaken for creatable. */
  takeNumberAvailabilityStatus: OffPeakTakeNumberAvailabilityStatus;
  /** Whether the New-task banner was dismissed this session (returns after the next login/restart). */
  newTaskBannerDismissed: boolean;
  /** Template-card -> create-form prefill draft (one-shot across navigation). */
  pendingCreateDraft: OffPeakCreateDraft | null;
  initialize(deps: {
    offPeakTaskService: IOffPeakTaskService;
    codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  }): Promise<void>;
  refresh(service: IOffPeakTaskService): Promise<void>;
  refreshCodingPlanSupport(service: IOffPeakTaskService, freshnessKey?: string): Promise<void>;
  refreshTakeNumberAvailability(service: IOffPeakTaskService): Promise<void>;
  createTask(
    input: CreateOffPeakTaskInput,
    service: IOffPeakTaskService,
  ): Promise<OffPeakTaskCreateResult>;
  updateTask(
    offPeakTaskId: string,
    input: UpdateOffPeakTaskInput,
    service: IOffPeakTaskService,
  ): Promise<boolean>;
  pauseTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  continueTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  cancelTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  deleteTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  deleteHistory(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  dismissNewTaskBanner(): void;
  /** Template-card click: stage the prefill draft for the Automations create form (cleared on consume). */
  setPendingCreateDraft(draft: OffPeakCreateDraft): void;
  consumePendingCreateDraft(): OffPeakCreateDraft | null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** support must still match the renderer current selection; a stale true snapshot after a switch must not briefly open creation. */
export function isCurrentOffPeakCodingPlanSupported(
  support: OffPeakCodingPlanSupport | null,
  settings:
    | Pick<AppSettings, "providerFamilyConnectionSelections" | "providerFamilyDomain">
    | null
    | undefined,
): boolean {
  if (!support?.supported || !settings) return false;
  const providerFamily = normalizeProviderFamilyDomain(settings.providerFamilyDomain);
  if (!providerFamily || providerFamily !== support.providerFamily) return false;
  const selection = settings.providerFamilyConnectionSelections?.[providerFamily];
  if (selection?.kind === "individual-coding-plan") {
    return support.kind === `${providerFamily}-personal`;
  }
  if (selection?.kind === "team-coding-plan") {
    return support.kind === `${providerFamily}-team`;
  }
  return false;
}

/** Server 3103 (number-taking limit) is recognized by structured kind only; no cross-RPC error-text parsing. */
function isOffPeakQuotaError(result: OffPeakTaskCreateResult | null | undefined): boolean {
  return (
    result?.ok === false && result.errorCategory === "quota_3103" && result.errorCode === "3103"
  );
}

type OffPeakCreateErrorMessageId =
  | "offPeak.error.quota"
  | "offPeak.error.unavailable"
  | "offPeak.error.generic";

/** Creation failure maps only from explicit server business codes; raw RPC text stays in logs, never shown directly. */
export function resolveOffPeakCreateErrorMessageId(
  result: OffPeakTaskCreateResult | null | undefined,
): OffPeakCreateErrorMessageId {
  if (isOffPeakQuotaError(result)) return "offPeak.error.quota";
  if (
    result?.ok === false &&
    (result.errorCategory === "network" ||
      result.errorCategory === "invalid_response" ||
      result.errorCategory === "unknown")
  ) {
    return "offPeak.error.unavailable";
  }
  return "offPeak.error.generic";
}

let initializeInFlight: Promise<void> | null = null;
let initializationReady: Promise<void> = Promise.resolve();
let eligibilityInFlight: Promise<void> | null = null;
let eligibilityGeneration = 0;
let pendingEligibilityService: IOffPeakTaskService | null = null;
let lastEligibilityTrigger: { service: IOffPeakTaskService; key: string } | null = null;

export const useOffPeakTaskStore = create<OffPeakTaskState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  operationId: null,
  grayConfig: null,
  codingPlanSupport: null,
  takeNumberAvailability: null,
  takeNumberAvailabilityStatus: "idle",
  newTaskBannerDismissed: false,
  pendingCreateDraft: null,

  async initialize({ offPeakTaskService, codingPlanSubscriptionService }) {
    // Root cause: New Task and Automations can overlap mounts across page switches; two initializes
    // request the same Team Plan availability concurrently and a later global 429 can overwrite an earlier success.
    // Store-level single-flight guarantees one complete admission check for every entry.
    if (initializeInFlight) return initializeInFlight;
    set({ loading: true, error: null });
    // Init and later notifications share the eligibility check; once the rollout is ready, eligibility and quota must not be written by two async chains.
    initializationReady = Promise.all([
      codingPlanSubscriptionService
        .getOffPeakClientConfig({ forceRefresh: true })
        .catch((error) => {
          logger.warn("[off-peak] gray config load failed", toErrorMessage(error));
          return null;
        }),
      offPeakTaskService.list().catch((error) => {
        logger.warn("[off-peak] list failed", toErrorMessage(error));
        return [] as ZCodeOffPeakTask[];
      }),
    ]).then(([grayConfig, tasks]) => {
      set({ grayConfig, tasks });
    });
    const run = get().refreshCodingPlanSupport(offPeakTaskService);
    initializeInFlight = run;
    try {
      await run;
    } finally {
      if (initializeInFlight === run) {
        initializeInFlight = null;
        set({ loading: false });
      }
    }
  },

  async refresh(service) {
    try {
      const tasks = await service.list();
      set({ tasks, error: null });
    } catch (error) {
      set({ error: toErrorMessage(error) });
    }
  },

  refreshCodingPlanSupport(service, freshnessKey) {
    // Both entries check a given Registry/connection notice once; manual refresh has no key and always rechecks.
    if (
      freshnessKey !== undefined &&
      lastEligibilityTrigger?.service === service &&
      lastEligibilityTrigger.key === freshnessKey
    ) {
      return eligibilityInFlight ?? Promise.resolve();
    }
    lastEligibilityTrigger = freshnessKey === undefined ? null : { service, key: freshnessKey };
    eligibilityGeneration += 1;
    pendingEligibilityService = service;
    set({
      codingPlanSupport: null,
      takeNumberAvailability: null,
      takeNumberAvailabilityStatus: "loading",
    });
    if (eligibilityInFlight) return eligibilityInFlight;
    // The legacy independent support/availability requests used to overwrite out of order. Serial draining merges in-flight changes;
    // stale successes and failures are dropped, and one complete generation of eligibility + quota publishes together.
    eligibilityInFlight = Promise.resolve().then(async () => {
      try {
        while (pendingEligibilityService) {
          const currentService = pendingEligibilityService;
          const generation = eligibilityGeneration;
          pendingEligibilityService = null;
          await initializationReady;
          if (generation !== eligibilityGeneration) continue;
          try {
            const codingPlanSupport = await currentService.getCodingPlanSupport();
            if (generation !== eligibilityGeneration) continue;
            const grayConfig = get().grayConfig;
            const shouldReadAvailability =
              grayConfig?.enabled &&
              (grayConfig.codingPlanActive === true || codingPlanSupport.supported === true);
            const takeNumberAvailability = shouldReadAvailability
              ? await currentService.getTakeNumberAvailability()
              : null;
            if (generation !== eligibilityGeneration) continue;
            set({
              codingPlanSupport,
              takeNumberAvailability,
              takeNumberAvailabilityStatus: shouldReadAvailability ? "ready" : "idle",
            });
          } catch (error) {
            if (generation !== eligibilityGeneration) continue;
            set({
              codingPlanSupport: null,
              takeNumberAvailability: null,
              takeNumberAvailabilityStatus: "error",
            });
            logger.warn("[off-peak] eligibility refresh failed", toErrorMessage(error));
          }
        }
      } finally {
        // Release within the same microtask as the drain, or a request queued during finally attaches to a finished check.
        eligibilityInFlight = null;
      }
    });
    return eligibilityInFlight;
  },

  refreshTakeNumberAvailability(service) {
    return get().refreshCodingPlanSupport(service);
  },

  async createTask(input, service) {
    set({ operationId: "offpeak:create", error: null });
    try {
      const result = await service.createTask(
        input as Parameters<IOffPeakTaskService["createTask"]>[0],
      );
      if (result.ok) {
        await Promise.all([get().refresh(service), get().refreshTakeNumberAvailability(service)]);
        return result;
      }
      // A creation failure means the previous admission snapshot no longer suffices; save the stable kind only, never the raw error, into UI state.
      set({
        error: result.errorCategory,
        takeNumberAvailability: null,
        takeNumberAvailabilityStatus: "error",
      });
      logger.warn("[off-peak] create failed", {
        errorCategory: result.errorCategory,
        errorCode: result.errorCode,
        failureStage: result.failureStage,
      });
      if (isOffPeakQuotaError(result)) {
        await get().refreshTakeNumberAvailability(service);
      }
      return result;
    } catch (error) {
      // Host/RPC transport can still fail outside structured results; normalize to network,
      // toasts consume the stable kind only and never parse raw errors.
      const result = {
        ok: false,
        failureStage: "ticket_request",
        errorCategory: "network",
        errorCode: "",
        providerName: "",
      } as const satisfies OffPeakTaskCreateResult;
      set({
        error: result.errorCategory,
        takeNumberAvailability: null,
        takeNumberAvailabilityStatus: "error",
      });
      logger.warn("[off-peak] create RPC transport failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return result;
    } finally {
      set({ operationId: null });
    }
  },

  async updateTask(offPeakTaskId, input, service) {
    set({ operationId: `offpeak:update:${offPeakTaskId}`, error: null });
    try {
      const updated = await service.updateTask(offPeakTaskId, input);
      await get().refresh(service);
      return updated !== null;
    } catch (error) {
      set({ error: toErrorMessage(error) });
      return false;
    } finally {
      set({ operationId: null });
    }
  },

  async pauseTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:pause:${offPeakTaskId}`, error: null });
    try {
      await service.pauseTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async continueTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:continue:${offPeakTaskId}`, error: null });
    try {
      await service.continueTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async cancelTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:cancel:${offPeakTaskId}`, error: null });
    try {
      await service.cancelTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async deleteTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:delete:${offPeakTaskId}`, error: null });
    try {
      await service.deleteTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async deleteHistory(offPeakTaskId, service) {
    set({
      operationId: `offpeak:delete-history:${offPeakTaskId}`,
      error: null,
    });
    try {
      await service.deleteHistory(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  dismissNewTaskBanner() {
    set({ newTaskBannerDismissed: true });
  },

  setPendingCreateDraft(draft) {
    set({ pendingCreateDraft: draft });
  },

  consumePendingCreateDraft() {
    const draft = get().pendingCreateDraft;
    if (draft) set({ pendingCreateDraft: null });
    return draft;
  },
}));
