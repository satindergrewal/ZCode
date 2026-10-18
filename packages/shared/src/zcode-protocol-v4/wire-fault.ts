// Classification of V4 physical-assembly faults: **content-deterministic** vs transient.
// spec: docs/v4-refactor/04-sync-and-recovery.md closure rule 11,
// docs/v4-refactor/05-transport-and-backpressure.md, client rules.
//
// The recovery ladder treats faults as transient by default: same-sub resync first (the server may resume), then
// forceSnapshot on a gap, then fail closed. Right for lost fragments, timeouts, checksum mismatches -- one resend often heals.
// Wrong for **schema rejections**: the bytes already passed length/checksum/UTF-8/JSON; a rejection means this side cannot
// read the peer's **content**, and the resume tier resends the same deltas to the same rejection.
//
// The 2026-09-21 (sess_4142de31) incident was exactly this: a tool-card payload with two extra keys burned three
// frames, fail closed; the user hit reconnect twice, three frames each -- the session never reopened.
//
// This module only answers is-this-reason-code-a-deterministic-content-failure; disposition lives in the two stores.
// （conversationProjectionStore / sessionsIndexStore）。

/**
 * Reason codes for frames passing checksum/JSON yet failing the zod schema.
 *
 * Constants, not scattered literals: the judging side and the producing side (wire-assembler, wire-reassembly) must
 * always say the same word -- divergent copies cause exactly the silent mismatch this module fixes.
 */
export const WIRE_FAULT_INVALID_PAYLOAD = "proto.frameAssemblyInvalidPayload";

/**
 * Is this fault deterministic -- would the same content be rejected again?
 *
 * Currently schema rejection only. `proto.frameAssemblyInvalidJson` deliberately does **not** count: bad JSON can
 * also come from the assembly path itself (fragment splicing, encoding edges), where a resend may differ;
 * misreading transient as deterministic parks a self-healing gap -- worse than one wasted retry. Add by evidence, not guesswork.
 */
export function isDeterministicContentFault(reasonCode: string | undefined): boolean {
  return reasonCode === WIRE_FAULT_INVALID_PAYLOAD;
}

/**
 * Terminal client code when a content-deterministic failure exhaustes the ladder (`fault.subscription.*` is 04-sync's vocabulary).
 *
 * Distinct from `fault.subscription.recoveryFailed` on purpose, not naming polish: that one means the link never recovered
 * and reconnect may help; this one means this side cannot read the peer's content, so reconnect repeats it. Telemetry
 * aggregates by code -- blending them reads one version skew as a broad network flare.
 */
export const SUBSCRIPTION_CONTENT_REJECTED = "fault.subscription.contentRejected";
