# Spec: Goal Continuation Mission Hardening

## Problem

Long autonomous missions (hours to weeks, many tasks) stop even when a session goal is active
and the user gave explicit "do not stop until DONE" orders. Four harness-level holes let the
continuation machinery exit or hand control back to a human mid-mission:

1. **Background-deferral death**: when any background task (bench, serve, long shell job) was
   running at turn end, the continuation deferred once and the loop exited. Sessions that keep
   background work running (the normal case for GPU-box missions) never auto-continued.
2. **Single verifier pass ends the mission**: one verifier "passed" verdict permanently stopped
   continuation. A model status report claiming completion could fool a single verification.
3. **Verifier failure silently abandons the mission**: a verifier error without a usable next
   action stopped the loop as if the goal were done.
4. **Queue promotion pauses the goal**: sending or promoting a queued message during an active
   goal turn cancelled the turn AND paused the goal, forcing a manual play click after every
   mid-mission paste.

## Product Rules

- With an active session goal, the harness — not model discipline — owns continuation: after
  every turn (user prompt or background notification) the loop keeps issuing goal-continuation
  turns until the goal is verifiably complete.
- **Background-deferral waits**: when continuation defers because background tasks are running,
  the loop polls (20s interval) until they drain (timeout: `backgroundDeferralTimeoutMs`,
  default **7 days** — missions legitimately keep background work running for days) and then
  re-attempts verification, instead of exiting.
- **Completion needs confirmation**: the loop accepts completion only after
  `requiredCompletionConfirmations` (default 2) independent verifier passes in a row; any
  executed work resets the counter.
- **Verifier failures degrade, not abandon**: on a verifier failure without a next action, the
  loop runs one unverified continuation turn (generic goal prompt) and re-verifies; only after
  `maxFailureContinuations` (default 3) consecutive failures does it stop, with a
  `target.continuation.verifier_failure_cap_reached` warning.
- **Numeric criteria are met numerically**: if the objective states a measurable criterion (a
  threshold, an inequality, a parity requirement), the verifier requires that criterion to be
  met numerically in the evidence. Attribution, decomposition, or documentation of why the
  number was not reached is failure, not completion — even when the objective's own text offers
  an alternative narrative clause, unless the user superseded it in a later message.
- **A documented blocker does not complete the goal**: deliverables gated behind a hardware
  power state, an offline machine, or any external condition mean `passed=false` with the
  monitoring/resumption plan as `nextAction` — even when every currently-runnable step is done
  and a watchdog is armed.
- **Blocked work is monitored, not dropped**: the continuation prompt instructs the agent to
  set up automated monitoring (watchdog or scheduled re-check) that resumes gated work the
  moment the blocker clears; monitoring turns are expected and are not a reason to declare the
  objective done.
- **Queue promotion inserts, it does not halt**: sending or promoting a queued message during
  an active goal turn preempts the turn but leaves the goal ACTIVE (`suppressGoalPauseOnCancel`);
  the promoted prompt's own post-turn goal loop continues the mission with the new input
  included. User Stop and edit-retry keep the existing pause semantics.
- **Pauses are self-explaining**: every goal pause logs `target.paused_by_cancellation` with
  the cancellation reason (user stop, verifier interruption, or whatever aborted the turn).
- User input always wins: pending queued commands still yield the loop immediately; Stop pauses
  the goal as before.

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

## Blocker Semantics (anti-lazy-out contract)

The completion verifier's contract now states, explicitly:

- **A documented blocker does not complete the goal.** Deliverables that remain unmeasured or
  unfinished because of a hardware power state, an offline machine, or any external condition
  mean `passed=false` — even when every currently-runnable step is done, a watchdog or
  monitoring process is armed, and the blocker is documented. `nextAction` must describe the
  monitoring/resumption plan.
- The continuation prompt mirrors this: blocked work gets automated monitoring (watchdog or
  scheduled re-check) that resumes the gated work the moment the blocker clears; monitoring
  turns are expected and are not a reason to declare the objective done.
- Rationale: without this rule the verifier accepted "everything completable is done, blocker
  documented" as goal-complete, ending missions that had pending hardware-gated cells.

## Numeric-Criterion Contract

