import { useEffect, useState } from "react";

/**
 * Reuses the 5s operation deadline of the browser-use tab cursor icon.
 * The icon and the in-browser hint must share this one check so they never disagree about the tool still running.
 */
export function useBrowserUseOperationActive(operationUntil = 0): boolean {
  const [expiredOperationUntil, setExpiredOperationUntil] = useState(0);
  const isActive = operationUntil > Date.now() && expiredOperationUntil !== operationUntil;

  useEffect(() => {
    const remainingMs = operationUntil - Date.now();
    if (remainingMs <= 0) return;
    const timer = window.setTimeout(() => setExpiredOperationUntil(operationUntil), remainingMs);
    return () => window.clearTimeout(timer);
  }, [operationUntil]);

  return isActive;
}
