type LoafInvokerType = "user-callback" | "event-listener" | "script" | "unknown";

interface LongTaskAttributionSummary {
  loaf_script_count: number;
  loaf_top_duration_ms: number;
  loaf_top_invoker_type: LoafInvokerType;
  loaf_top_share_pct: number;
}

interface RawAttribution {
  duration?: unknown;
  invokerType?: unknown;
}

// Only LoAF (ILongAnimationScript) carries invokerType; rAF-sourced entries (ILongTaskAttribution)
// only have container fields such as containerType and no invokerType, so they fall into the
// generic "script" bucket, distinct from "has invokerType but unknown value".
function classifyInvokerType(raw: RawAttribution): LoafInvokerType {
  if (raw.invokerType === undefined || raw.invokerType === null) {
    return "script";
  }
  if (raw.invokerType === "user-callback" || raw.invokerType === "event-listener") {
    return raw.invokerType;
  }
  return "unknown";
}

/**
 * Pure function: parse the ARMS RUM longTask event's snapshots (JSON-stringified top-5
 * attribution) plus total long-task duration into a low-cardinality attribution summary.
 * No raw script names/URLs are returned, avoiding path leakage and high-cardinality fields.
 * Returns null on parse failure or when no valid attribution exists; callers should skip silently.
 */
export function summarizeLongTaskAttribution(
  snapshotsRaw: unknown,
  totalDurationMs: unknown,
): LongTaskAttributionSummary | null {
  if (typeof snapshotsRaw !== "string" || snapshotsRaw.length === 0) {
    return null;
  }
  let attributions: unknown;
  try {
    attributions = JSON.parse(snapshotsRaw);
  } catch {
    return null;
  }
  if (!Array.isArray(attributions) || attributions.length === 0) {
    return null;
  }

  let top: RawAttribution | null = null;
  let topDuration = -Infinity;
  for (const item of attributions) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const candidate = item as RawAttribution;
    const duration = typeof candidate.duration === "number" ? candidate.duration : 0;
    if (duration > topDuration) {
      topDuration = duration;
      top = candidate;
    }
  }
  if (!top) {
    return null;
  }

  const total = typeof totalDurationMs === "number" ? totalDurationMs : Number.NaN;
  const sharePct =
    Number.isFinite(total) && total > 0 ? Math.round((Math.max(0, topDuration) / total) * 100) : 0;

  return {
    loaf_script_count: attributions.length,
    loaf_top_duration_ms: Math.round(Math.max(0, topDuration)),
    loaf_top_invoker_type: classifyInvokerType(top),
    loaf_top_share_pct: sharePct,
  };
}
