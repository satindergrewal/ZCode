import { useServices } from "./useServices.js";

/**
 * Onboarding completion record service (persisted locally, uploaded later).
 * Returns null when legacy test doubles / unsupported hosts have no such service; callers
 * must null-check and degrade. Pure render tests without a ServiceProvider (where the
 * service is irrelevant to the behavior under test) also get null instead of a throw —
 * useContext is called inside try on every render, keeping hook order stable.
 */
export function useOnboardingRecordService() {
  try {
    const services = useServices();
    return services.onboardingRecordService ?? null;
  } catch {
    return null;
  }
}
