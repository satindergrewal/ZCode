/**
 * Presentation-only rules for pending questions (escalations).
 *
 * Split out of workflowRunPanel.ts (same precedent as WorkflowRunSidePaneSections.tsx: the
 * eslint max-lines 400 gate). That file carries the detail page four existing rule groups (budget math, Cancel availability,
 * result decision, event-row summaries); escalation questions are a new vocabulary family that would push it past the gate.
 */

const WAITED_MINUTE_MS = 60_000;
const WAITED_HOUR_MS = 60 * WAITED_MINUTE_MS;
const WAITED_DAY_MS = 24 * WAITED_HOUR_MS;

/**
 * The little intl capability this module needs is declared locally instead of borrowed from workflowRunPanel.
 *
 * It is a structural type, so two copies cannot drift (the shape is fixed by react-intl formatMessage); importing
 * the type would cost a module dependency we do not want - splitting the file was exactly to avoid that dependency.
 */
type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

/**
 * "How long has this question been waiting" - the first thing a reader asks about a pending question.
 *
 * Pure function; `now` is injected by the caller (the component feeds fresh ticks): a waiting run **emits no events**,
 * so it cannot rely on "recompute at the next projection update" - a question stuck for half an hour would keep showing "just now".
 *
 * Copy reuses the existing `sidePane.time.*` family (present in both locales) instead of new keys for the same meaning.
 *
 * Three edges worth recording:
 *   - `askedAt` absent (events replayed from old journals lack it) -> return undefined and render no label at all,
 *     instead of a made-up "just now".
 *   - Clock skew putting `askedAt` in the future (askedAt is minted by the CLI process, a different machine from the renderer
 *     under remote sessions) -> clamp to "just now"; a negative duration reads worse than no label.
 *   - The ladder ends at days: stalled questions may wait forever by design (no timeout), so the upper bound needs a story.
 */
export function workflowRunQuestionWaitedLabel(
  askedAt: number | undefined,
  now: number,
  formatMessage: FormatMessage,
): string | undefined {
  if (askedAt === undefined || !Number.isFinite(askedAt)) return undefined;
  const elapsed = now - askedAt;
  if (elapsed < WAITED_MINUTE_MS) return formatMessage({ id: "sidePane.time.justNow" });
  if (elapsed < WAITED_HOUR_MS) {
    return formatMessage(
      { id: "sidePane.time.minutesAgo" },
      { count: String(Math.floor(elapsed / WAITED_MINUTE_MS)) },
    );
  }
  if (elapsed < WAITED_DAY_MS) {
    return formatMessage(
      { id: "sidePane.time.hoursAgo" },
      { count: String(Math.floor(elapsed / WAITED_HOUR_MS)) },
    );
  }
  return formatMessage(
    { id: "sidePane.time.daysAgo" },
    { count: String(Math.floor(elapsed / WAITED_DAY_MS)) },
  );
}
