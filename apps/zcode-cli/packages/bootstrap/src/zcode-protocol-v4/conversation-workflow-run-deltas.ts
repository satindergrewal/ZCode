// ============================================================
// Two pure publisher rules for `workflowRun.*` key-level deltas: the legacy-consumer encoding and the fast path's growth bound.
// ============================================================
// That they live outside the publisher matters as much as their being pure: both need pinning individually, and the publisher is
// a runtime shell with a subscription registry and a retention log -- testing against it means building half a transport.
//
// -- 1. Legacy-consumer encoding --
// The retention log always stores native ops (one fact, one log); encoding is **per subscriber**: connections whose handshake
// carried `workflowRunDeltas` get deltas directly; the older generation knows not even the op discriminant --
// `conversationDeltaSchema` is a discriminatedUnion, so an unknown `op` fails the whole union parse and the entire
// logical frame is dropped by the assembler; the re-sent snapshot has no such op either, and that subscription goes silently dead.
// So this is not an optimization -- it is the boundary of whether that generation sees runs at all.
//
// The rewrite rule is one: drop every `workflowRun.*` from the batch and insert, at the **last** dropped position,
// a `state.updated{workflowRuns: current projection}`. Why last, not first: the whole-key replacement implies
// the entire batch's effect; at the last position its order relative to the other ops matches per-op delivery
// (row ops and the state key are independent, commutable anyway). Why the **current** projection, not a historical intermediate:
// in replay the logged delta is long stale and the client wants the final state -- skipping intermediates is
// the same thing coalesce does every day.
//
// Clamping to the legacy bound (256) is `clampWorkflowRunsForLegacy`'s job; see its header.

import type { ConversationDelta, WorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import { clampWorkflowRunsForLegacy, utf8JsonByteLength } from "@zcode/shared/zcode-protocol-v4";

function isWorkflowRunDelta(delta: ConversationDelta): boolean {
  return delta.op === "workflowRun.updated" || delta.op === "workflowRun.removed";
}

/**
 * The legacy-consumer encoding of one delta batch. With no `workflowRun.*` inside, **returns the very same array**
 * (this path runs per subscriber per ingest; never allocate for unrelated batches).
 *
 * With `workflowRuns` absent, drop without adding: the projection has no such key yet, nothing to whole-key-replace with.
 * The producer side never hits this (deltas imply state); this only avoids emitting `{workflowRuns: undefined}`.
 */
export function encodeConversationDeltasForLegacy(
  deltas: readonly ConversationDelta[],
  workflowRuns: WorkflowRunsState | undefined,
): readonly ConversationDelta[] {
  let lastIndex = -1;
  for (let index = deltas.length - 1; index >= 0; index -= 1) {
    if (isWorkflowRunDelta(deltas[index]!)) {
      lastIndex = index;
      break;
    }
  }
  if (lastIndex < 0) return deltas;

  const replacement: ConversationDelta | null =
    workflowRuns === undefined
      ? null
      : { op: "state.updated", patch: { workflowRuns: clampWorkflowRunsForLegacy(workflowRuns) } };
  const encoded: ConversationDelta[] = [];
  for (let index = 0; index < deltas.length; index += 1) {
    const delta = deltas[index]!;
    if (!isWorkflowRunDelta(delta)) {
      encoded.push(delta);
      continue;
    }
    if (index === lastIndex && replacement !== null) encoded.push(replacement);
  }
  return encoded;
}

// -- 2. The ingest fast path's growth bound --
//
// Today every dwf engine event takes the exact path: clone the projection and `JSON.stringify` the whole wire snapshot
// against the 16MiB gate. Thousands of events per run make that an MB-scale repeated cost -- the other half of the same
// bill as whole-key re-sends. Key-level deltas give the step's growth a cheap, **reliable** bound, so most events skip the full measure.

/** Headroom for the JSON shell (`{"kind":"deltas","deltas":[...]}` plus the frame envelope); same value as the streaming-append fast path. */
const WORKFLOW_RUN_DELTA_ENVELOPE_SLACK_BYTES = 64;

/**
 * When a batch **only** contains key-level deltas, the byte bound on snapshot growth; with any other op, null (measure exactly).
 *
 * Why it holds: everything `workflowRun.updated` writes into the snapshot is in that op's payload (whole-header
 * replacement, whole-row upsert), so the snapshot grows by at most that; `workflowRun.removed` only shrinks it.
 *
 * **Empty batches** satisfy the criterion too (no non-key-level op), with a stronger argument still: an event producing
 * no delta changes the snapshot by the `seq` digits alone -- ample headroom. No special case; it is the criterion
 * read to the end, and it spares replay events that reduce to idempotence (zero deltas) a full serialization.
 *
 * The null-covered half is contract too: when diff cannot recognize a structural change it degrades to a whole-key `state.updated`,
 * whose bytes are **not** a growth bound (it replaces the whole key; the old value's bytes are not included) -- fall back to the exact
 * path. The criterion is therefore "every op is key-level", never "some are".
 *
 * Headroom is **per batch**, not per op: it covers the JSON shell and the growth of `seq`'s decimal digits alike.
 */
export function workflowRunDeltaGrowthUpperBound(
  deltas: readonly ConversationDelta[],
): number | null {
  for (const delta of deltas) {
    if (delta.op !== "workflowRun.updated" && delta.op !== "workflowRun.removed") return null;
  }
  return utf8JsonByteLength(deltas) + WORKFLOW_RUN_DELTA_ENVELOPE_SLACK_BYTES;
}
