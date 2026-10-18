import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@zcode/shared";
import type { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import { logger } from "@/logger.js";

/**
 * Onboarding trigger decision: needsOnboarding=true when the current user has no entry in the local records.
 * settings backfill (preference restore on account switch) happens only after the userId actually changes;
 * manual edits are written back by their entry points (updateRecordPreferences), so the record always equals that user's latest preferences.
 *
 * Returns [needsOnboarding, markOnboarded]: null means the async decision is pending; markOnboarded sets it to false once onboarding
 * saves successfully (record persisted; no re-trigger this session).
 */
export function useOnboardingTrigger(options: {
  onboardingRecord: ReturnType<typeof useOnboardingRecordService>;
  userId: string | null;
  hasStoredOccupation: boolean;
  loadDeviceMid: () => string;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}): [boolean | null, () => void] {
  const { onboardingRecord, userId, hasStoredOccupation, loadDeviceMid, update } = options;
  // null while the async decision is pending (based on local usage records).
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);
  // Remember the userId from the previous decision; backfill happens only after the identity actually changes (see the guard below).
  const lastSyncedUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const fallback = () => !hasStoredOccupation;
    // With the service unavailable (legacy test doubles / unregistered host), fall back to the legacy settings check; no behavior regression.
    if (!onboardingRecord) {
      setNeedsOnboarding(fallback());
      return;
    }
    // shouldOnboard goes over RPC and hangs when the host lacks the onboarding-record channel;
    // rendering null while pending used to black-screen the whole UI. A timeout falls back to the settings check,
    // so the main UI waits at most 3 seconds no matter what.
    const timeout = setTimeout(() => {
      if (!cancelled) {
        logger.warn("[occupation-onboarding] shouldOnboard timed out; falling back to the settings check");
        setNeedsOnboarding(fallback());
      }
    }, 3000);
    // Login claim runs first: onboarding answered while signed out (null entry) is handed to the user who signs in; never onboard the same person twice.
    // Await the claim before deciding, otherwise shouldOnboard reads the pre-claim file and wrongly triggers onboarding.
    onboardingRecord
      .claimAnonymousRecord()
      .catch((cause: unknown) => {
        logger.warn("[occupation-onboarding] Failed to claim the anonymous onboarding record", { error: String(cause) });
      })
      .then(() => onboardingRecord.shouldOnboard(loadDeviceMid()))
      .then(
        (result) => {
          if (!cancelled) setNeedsOnboarding(result);
          // Account switches restore that user's preferences: settings are not per user, so after A answers and B triggers onboarding,
          // B's answers would clobber settings; switching back to A re-follows the record latest answers. Sync failures only log.
          // Backfill only when the previous identity was a different non-empty one (direct A->B, B->sign-out). null->id does not backfill: startup OAuth
          // restore and runtime login share that sequence indistinguishably; prefer under-backfilling, since manual edits are written back
          // per entry (record = latest preferences); a missed backfill only affects corners like signing into an old account after apikey mode.
          const previousUserId = lastSyncedUserIdRef.current;
          lastSyncedUserIdRef.current = userId;
          if (!cancelled && !result && previousUserId != null && previousUserId !== userId) {
            void onboardingRecord
              .syncSettingsFromRecord()
              .then((patch) => {
                if (cancelled || !patch) return;
                return update(patch);
              })
              .catch((cause: unknown) => {
                logger.warn("[occupation-onboarding] Failed to sync preferences from the record", {
                  error: String(cause),
                });
              });
          }
        },
        (cause) => {
        logger.warn("[occupation-onboarding] shouldOnboard check failed", { error: String(cause) });
          if (!cancelled) setNeedsOnboarding(fallback());
        },
      )
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // Do not depend on hasStoredOccupation (mirrors settings?.onboardingOccupation): a successful save rewrites that field,
    // and a failed record write reopens onboarding inline; a missing record re-triggering is, by convention, left to the next startup.
  }, [onboardingRecord, userId, loadDeviceMid]);
  return [needsOnboarding, () => setNeedsOnboarding(false)];
}
