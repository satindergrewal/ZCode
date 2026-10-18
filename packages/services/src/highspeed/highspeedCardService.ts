import {
  resolveHighspeedProviderId,
  resolveHighspeedDrawProviderId,
  highspeedDrawResponseSchema,
  HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE,
  type HighspeedCardApi,
  type HighspeedCardUsage,
  type HighspeedCardSnapshot,
  type HighspeedDrawRequest,
  type HighspeedDrawResponse,
  type HighspeedPrepareFallbackReason,
  type HighspeedPrepareTurnParams,
  type HighspeedPrepareTurnResult,
  type HighspeedServiceSnapshot,
  type HighspeedTurnExecution,
  type ModelSelection,
} from "@zcode/shared";
import type { IHighspeedCardService } from "./highspeedCard.js";

export { createHighspeedHttpTransport } from "./highspeedHttpTransport.js";

export interface HighspeedServiceTransport {
  draw(request: HighspeedDrawRequest): Promise<HighspeedDrawResponse>;
  healthy(cardId: string): Promise<HighspeedCardUsage>;
}

/**
 * Dynamic credentials for highspeed inference. It rides the /api/v1/highspeed/ gateway and reuses the draw's Coding Plan
 * dual-JWT contract: the zcode JWT carries session identity; the Coding Plan JWT plus team header prove entitlements.
 * All fields must come from one selected-connection resolution; never mix families,
 * (a ZAI JWT with a BigModel key is rejected server-side at token issue).
 */
export interface HighspeedInferenceAuth {
  zcodeJwt: string;
  family: "zai" | "bigmodel";
  codingPlanAuthorization: string;
  targetType: "PERSONAL" | "TEAM";
  organizationId?: string;
  projectId?: string;
}

export interface HighspeedCardServiceOptions {
  transport: HighspeedServiceTransport;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  /**
   * Highspeed credentials. Cards split per account family and never migrate silently; the draw
   * resolution must be the same one. Default fixtures serve local tests only.
   */
  resolveInferenceAuth?: () => Promise<HighspeedInferenceAuth>;
  /** A mock draw only validates state; the message keeps the session's normal inference route. */
  inferenceMode?: "highspeed" | "session-default";
  /** Draws are Coding-Plan-only; default to supported to preserve mock and existing test semantics. */
  resolveCodingPlanSupported?: () => Promise<boolean>;
  /**
   * The session model must sit in the selected Coding Plan provider's catalog before a new draw (spec §3 rule 14);
   * default to covered for mock/test semantics; checker errors fail closed so stale combos never reach draw.
   */
  resolveModelCovered?: (providerId: string, modelId: string) => Promise<boolean>;
}

const DEFAULT_WAIT_BUDGET_MS = 1000;

type SendBudgetOutcome<T> = { kind: "settled"; value: T } | { kind: "timeout" };
/** Races an await against this prepareTurn's send budget; exhaustion ends the wait, never the request. */
type SendBudget = <T>(task: Promise<T>) => Promise<SendBudgetOutcome<T>>;

/**
 * Coding Plan dual JWT plus team header. Draw and highspeed share the /api/v1/highspeed/ gateway and auth
 * middleware: both must present identical Coding Plan credentials; highspeed just adds the card id.
 */
export function buildHighspeedCodingPlanAuthHeaders(params: {
  zcodeJwt: string;
  codingPlanAuthorization: string;
  targetType: "PERSONAL" | "TEAM";
  organizationId?: string;
  projectId?: string;
}): Record<string, string> {
  const zcodeJwt = params.zcodeJwt.trim();
  const codingPlanAuthorization = params.codingPlanAuthorization.trim();
  if (!zcodeJwt) throw new Error("highspeed request requires zcode jwt");
  if (!codingPlanAuthorization) throw new Error("highspeed request requires Coding Plan jwt");
  if (params.targetType === "TEAM" && (!params.organizationId || !params.projectId)) {
    throw new Error("highspeed team request requires organization and project");
  }
  return {
    Authorization: /^Bearer\s/i.test(zcodeJwt) ? zcodeJwt : `Bearer ${zcodeJwt}`,
    // The API contract wants the Bearer prefix; credential stores may hold bare tokens, so normalize here.
    "X-Bigmodel-Authorization": /^Bearer\s/i.test(codingPlanAuthorization)
      ? codingPlanAuthorization
      : `Bearer ${codingPlanAuthorization}`,
    "Bigmodel-Target-Type": params.targetType,
    ...(params.targetType === "TEAM"
      ? {
          "Bigmodel-Organization": params.organizationId!,
          "Bigmodel-Project": params.projectId!,
        }
      : {}),
  };
}

