import { z } from "zod";
import {
  modelExecutionSelectionFallbackReasonSchema,
  type ModelExecutionSelectionFallback,
} from "./model-execution.js";
import type { ModelSelection } from "./model-selection.js";
import { BUILTIN_MODEL_PROVIDER_IDS } from "./model-provider-types.js";

/**
 * Business error code (HTTP 400 / provider_code=3402) the boost gateway returns when the card expires mid-Turn.
 * See docs/highspeed/highspeed-card-spec.md: on hit, keep context and fall back to the original model to finish the Turn.
 */
export const HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE = "3402";

/**
 * The boost card's hidden Built-in provider; endpoint and model catalog come from ZCode Built-in Provider Config
 * (config/provider/zcode-builtin.json); only the cross-layer IDs live here.
 * Split per account family under the same rule as Off-Peak: the card draws on the current account's Coding Plan entitlement
 * and never silently migrates across families.
 */
export const HIGHSPEED_PROVIDER_IDS = {
  zai: "account:zai-highspeed-card",
  bigmodel: "account:bigmodel-highspeed-card",
} as const;

export function resolveHighspeedProviderId(
  family: "zai" | "bigmodel",
): (typeof HIGHSPEED_PROVIDER_IDS)[typeof family] {
  return HIGHSPEED_PROVIDER_IDS[family];
}

/**
 * Whether a Selection points at the boost-card provider. Post family-split it cannot be a single-constant equals,
 * or BigModel accounts' cards read as non-boost on queue promotion and silently drop.
 */
export function isHighspeedProviderId(providerId: string | undefined): boolean {
  if (providerId === undefined) return false;
  return Object.values(HIGHSPEED_PROVIDER_IDS).some((id) => id === providerId);
}

/**
 * The draw body's provider contract values: the server highspeed allowlist accepts only the Coding Plan builtin identities
 * (builtin:zai-coding-plan / builtin:bigmodel-coding-plan, confirmed with the server 2026-09-17;
 * the design doc's "zai" is an abbreviation example, not a wire value). Start Plan, Off-Peak, API keys, and
 * custom providers are not on the list: resolve to null and degrade, never map-and-send.
 */
export const HIGHSPEED_DRAW_PROVIDER_IDS = {
  zai: "builtin:zai-coding-plan",
  bigmodel: "builtin:bigmodel-coding-plan",
} as const;

const HIGHSPEED_DRAW_PROVIDER_ID_BY_PROVIDER_ID = new Map<string, string>([
  [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan, HIGHSPEED_DRAW_PROVIDER_IDS.zai],
  [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan, HIGHSPEED_DRAW_PROVIDER_IDS.zai],
  [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan, HIGHSPEED_DRAW_PROVIDER_IDS.bigmodel],
  [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan, HIGHSPEED_DRAW_PROVIDER_IDS.bigmodel],
]);

/** Resolves a session selection's provider id into a draw-body allowlist value; null on miss. */
export function resolveHighspeedDrawProviderId(providerId: string): string | null {
  return HIGHSPEED_DRAW_PROVIDER_ID_BY_PROVIDER_ID.get(providerId) ?? null;
}

export const highspeedCardSchema = z.object({
  card_id: z.string().min(1),
  task_id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  issued_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
});

/**
 * The protocol-level card snapshot written into message.data. The version field keeps future extensions tolerant of old messages.
 */
export const highspeedMessageMetaSchema = z
  .object({
    schemaVersion: z.literal(1),
    cardId: z.string().min(1),
    taskId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    /** Plain Pro/Max decode TPS sampled from the Coding Plan health check when the turn was sent. */
    regularTps: z.number().positive().optional(),
    /** Final-state stats; written atomically by the same CLI persistence update. */
    outputTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    /** Card-level average completion TPS sampled from Highspeed healthy usage after expiry. */
    highspeedTps: z.number().positive().optional(),
    savedDurationMs: z.number().nonnegative().optional(),
    /** True duration split aggregated by the CLI from runtime events; clients fall back to a 20/80 estimate when absent. */
    modelDurationMs: z.number().nonnegative().optional(),
    toolDurationMs: z.number().nonnegative().optional(),
    otherDurationMs: z.number().nonnegative().optional(),
    /** When an in-Turn boost request failed back to the plain model; projection-degrade hint only, never shared stats. */
    fallbackAt: z.number().int().nonnegative().optional(),
    /** Fallback reason: card expiry or another boost failure; the renderer picks copy from it, legacy data treated as expiry. */
    fallbackReason: modelExecutionSelectionFallbackReasonSchema.optional(),
  })
  .strict();

