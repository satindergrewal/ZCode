import { useCallback, useEffect, useRef, useState } from "react";

export const MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS = 1_200;

/**
 * Shared "run after typing stops" scheduler for provider text saves and Model Config Resolution.
 * New input only replaces a not-yet-fired timer; blur/Enter/save run the same action immediately via flush.
 */
export function useIdleTrigger<TResult>(
  action: () => TResult | Promise<TResult>,
  delayMs = MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS,
) {
  const actionRef = useRef(action);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scheduled, setScheduled] = useState(false);
  actionRef.current = action;

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setScheduled(false);
  }, []);

  const flush = useCallback(async (): Promise<TResult> => {
    cancel();
    return actionRef.current();
  }, [cancel]);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setScheduled(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setScheduled(false);
      // Idle-action failures surface via the owning form on the next blur/save; the timer itself
      // must not create an unhandled rejection, or one resolution failure pollutes the whole
      // Renderer debug path.
      try {
        void Promise.resolve(actionRef.current()).catch(() => undefined);
      } catch {
        // Sync failures also surface via the owning form's explicit flush.
      }
    }, delayMs);
  }, [delayMs]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    [],
  );

  return { cancel, flush, schedule, scheduled } as const;
}