function toSnapshot(card: HighspeedCardApi): HighspeedCardSnapshot {
  return {
    cardId: card.card_id,
    taskId: card.task_id,
    provider: card.provider,
    model: card.model,
    issuedAt: card.issued_at,
    expiresAt: card.expires_at,
  };
}

/**
 * Builds one highspeed execution's selection and dynamic credentials. Static facts (endpoint, API shape, model caps) come from
 * the ZCode built-in provider config; never ship provider definitions per send.
 */
export function buildHighspeedTurnExecution(params: {
  card: HighspeedCardSnapshot;
  auth: HighspeedInferenceAuth;
  /**
   * The submission selection at draw time (session model + thinking level). Highspeed swaps endpoints, not models, so the execution keeps that level
   * or the CLI registry rejects the turn; it is also the fallback target and must ship in selectionFallback.
   */
  sessionSelection: ModelSelection;
}): HighspeedTurnExecution {
  const providerId = resolveHighspeedProviderId(params.auth.family);
  const reasoningLevel = params.sessionSelection.options?.reasoningLevel;
  return {
    modelSelection: {
      providerId,
      // The card echoes the requested model: highspeed swaps endpoints, never models.
      modelId: params.card.model,
      // The execution-scoped selection must be complete, thinking level included, or the CLI registry rejects the turn.
      ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
    },
    requestAuth: {
      // Anthropic-compatible clients send x-api-key; the server still rules via Authorization, the dual JWTs, and the card id.
      apiKey: params.auth.zcodeJwt,
      headers: {
        // Bug: highspeed used to send only the zcode JWT + card id; sharing the draw gateway and auth
        // middleware without the Coding Plan dual JWT + team header made entitlement checks fail with
        // 401 auth_failed. Reuse the exact draw headers, then attach this execution's card id.
        ...buildHighspeedCodingPlanAuthHeaders({
          zcodeJwt: params.auth.zcodeJwt,
          codingPlanAuthorization: params.auth.codingPlanAuthorization,
          targetType: params.auth.targetType,
          ...(params.auth.organizationId ? { organizationId: params.auth.organizationId } : {}),
          ...(params.auth.projectId ? { projectId: params.auth.projectId } : {}),
        }),
        "X-Highspeed-Card-ID": params.card.cardId,
      },
    },
    // Any highspeed failure finishes the turn on the session model (spec §2.2): rules match in order, expiry (3402) gets its own
    // reason for renderer copy; the catch-all carries no code and covers auth, rate limits, 5xx, network, timeouts, and stream breaks.
    // The CLI matches declarations only and never interprets codes; handles declaring this get zero adapter retries, falling back on first failure.
    selectionFallback: {
      providerId,
      rules: [
        {
          reason: "highspeed_card_expired",
          providerErrorCode: HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE,
        },
        { reason: "highspeed_request_failed" },
      ],
      // Root cause: the fallback target trusted only the CLI's in-memory resident selection. After a desktop restart, cold restore landing in the
      // registry-ready-but-entitlements-pending window left the persisted selection unbound; speed-only turns never bind either, so card expiry (3402)
      // degraded silently and the turn failed with "highspeed card is invalid". The initiator knows the original model here,
      // so ship it as the fallback target in the declaration (spec §2.2) instead of betting on runtime state.
      target: params.sessionSelection,
    },
  };
}

export class HighspeedCardService implements IHighspeedCardService {
  private readonly transport: HighspeedServiceTransport;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly resolveInferenceAuth: () => Promise<HighspeedInferenceAuth>;
  private readonly inferenceMode: "highspeed" | "session-default";
  private readonly resolveCodingPlanSupported: () => Promise<boolean>;
  private readonly resolveModelCovered: (providerId: string, modelId: string) => Promise<boolean>;
  private card: HighspeedCardSnapshot | null = null;
  private nextDrawAt: number | null = null;
  private inFlightDraw: Promise<HighspeedDrawResponse> | null = null;

