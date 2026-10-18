import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@zcode/shared";
import type { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import { logger } from "@/logger.js";

/**
 * Onboarding gate: needsOnboarding=true when the local record has no entry for the user.
 * settings backfill (preference restore on account switch) happens only after the userId changes;
 * manual edits write back via updateRecordPreferences, so the record is always the latest.
 *
 * Returns [needsOnboarding, markOnboarded]: null while deciding; markOnboarded flips false
 * after the save persists; no re-trigger this session.
 */
export function useOnboardingTrigger(options: {
  onboardingRecord: ReturnType<typeof useOnboardingRecordService>;
  userId: string | null;
  hasStoredOccupation: boolean;
  loadDeviceMid: () => string;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}): [boolean | null, () => void] {
  const { onboardingRecord, userId, hasStoredOccupation, loadDeviceMid, update } = options;
  // null while the async check runs (record-based; docs/onboarding-record-spec.md).
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);
  // Last decided userId; backfill only on a real identity change (see below).
  const lastSyncedUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const fallback = () => !hasStoredOccupation;
    // Without the service (test doubles/unregistered host), fall back to the settings check.
    if (!onboardingRecord) {
      setNeedsOnboarding(fallback());
      return;
    }
    // shouldOnboard is RPC and hangs without the onboarding-record channel;
    // rendering null meanwhile blacked out the app. Time out into the settings check,
    // so the main UI waits at most 3s.
    const timeout = setTimeout(() => {
      if (!cancelled) {
        logger.warn("[occupation-onboarding] shouldOnboard timed out; falling back to settings");
        setNeedsOnboarding(fallback());
      }
    }, 3000);
    // Login claims first: an anonymous record transfers to the account on login,
    // one person never twice; await the claim or shouldOnboard reads the pre-claim file.
    onboardingRecord
      .claimAnonymousRecord()
      .catch((cause: unknown) => {
        logger.warn("[occupation-onboarding] failed to claim anonymous onboarding record", {
          error: String(cause),
        });
      })
      .then(() => onboardingRecord.shouldOnboard(loadDeviceMid()))
      .then(
        (result) => {
          if (!cancelled) setNeedsOnboarding(result);
          // Account switch: settings are global, so B triggering after A would push B's answers;
          // returning to A restores from the record's latest entry. Sync failures log only.
          // Backfill only from a different non-null identity (A->B, B->logout); null->id skips
          // (startup OAuth and runtime login share the path); under-backfilling
          // only affects the rare apikey-then-login-old-account case.
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
                logger.warn("[occupation-onboarding] failed to sync preferences from record", {
                  error: String(cause),
                });
              });
          }
        },
        (cause) => {
          logger.warn("[occupation-onboarding] shouldOnboard check failed", {
            error: String(cause),
          });
          if (!cancelled) setNeedsOnboarding(fallback());
        },
      )
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // Not hasStoredOccupation (that is settings.onboardingOccupation): save success rewrites it,
    // record-write failure reopens onboarding in place, missing record re-arms next launch.
  }, [onboardingRecord, userId, loadDeviceMid]);
  return [needsOnboarding, () => setNeedsOnboarding(false)];
}
