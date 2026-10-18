/**
 * useTokenRefresh — token refresh hook (resident layer).
 *
 * Mount in Root or the App component so 401 refresh works at all times. Listens for the
 * global 401 event and calls oauthService.refreshToken.
 */
import { useCallback } from "react";
import { logger } from "../logger.js";
import { useServices } from "./useServices.js";

export function useTokenRefresh() {
  const { oauthService } = useServices();

  /** Try to refresh the token; returns false on failure. */
  const tryRefresh = useCallback(async (): Promise<boolean> => {
    try {
      await oauthService.refreshToken();
      logger.info("[useTokenRefresh] token refreshed");
      return true;
    } catch (err) {
      logger.error("[useTokenRefresh] token refresh failed:", err);
      return false;
    }
  }, [oauthService]);

  /** Clear credentials for every provider. */
  const clearCredentials = useCallback(async () => {
    await oauthService.logoutAll();
  }, [oauthService]);

  return { tryRefresh, clearCredentials };
}
