# Spec: Goal Continuation Mission Hardening

## Problem

Long autonomous missions (hours, many tasks) stop even when a session goal is active and the
user gave explicit "do not stop until DONE" orders. Three harness-level holes let the
continuation loop exit silently:

1. **Background-deferral death**: when any background task (bench, serve, long shell job) was
   running at turn end, the continuation deferred and the loop exited. Sessions that keep
   background work running (the normal case for GPU-box missions) never auto-continued.
2. **Single verifier pass ends the mission**: one verifier "passed" verdict permanently stops
   continuation. A model status report claiming completion can fool a single verification.
3. **Verifier failure silently abandons the mission**: a verifier error without a usable next
   action stopped the loop as if the goal were done.

## Product Rules

- With an active session goal, the harness — not model discipline — owns continuation: after
  every turn (user prompt or background notification) the loop keeps issuing goal-continuation
  turns until the goal is verifiably complete.
- **Background-deferral waits**: when continuation defers because background tasks are running,
  the loop polls (20s interval) until they drain (timeout: `backgroundDeferralTimeoutMs`,
  default 2h) and then re-attempts verification, instead of exiting.
- **Completion needs confirmation**: the loop accepts completion only after
  `requiredCompletionConfirmations` (default 2) independent verifier passes in a row; any
  executed work resets the counter.
- **Verifier failures degrade, not abandon**: on a verifier failure without a next action, the
  loop runs one unverified continuation turn (generic goal prompt) and re-verifies; only after
  `maxFailureContinuations` (default 3) consecutive failures does it stop, with a
  `target.continuation.verifier_failure_cap_reached` warning.
- User input always wins: pending queued commands still yield the loop immediately; Stop pauses
  the goal as before.
- **Background-deferral wait defaults to 7 days** (was 2h): missions legitimately keep
  background work running for days; Stop and queued user input are the real interrupt paths.

## Mission Mode (task-list-driven continuation)

Separate from the goal verifier, a session can run **mission continuation**: when enabled
(Desktop setting `missionContinuationEnabled`, default off → `ZCODE_MISSION_CONTINUATION=1`
injected Desktop → Host → Agent; standalone CLI can export the env directly), after every turn
(user prompt or background notification):

- The loop reads the authoritative session task list (`sessionStore.readTodos`).
- Open items (non-completed) → it issues model-only continuation turns whose prompt carries the
  **full** task list with anti-shrink rules: never remove or shrink the list; discovered work
  becomes new items; blocked items are marked and stated in one line while the rest continues.
- Progress valve: consecutive continuation turns with zero list changes are capped
  (`missionContinuation.idleContinuationCap`, default 100; any list change resets the streak)
  with a `mission.continuation.idle_cap_reached` warning.
- Runs after the goal loop: a verified-done goal with open list items still keeps working.
- Queued user input and Stop interrupt immediately, as with the goal loop.

## State Owners

| State | Single Owner |
| ----- | ------------ |
| Continuation decision + streaks/counters | `runActiveTargetContinuationLoop` in `apps/zcode-cli/packages/core/src/runtime/methods/target-continuation-loop.ts` |
| Outcome classification (executed / completed / deferred-background / verifier-failed / skipped) | `executeTargetContinuationWithOutcome` in `methods/target.ts` |
| Tunables | `AgentRuntimeConfig.targetCompletionVerification.{maxFailureContinuations, requiredCompletionConfirmations, backgroundDeferralTimeoutMs}` in `runtime/types.ts` |

## Interfaces

- `executeTargetContinuationCommand` keeps its `TurnResult | null` signature (thin wrapper).
- New exported `executeTargetContinuationWithOutcome` returns a discriminated outcome so the
  loop can distinguish "done / gone" from "verifier broken" from "background busy".
- No protocol/UI changes; no new settings UI (config is runtime-level).

## Acceptance Scenarios

1. Goal active, turn ends while a background bench runs: the loop waits for the bench to drain
   (up to the timeout), then re-verifies and continues — the session never sits idle waiting
   for a user poke.
2. Verifier falsely reports "passed" once while work remains: the second verification pass
   returns not-passed with a next action; work continues instead of ending.
3. Verifier errors without a next action: one unverified continuation turn runs; the streak
   resets the next time the verifier produces a healthy next action; after 3 consecutive
   failures the loop stops with a warning.
4. User types a new message mid-mission: the loop yields immediately, the queued prompt runs,
   and the post-prompt loop re-arms as before.
