import type { HighspeedMessageMeta } from "@zcode/shared";
import { calculateHighspeedSavedDurationMs } from "@/highspeed/highspeedSavedTime.js";
import type { HighspeedShareMetrics } from "@/highspeed/highspeedTurnStore.js";

export interface HighspeedOutputFooterTarget {
  cardId: string;
  metrics: HighspeedShareMetrics;
}

/** Marker fields written back by the footer settle logic; host types declare these two optionals only. */
export interface HighspeedOutputFooterMark {
  /** The last turn of this Highspeed cardId; only a group tail may render the source footer. */
  showHighspeedOutputFooter?: true;
  /** Trusted share args aggregated from every persisted turn of the card on cold restore. */
  highspeedOutputFooterTarget?: HighspeedOutputFooterTarget;
}

interface HighspeedFooterUnit {
  visibleUserInputs: readonly { highspeed?: HighspeedMessageMeta }[];
  assistantWorkRows: readonly { kind: string }[];
}

interface HighspeedCardFooterState {
  lastUnitIndex: number;
  hasOutput: boolean;
  metas: HighspeedMessageMeta[];
}

/**
 * Marks the last render unit covered by a card with the footer flag.
 *
 * Bug: the footer decided per turn via accelerated, so one card spanning turns repeated.
 * Settle once per persisted cardId/expiry before virtualization; the tail then tracks turns and countdown stably.
 */
export function markHighspeedOutputFooterUnits<T extends HighspeedFooterUnit>(
  units: readonly T[],
  nowMs: number,
): (T & HighspeedOutputFooterMark)[] {
  const footerByUnitIndex = resolveHighspeedOutputFooters(units, nowMs);
  return units.map((unit, index) => {
    if (!footerByUnitIndex.has(index)) return unit;
    const target = footerByUnitIndex.get(index);
    return {
      ...unit,
      showHighspeedOutputFooter: true as const,
      ...(target ? { highspeedOutputFooterTarget: target } : {}),
    };
  });
}

function resolveHighspeedOutputFooters(
  units: readonly HighspeedFooterUnit[],
  nowMs: number,
): Map<number, HighspeedOutputFooterTarget | null> {
  const cardsByUnit = units.map((unit) =>
    unit.visibleUserInputs.flatMap((row) => (row.highspeed ? [row.highspeed] : [])),
  );
  const cardStateById = new Map<string, HighspeedCardFooterState>();

  cardsByUnit.forEach((cards, index) => {
    for (const card of cards) {
      const current = cardStateById.get(card.cardId);
      cardStateById.set(card.cardId, {
        lastUnitIndex: index,
        // Bug: an interrupted group tail may have no text of its own while earlier accelerated turns do.
        // The footer belongs to the card, not the last turn; timeline boundaries are not model output.
        hasOutput:
          (current?.hasOutput ?? false) ||
          (card.outputTokens ?? 0) > 0 ||
          units[index]!.assistantWorkRows.some((row) => row.kind !== "timelineMarker"),
        metas: [...(current?.metas ?? []), card],
      });
    }
  });

  const footerByUnitIndex = new Map<number, HighspeedOutputFooterTarget | null>();
  cardsByUnit.forEach((cards, index) => {
    const footerCard = cards.find((card) => {
      const state = cardStateById.get(card.cardId);
      return card.expiresAt <= nowMs && state?.lastUnitIndex === index && state.hasOutput;
    });
    if (!footerCard) return;
    const metrics = aggregatePersistedHighspeedMetrics(
      cardStateById.get(footerCard.cardId)?.metas ?? [],
    );
    footerByUnitIndex.set(index, metrics ? { cardId: footerCard.cardId, metrics } : null);
  });
  return footerByUnitIndex;
}

function aggregatePersistedHighspeedMetrics(
  metas: readonly HighspeedMessageMeta[],
): HighspeedShareMetrics | null {
  if (
    metas.length === 0 ||
    metas.some(
      (meta) =>
        meta.outputTokens === undefined ||
        meta.regularTps === undefined ||
        meta.regularTps <= 0 ||
        meta.highspeedTps === undefined ||
        meta.highspeedTps <= 0,
    )
  ) {
    return null;
  }
  const outputTokens = metas.reduce((total, meta) => total + (meta.outputTokens ?? 0), 0);
  if (outputTokens <= 0) return null;
  const regularDurationSeconds = metas.reduce(
    (total, meta) => total + (meta.outputTokens ?? 0) / (meta.regularTps ?? 1),
    0,
  );
  const savedDurationMs = metas.reduce(
    (total, meta) =>
      total +
      (meta.savedDurationMs ??
        calculateHighspeedSavedDurationMs({
          outputTokens: meta.outputTokens ?? 0,
          regularTps: meta.regularTps ?? 0,
          highspeedTps: meta.highspeedTps ?? 0,
          durationMs: meta.durationMs ?? 0,
          modelDurationMs: meta.modelDurationMs,
          toolDurationMs: meta.toolDurationMs,
          otherDurationMs: meta.otherDurationMs,
        })),
    0,
  );
  return {
    outputTokens,
    durationMs: metas.reduce((total, meta) => total + (meta.durationMs ?? 0), 0),
    ...(metas.every(
      (meta) => meta.modelDurationMs !== undefined && meta.toolDurationMs !== undefined,
    )
      ? {
          modelDurationMs: metas.reduce((total, meta) => total + (meta.modelDurationMs ?? 0), 0),
          toolDurationMs: metas.reduce((total, meta) => total + (meta.toolDurationMs ?? 0), 0),
          otherDurationMs: metas.reduce(
            (total, meta) =>
              total +
              (meta.otherDurationMs ??
                Math.max(
                  0,
                  (meta.durationMs ?? 0) - (meta.modelDurationMs ?? 0) - (meta.toolDurationMs ?? 0),
                )),
            0,
          ),
        }
      : {}),
    savedDurationMs,
    regularTps: outputTokens / regularDurationSeconds,
    // healthy returns the card-level total TPS; every turn of the card persists that same authoritative value.
    highspeedTps: metas[0]!.highspeedTps!,
  };
}
