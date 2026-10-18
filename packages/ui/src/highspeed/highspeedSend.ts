import type {
  HighspeedCardSnapshot,
  HighspeedMessageMeta,
  HighspeedPrepareTurnResult,
  ModelSelection,
} from "@zcode/shared";
import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";

/** Same shape as the protocol payload; the renderer keeps no second copy of the execution materials. */
type HighspeedModelExecution = NonNullable<CommandPayloadMap["sendText"]["modelExecution"]>;

export type HighspeedTurnPreparer = (
  taskId: string,
  submissionSelection?: ModelSelection,
) => Promise<HighspeedPrepareTurnResult | null>;

/** Session projection/draft fields usable for prepare resolution (shape-compatible with snapshot config). */
export interface HighspeedPrepareSelectionSource {
  readonly provider?: string;
  readonly model?: string;
  readonly thought?: string;
  readonly modelSelection?: ModelSelection;
}

/**
 * Resolves provider/model/reasoningLevel for Highspeed prepare (spec 3 rule 15):
 * same source as this submission's modelSelection, so a fresh switch drives admission on the first send;
 * never sample the projection's old combo then override the submission with the card model. Missing
 * submission fields fall back projection -> draft -> initial draft; null if provider/model unresolved.
 */
export function resolveHighspeedPrepareSelection(input: {
  submissionSelection?: ModelSelection;
  projectedConfig?: HighspeedPrepareSelectionSource | null;
  draftConfig?: HighspeedPrepareSelectionSource | null;
  initialDraftConfig?: HighspeedPrepareSelectionSource | null;
}): { provider: string; model: string; reasoningLevel?: string } | null {
  const { submissionSelection } = input;
  const fallbacks = [input.projectedConfig, input.draftConfig, input.initialDraftConfig];
  const provider = submissionSelection?.providerId ?? fallbacks.find((c) => c?.provider)?.provider;
  const model = submissionSelection?.modelId ?? fallbacks.find((c) => c?.model)?.model;
  if (!provider || !model) return null;
  const reasoningLevel =
    submissionSelection?.options?.reasoningLevel ??
    fallbacks
      .map((c) => c?.thought || c?.modelSelection?.options?.reasoningLevel)
      .find((value) => !!value);
  return { provider, model, ...(reasoningLevel ? { reasoningLevel } : {}) };
}

export type HighspeedSendContext = {
  override: ReturnType<typeof buildHighspeedRuntimeOverride>;
  acceleratedCard?: HighspeedCardSnapshot;
};

/**
 * A mock draw keeps accelerated metadata but has no execution materials,
 * so only message metadata is written and inference stays on the session's normal provider/model.
 *
 * The accelerated ride is expressed via standard modelSelection + modelExecution{selectionScope:"execution"}:
 * endpoint facts come from Built-in Provider Config; credentials belong to this execution, never session defaults.
 * See docs/highspeed/highspeed-access-mode-migration.md.
 */
export function buildHighspeedRuntimeOverride(
  result: HighspeedPrepareTurnResult | null | undefined,
): {
  highspeedMeta?: HighspeedMessageMeta;
  modelSelection?: ModelSelection;
  modelExecution?: HighspeedModelExecution;
} {
  if (result?.kind !== "accelerated") return {};
  const highspeedMeta: HighspeedMessageMeta = {
    schemaVersion: 1,
    ...result.card,
  };
  if (!result.execution) return { highspeedMeta };
  return {
    highspeedMeta,
    modelSelection: result.execution.modelSelection,
    modelExecution: {
      selectionScope: "execution",
      requestAuth: result.execution.requestAuth,
      selectionFallback: result.execution.selectionFallback,
    },
  };
}

/**
 * One pre-send assembly for Highspeed results; no per-path payload/stats duplicates.
 * The CLI stays the admission authority; this only splits one prepare result into the two existing consumers.
 */
export async function prepareHighspeedSendContext(
  taskId: string,
  prepareTurn: HighspeedTurnPreparer,
  submissionSelection?: ModelSelection,
): Promise<HighspeedSendContext> {
  const result = await prepareTurn(taskId, submissionSelection);
  return {
    override: buildHighspeedRuntimeOverride(result),
    ...(result?.kind === "accelerated" ? { acceleratedCard: result.card } : {}),
  };
}

/** Send-wait budget: wait at most this long for the draw, then release a plain send (spec 1, 3). */
export const HIGHSPEED_SEND_WAIT_BUDGET_MS = 1000;
/**
 * Wait cap for the plain-decode TPS read in the send path: one RPC round trip on a service cache hit
 * (phone web socket included), deliberately not a full monitor network request.
 */
export const HIGHSPEED_REGULAR_TPS_WAIT_BUDGET_MS = 300;

/**
 * Decorative send-path read (regularTps affects only the saved-time display, not auth/selection/correctness):
 * wait at most min(300ms, remaining send budget); timeout/failure returns undefined and sendText commits at once.
 * Never aborted: the service merges/caches 5m, so the timed-out call warms the cache for the next turn.
 *
 * Bug: prepare winners awaited this read inline; its 15s monitor timeout stretched the 1s send promise
 * to at most 16s (spec 3 rule 12, 9.4).
 */
export async function readRegularTpsWithinSendBudget(params: {
  read: () => Promise<number | undefined>;
  /** Milliseconds spent since send entered prepare; deducted from the remaining budget. */
  elapsedMs: number;
  onError?: (error: unknown) => void;
  onTimeout?: (budgetMs: number) => void;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<number | undefined> {
  const budgetMs = Math.max(
    0,
    Math.min(
      HIGHSPEED_REGULAR_TPS_WAIT_BUDGET_MS,
      HIGHSPEED_SEND_WAIT_BUDGET_MS - params.elapsedMs,
    ),
  );
  // Attach catch first: a background failure after give-up must never become an unhandled rejection.
  const reading = (async () => params.read())().then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => {
      params.onError?.(error);
      return { kind: "error" as const };
    },
  );
  if (budgetMs === 0) {
    params.onTimeout?.(0);
    return undefined;
  }
  const wait =
    params.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const outcome = await Promise.race([
    reading,
    wait(budgetMs).then(() => ({ kind: "timeout" as const })),
  ]);
  if (outcome.kind === "timeout") {
    params.onTimeout?.(budgetMs);
    return undefined;
  }
  return outcome.kind === "value" ? outcome.value : undefined;
}