  constructor(options: HighspeedCardServiceOptions) {
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.resolveInferenceAuth =
      options.resolveInferenceAuth ??
      (async () => ({
        zcodeJwt: "mock-zcode-jwt",
        family: "zai",
        codingPlanAuthorization: "mock-coding-plan-jwt",
        targetType: "PERSONAL",
      }));
    this.inferenceMode = options.inferenceMode ?? "highspeed";
    this.resolveCodingPlanSupported = options.resolveCodingPlanSupported ?? (async () => true);
    this.resolveModelCovered = options.resolveModelCovered ?? (async () => true);
  }

  async prepareTurn(params: HighspeedPrepareTurnParams): Promise<HighspeedPrepareTurnResult> {
    // Bug: scheduled runs are background input turns and must not join user-facing draws; the gate reads only
    // this turn's automationId, never the sticky cronAutomationId on the task, or manual inputs in the same session lose highspeed.
    if (params.automationId?.trim()) {
      return { kind: "fallback", reason: "automation", nextDrawAt: this.nextDrawAt };
    }

    const now = this.now();
    this.expireCard(now);
    // Root cause: the 1s budget used to cover only the draw wait, while the gate check (catalog needs the provider runtime) and
    // credential resolution awaited outside it, hanging sends indefinitely when the registry or credentials stalled.
    // The budget starts at prepareTurn entry and every await shares one deadline (spec §3 rule 12).
    const withinBudget = this.createSendBudget(now, params.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS);

    if (this.card) {
      return this.prepareWithCard(this.card, params, withinBudget);
    }
    if (this.nextDrawAt !== null && now < this.nextDrawAt) {
      return { kind: "fallback", reason: "cooldown", nextDrawAt: this.nextDrawAt };
    }

    // The draw body's provider must be the Coding Plan builtin id from the server allow-list
    // （builtin:zai-coding-plan / builtin:bigmodel-coding-plan）；Start/Off-Peak/API Key/
    // custom providers cannot resolve to it, so degrade instead of sending a request destined for 3001.
    // Regression guard: never pass the session's full providerId (account:bigmodel-team-coding-plan)
    // or account family (bigmodel) through; the allow-list rejects both with 3001.
    const drawProviderId = resolveHighspeedDrawProviderId(params.providerId);
    if (!drawProviderId) {
      return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
    }

    // The gate blocks new draws only; in-flight requests were legitimately started and pass untouched.
    if (!this.inFlightDraw) {
      const gate = await withinBudget(this.checkDrawGates(params.providerId, params.model));
      // A gate over budget degrades to not-ready (rule 14) without drawing; the check keeps running and warms the next turn.
      if (gate.kind === "timeout") {
        return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
      }
      if (gate.value) {
        return { kind: "fallback", reason: gate.value, nextDrawAt: this.nextDrawAt };
      }
    }

    const draw = this.inFlightDraw ?? this.startDraw(params, drawProviderId);
    const outcome = await withinBudget(draw);
    if (outcome.kind === "timeout") {
      return { kind: "fallback", reason: "draw-timeout", nextDrawAt: this.nextDrawAt };
    }

    this.applyDrawResponse(outcome.value);
    if (!this.card) {
      return { kind: "fallback", reason: "draw-miss", nextDrawAt: this.nextDrawAt };
    }
    return this.prepareWithCard(this.card, params, withinBudget);
  }

  async getSnapshot(): Promise<HighspeedServiceSnapshot> {
    this.expireCard(this.now());
    return {
      card: this.card,
      nextDrawAt: this.nextDrawAt,
      drawing: this.inFlightDraw !== null,
    };
  }

  healthy(cardId: string): Promise<HighspeedCardUsage> {
    return this.transport.healthy(cardId);
  }