If the objective states a numeric or measurable criterion (a threshold, an inequality, a parity
requirement such as "EXL3 >= native in every cell"), the verifier requires that criterion to be
met **numerically** in the evidence. Reporting, attribution, decomposition, or documentation of
why the number was not reached is failure, not completion — even when the objective's own text
offers an alternative narrative clause, unless the user superseded it in a later message.

## Cold-Resume Auto-Reactivation

With mission mode enabled, `activatePausedTargetAfterResume` reactivates a paused goal on
session cold resume (instead of requiring `/goal resume`), and the bootstrap resume flow fires
the goal continuation loop immediately when the reactivated goal is active. Deliberate user
stops still pause; they are simply overridden by the next session resume under mission mode —
which is the intended semantics for autonomous missions. Without mission mode, the old
deliberate-stop semantics are preserved.

## Queue Promotion Auto-Resume

Sending or promoting a queued message during an active goal turn is an **insertion, not a
halt**: the running turn is preempted (`suppressGoalPauseOnCancel` on the foreground stop) and
the goal stays active, so the promoted prompt's own post-turn goal loop continues the mission
with the new input included. Applies to both queue promotions (`sendQueuedNow`) and start-now
submissions (`sendText startNow`). User Stop and edit-retry keep the existing pause semantics.

## Pause Forensics

Every goal pause logs `target.paused_by_cancellation` with the cancellation reason (user stop,
verifier interruption, or whatever aborted the turn). Without this, a mid-mission pause is
indistinguishable from a mysterious stop after the fact.

## State Owners

| State | Single Owner |
| ----- | ------------ |
| Continuation decision + streaks/counters | `runActiveTargetContinuationLoop` in `apps/zcode-cli/packages/core/src/runtime/methods/target-continuation-loop.ts` |
| Outcome classification (executed / completed / deferred-background / verifier-failed / skipped) | `executeTargetContinuationWithOutcome` in `methods/target.ts` |
| Goal-pause suppression flag | `suppressGoalPauseOnCancel` on `ActiveForegroundExecutionState`, set by `stopActiveForegroundExecution` |
| Verifier contract text | `formatGoalCompletionVerificationPrompt` + `formatGoalContinuationPrompt` in `apps/zcode-cli/packages/contracts/src/tools/target.ts` |
| Tunables | `AgentRuntimeConfig.targetCompletionVerification.{maxFailureContinuations, requiredCompletionConfirmations, backgroundDeferralTimeoutMs}` and `missionContinuation.{enabled, idleContinuationCap}` in `runtime/types.ts` |

## Interfaces

- `executeTargetContinuationCommand` keeps its `TurnResult | null` signature (thin wrapper).
- New exported `executeTargetContinuationWithOutcome` returns a discriminated outcome so the
  loop can distinguish "done / gone" from "verifier broken" from "background busy".
- `stopActiveForegroundExecution` gains `suppressGoalPauseOnCancel`.
- `preemptActiveTurnAndWait` gains `suppressGoalPauseOnCancel` (bootstrap promotion paths).
- `activatePausedTargetAfterResume` auto-reactivates paused goals under mission mode.
- Desktop setting `missionContinuationEnabled` (AppSettings + UI toggle) →
  `ZCODE_MISSION_CONTINUATION` env Desktop → Host → Agent.

## Acceptance Scenarios

1. Goal active, turn ends while a background bench runs: the loop waits for the bench to drain
   (up to 7 days), then re-verifies and continues — the session never sits idle waiting for a
   user poke.
2. Verifier falsely reports "passed" once while work remains: the second verification pass
   returns not-passed with a next action; work continues instead of ending.
3. Verifier errors without a next action: one unverified continuation turn runs; the streak
   resets the next time the verifier produces a healthy next action; after 3 consecutive
   failures the loop stops with a warning.
4. User types a new message mid-mission: the loop yields immediately, the queued prompt runs,
   and the post-prompt loop re-arms as before.
5. A queued message is promoted (send now) during an active goal turn: the turn is preempted,
   the goal stays ACTIVE, the promoted prompt runs, and the goal loop continues the mission
   with the promoted input included — no manual play click.
6. An objective with a numeric criterion ("EXL3 >= native per cell") is not met numerically:
   the verifier returns passed=false with a next action, regardless of any attribution or
   documentation narrative in the transcript.
7. A session cold-resumes (app restart) with mission mode on and a paused goal: the goal is
   auto-reactivated and the continuation loop fires without user action.
