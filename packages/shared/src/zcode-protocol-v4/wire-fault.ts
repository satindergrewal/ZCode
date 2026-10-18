// Classification of V4 physical assembly faults: **content-deterministic** vs transient.
//
// The recovery ladder defaults to treating faults as transient: same-sub resync first (the server may resume), then
// forceSnapshot on a gap, then fail closed. Right for lost fragments, timeouts, checksum mismatches--one retransmit likely fixes it.
 // Wrong for **schema rejections**: the bytes already passed length/checksum/UTF-8/JSON; rejection means this end cannot
 // read the **content** the other sent, and the resume tier would re-deliver the same deltas to the same rejection.
//
// When a tool-card payload carries incompatible fields, re-sending the same content cannot recover; try a snapshot, then report content incompatibility.
//
// This module only answers "is this reason code a deterministic content failure"; disposal lives in the two stores.
// （conversationProjectionStore / sessionsIndexStore）。

/**
 * Reason codes where the frame passed checksum/JSON but failed the zod schema.
 *
 * Constants, not scattered literals: the judging side and the producing side (wire-assembler, wire-reassembly) must
 * always share the word--divergence's symptom is exactly the silent mismatch class this module fixes.
 */
export const WIRE_FAULT_INVALID_PAYLOAD = "proto.frameAssemblyInvalidPayload";

/**
 * Is this fault the deterministic "same content re-sent is rejected again"?
 *
 * Currently schema rejection only. `proto.frameAssemblyInvalidJson` is deliberately **not** included: bad JSON may
 * also come from the assembly path itself (fragment splicing, encoding boundaries) where a resend may differ; misreading
 * transient as deterministic parks a self-healing gap--worse than one useless retry. Add by evidence, not by guess.
 */
export function isDeterministicContentFault(reasonCode: string | undefined): boolean {
  return reasonCode === WIRE_FAULT_INVALID_PAYLOAD;
}

/**
 * The client terminal code when a content-deterministic failure is exhausted (`fault.subscription.*` is 04-sync's vocabulary).
 *
 * Separate from `fault.subscription.recoveryFailed` usefully, not name hygiene: the latter is "the link never recovered",
 * where reconnecting means something; this code is "this end cannot read the peer's content", where reconnecting yields the same.
 * Telemetry aggregates by code; blending them reads one version mismatch as a field of network jitter.
 */
export const SUBSCRIPTION_CONTENT_REJECTED = "fault.subscription.contentRejected";