  /**
   * New-draw gate: rule 14 model catalog then rule 11 Coding Plan support, in order, returning the fallback reason,
   * or null when all pass. Checker errors fail closed; card, cooldown, and in-flight state stay untouched.
   * A stale restored (coding-plan provider, retired model) pair passes the provider allow-list, so the catalog check
   * must catch it before invalid combos or credentials reach draw.
   */
  private async checkDrawGates(
    providerId: string,
    modelId: string,
  ): Promise<Extract<HighspeedPrepareFallbackReason, "unavailable" | "no-coding-plan"> | null> {
    if (!(await this.isModelCovered(providerId, modelId))) return "unavailable";
    if (!(await this.isCodingPlanSupported())) return "no-coding-plan";
    return null;
  }

  /**
   * The deadline fixes at prepareTurn entry; the timer lazy-creates once and every later stage reuses it.
   * Synchronous degrade paths (automation, cooldown, non-allow-listed) never register it.
   */
  private createSendBudget(startedAt: number, budgetMs: number): SendBudget {
    const deadline = startedAt + budgetMs;
    let expired: Promise<{ kind: "timeout" }> | null = null;
    return <T>(task: Promise<T>) => {
      expired ??= this.wait(Math.max(0, deadline - this.now())).then(() => ({
        kind: "timeout" as const,
      }));
      return Promise.race([task.then((value) => ({ kind: "settled" as const, value })), expired]);
    };
  }

  private async isCodingPlanSupported(): Promise<boolean> {
    try {
      return await this.resolveCodingPlanSupported();
    } catch {
      return false;
    }
  }

  private async isModelCovered(providerId: string, modelId: string): Promise<boolean> {
    try {
      return await this.resolveModelCovered(providerId, modelId);
    } catch {
      return false;
    }
  }

  private startDraw(
    params: HighspeedPrepareTurnParams,
    drawProviderId: string,
  ): Promise<HighspeedDrawResponse> {
    const draw = this.transport
      .draw({ task_id: params.taskId, provider: drawProviderId, model: params.model })
      .then((response) => {
        this.applyDrawResponse(response);
        return response;
      })
      .finally(() => {
        if (this.inFlightDraw === draw) this.inFlightDraw = null;
      });
    this.inFlightDraw = draw;
    return draw;
  }

  private applyDrawResponse(response: HighspeedDrawResponse): void {
    const parsed = highspeedDrawResponseSchema.parse(response);
    this.nextDrawAt = parsed.data.next_draw_at;
    this.card = parsed.data.card ? toSnapshot(parsed.data.card) : null;
    this.expireCard(this.now());
  }

  private expireCard(now: number): void {
    if (this.card && this.card.expiresAt <= now) this.card = null;
  }

  private async prepareWithCard(
    card: HighspeedCardSnapshot,
    params: Pick<HighspeedPrepareTurnParams, "taskId" | "providerId" | "model" | "reasoningLevel">,
    withinBudget: SendBudget,
  ): Promise<HighspeedPrepareTurnResult> {
    if (card.taskId !== params.taskId) {
      return { kind: "fallback", reason: "foreign-card", card, nextDrawAt: this.nextDrawAt };
    }
    if (this.inferenceMode === "session-default") {
      return {
        kind: "accelerated",
        card,
        nextDrawAt: this.nextDrawAt ?? card.expiresAt,
      };
    }
    const auth = await withinBudget(this.resolveInferenceAuth());
    // Credential resolution over budget: send normally this turn with draw-timeout semantics (card not ready in time);
    // keep the card, return it in the result, and reuse highspeed once credentials settle.
    if (auth.kind === "timeout") {
      return { kind: "fallback", reason: "draw-timeout", card, nextDrawAt: this.nextDrawAt };
    }
    // The fallback target is this submission's session choice (provider/model/level): card-independent and runtime-independent.
    const sessionSelection: ModelSelection = {
      providerId: params.providerId,
      modelId: params.model,
      ...(params.reasoningLevel ? { options: { reasoningLevel: params.reasoningLevel } } : {}),
    };
    return {
      kind: "accelerated",
      card,
      nextDrawAt: this.nextDrawAt ?? card.expiresAt,
      execution: buildHighspeedTurnExecution({ card, auth: auth.value, sessionSelection }),
    };
  }
}
