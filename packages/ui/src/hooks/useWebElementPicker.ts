import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "@/logger.js";
import {
  dispatchWebElementContextAddToChat,
  isWebElementContextPayload,
  type WebElementContextPayload,
} from "@/lib/webElementContext.js";
import {
  buildCancelWebElementPickerScript,
  buildWebElementPickerScript,
  type WebElementPickerScriptLabels,
  type WebElementPickerScriptResult,
} from "@/lib/webElementPickerScript.js";

interface UseWebElementPickerOptions {
  /**
   * Transport-agnostic script execution outlet: runs the picker script in the target page
   * and returns the result. UnifiedBrowserView goes through main-process IPC
   * (executeJavaScript).
   */
  executeJs: (script: string) => Promise<unknown>;
  workspacePath: string;
  workspaceIdentity?: string;
  labels?: Partial<WebElementPickerScriptLabels>;
}

function isWebElementPickerScriptResult(result: unknown): result is WebElementPickerScriptResult {
  if (typeof result !== "object" || result === null) {
    return false;
  }

  const candidate = result as WebElementPickerScriptResult;
  return (
    candidate.status === "cancelled" ||
    (candidate.status === "selected" &&
      typeof candidate.element === "object" &&
      candidate.element !== null)
  );
}

function buildPayload(params: {
  result: Extract<WebElementPickerScriptResult, { status: "selected" }>;
  workspacePath: string;
  workspaceIdentity?: string;
}): WebElementContextPayload | null {
  const payload: WebElementContextPayload = {
    ...params.result.element,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  };

  return isWebElementContextPayload(payload) ? payload : null;
}

function sanitizeUrlForLog(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/u)[0] ?? "";
  }
}

export function useWebElementPicker({
  executeJs,
  workspacePath,
  workspaceIdentity,
  labels,
}: UseWebElementPickerOptions) {
  const [isPicking, setIsPicking] = useState(false);
  const activePickerRunRef = useRef(0);
  // The executeJs reference may change every render; pin it in a ref so useCallback does not
  // depend on it and get rebuilt on every render.
  const executeJsRef = useRef(executeJs);
  executeJsRef.current = executeJs;

  const cancelPicking = useCallback(async () => {
    activePickerRunRef.current += 1;
    setIsPicking(false);

    try {
      await executeJsRef.current(buildCancelWebElementPickerScript());
    } catch (error) {
      logger.debug("[UnifiedBrowserView] Failed to cancel web element picker", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const startPicking = useCallback(async () => {
    const runId = activePickerRunRef.current + 1;
    activePickerRunRef.current = runId;
    setIsPicking(true);
    logger.info("[UnifiedBrowserView] Web element picker started");

    try {
      const result = await executeJsRef.current(
        buildWebElementPickerScript(labels ? { labels } : {}),
      );
      if (activePickerRunRef.current !== runId) {
        return;
      }

      if (!isWebElementPickerScriptResult(result)) {
        logger.warn("[UnifiedBrowserView] Web element picker returned an unrecognized result");
        return;
      }

      if (result.status === "cancelled") {
        logger.info("[UnifiedBrowserView] Web element picker cancelled");
        return;
      }

      const payload = buildPayload({
        result,
        workspacePath,
        workspaceIdentity,
      });
      if (!payload) {
        logger.warn("[UnifiedBrowserView] Invalid web element context; discarded");
        return;
      }

      dispatchWebElementContextAddToChat(payload);
      logger.info("[UnifiedBrowserView] Web element context added to chat", {
        tagName: payload.tagName,
        url: sanitizeUrlForLog(payload.pageUrl),
      });
    } catch (error) {
      logger.warn("[UnifiedBrowserView] Web element picker failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (activePickerRunRef.current === runId) {
        setIsPicking(false);
      }
    }
  }, [labels, workspaceIdentity, workspacePath]);

  const togglePicking = useCallback(async () => {
    if (isPicking) {
      await cancelPicking();
      return;
    }
    await startPicking();
  }, [cancelPicking, isPicking, startPicking]);

  useEffect(() => {
    if (!isPicking) {
      return;
    }

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      // While the hosted view has focus, the injected script handles Esc; this fallback
      // cancel covers focus still on the outer toolbar so the picker never gets stuck
      // because of where focus sits.
      void cancelPicking();
    };

    window.addEventListener("keydown", handleWindowKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown, true);
    };
  }, [cancelPicking, isPicking]);

  useEffect(() => {
    return () => {
      void cancelPicking();
    };
  }, [cancelPicking]);

  return {
    cancelPicking,
    isPicking,
    startPicking,
    togglePicking,
  };
}