export const highspeedDrawRequestSchema = z.object({
  task_id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
});

export const highspeedDrawResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
  data: z.object({
    card: highspeedCardSchema.nullable(),
    next_draw_at: z.number().int().nonnegative(),
  }),
});

export const highspeedHealthyResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
  data: z.object({
    card_id: z.string().min(1),
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    duration_seconds: z.number().int().nonnegative(),
  }),
});

export type HighspeedCardApi = z.infer<typeof highspeedCardSchema>;
export type HighspeedMessageMeta = z.infer<typeof highspeedMessageMetaSchema>;
export type HighspeedDrawRequest = z.infer<typeof highspeedDrawRequestSchema>;
export type HighspeedDrawResponse = z.infer<typeof highspeedDrawResponseSchema>;
export type HighspeedHealthyResponse = z.infer<typeof highspeedHealthyResponseSchema>;

export interface HighspeedCardUsage {
  cardId: string;
  promptTokens: number;
  completionTokens: number;
  durationSeconds: number;
}

export interface HighspeedCardSnapshot {
  cardId: string;
  taskId: string;
  provider: string;
  model: string;
  issuedAt: number;
  expiresAt: number;
  regularTps?: number;
}

export type HighspeedPrepareFallbackReason =
  | "automation"
  | "cooldown"
  | "draw-miss"
  | "draw-timeout"
  | "expired"
  | "foreign-card"
  | "no-coding-plan"
  | "unavailable";

export interface HighspeedPrepareTurnParams {
  taskId: string;
  /**
   * The session model selection's provider id. The draw body's provider contract is the allowlisted Coding Plan
   * builtin identity (builtin:zai-coding-plan / builtin:bigmodel-coding-plan), resolved by the service layer
   * before send; callers must neither pass allowlist values directly nor thread the full providerId up
   * (the server allowlist rejects it with 3001 invalid-params).
   */
  providerId: string;
  /**
   * The session's current model. Beyond the provider allowlist, the model must also belong to the chosen Coding Plan
   * provider's catalog (Built-in Provider Config projection) to draw; stale (provider, retired model) pairs
   * degrade as unavailable (spec 3 rule 14).
   */
  model: string;
  /**
   * The session's active reasoning level. Boosting swaps the endpoint, never the model, so the card's modelSelection must carry
   * the session's reasoningLevel; otherwise the CLI Registry judges the execution selection level-missing and throws
   * "Reasoning level is required", failing the whole send.
   * Omit when the model has no reasoning levels (no options written).
   */
  reasoningLevel?: string;
  /** Marks the turn as Automation-dispatched only; never a substitute for the sticky cronAutomationId on the Task. */
  automationId?: string;
  waitBudgetMs?: number;
}

/**
 * Per-turn boost execution material. Static facts (endpoint, API shape, model capabilities) come from Built-in Provider Config;
 * this carries only which model this turn uses plus the execution's dynamic auth -- never a provider definition.
 */
export interface HighspeedTurnExecution {
  modelSelection: ModelSelection;
  requestAuth: { apiKey: string; headers: Record<string, string> };
  /**
   * Any boost-request failure finishes the turn on the original model; card expiry (3402) and other failures get distinct reasons.
   * Fallback target `target` is the draw-time submission choice (session model + level); the CLI prefers it, then the resident selection.
   */
  selectionFallback: ModelExecutionSelectionFallback;
}

export type HighspeedPrepareTurnResult =
  | {
      kind: "accelerated";
      card: HighspeedCardSnapshot;
      nextDrawAt: number;
      /** The mock keeps boost semantics only; omitting this field still routes via ordinary session inference. */
      execution?: HighspeedTurnExecution;
    }
  | {
      kind: "fallback";
      reason: HighspeedPrepareFallbackReason;
      card?: HighspeedCardSnapshot;
      nextDrawAt: number | null;
    };

export interface HighspeedServiceSnapshot {
  card: HighspeedCardSnapshot | null;
  nextDrawAt: number | null;
  drawing: boolean;
}

export type HighspeedMockScenario =
  | "hit-fast"
  | "miss"
  | "hit-after-timeout"
  | "existing-foreign-task-card"
  | "expired-card";
