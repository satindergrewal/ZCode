import { useCallback, useEffect, useMemo, useState } from "react";
import { isZCodeAgentProvider, ZCODE_AGENT_PROVIDER, type ZCodeProvider } from "@zcode/shared";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import {
  buildModelConfigMissingUiError,
  type ModelConfigMissingUiError,
} from "@/lib/chatPrepareError.js";
import { logger } from "@/logger.js";

type DraftModelReadinessStatus = "checking" | "ready" | "missing" | "check-failed";

interface DraftModelReadinessState {
  gateKey: string;
  status: DraftModelReadinessStatus;
  dismissed: boolean;
}

export interface DraftModelReadinessGate {
  /** Enter workspace prepare/prewarm only once readiness is confirmed or the check itself is unavailable. */
  agentStartupAllowed: boolean;
  error: ModelConfigMissingUiError | null;
  dismissError(): void;
  /** Authoritative recheck for first-send admission; false keeps the composer and returns blocked. */
  ensureReadyForSend(): Promise<boolean>;
  /** When the Host gate races the UI recheck, re-project the same error onto the draft banner. */
  markProviderNotReady(): void;
}

export function resolveModelSelectionReadinessStatus(
  view: ModelSelectionView,
): Extract<DraftModelReadinessStatus, "ready" | "missing"> {
  return view.providers.some((provider) => provider.models.length > 0) ? "ready" : "missing";
}

/**
 * V4 draft provider/model admission.
 *
 * The V4 migration deleted the legacy useWorkspacePrepare renderer readiness gate; a draft first-send
 * registers the pending command and the Host rejects with provider_not_ready. That deterministic rejection then
 * reads as unknown in the recovery ledger. This restores the UI-side gate; the Host gate keeps process-race backup.
 */
export function useDraftModelReadinessGate(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  sessionId: string | null;
  modelSelectionService: Pick<IModelSelectionService, "getView" | "onDidChange">;
}): DraftModelReadinessGate {
  const { workspacePath, workspaceIdentity, provider, sessionId, modelSelectionService } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const enabled = sessionId === null && isZCodeAgentProvider(displayProvider);
  const gateKey = `${workspaceKey}\u0000${displayProvider}`;
  const [state, setState] = useState<DraftModelReadinessState>(() => ({
    gateKey,
    status: enabled ? "checking" : "ready",
    dismissed: false,
  }));

  const commitStatus = useCallback(
    (status: DraftModelReadinessStatus, options: { revealMissing?: boolean } = {}) => {
      setState((current) => ({
        gateKey,
        status,
        dismissed:
          status === "missing"
            ? options.revealMissing
              ? false
              : current.gateKey === gateKey && current.status === "missing"
                ? current.dismissed
                : false
            : false,
      }));
    },
    [gateKey],
  );

  useEffect(() => {
    if (!enabled) {
      commitStatus("ready");
      return;
    }

    commitStatus("checking");
    let disposed = false;
    let registryEventVersion = 0;
    const applyStatus = (status: DraftModelReadinessStatus) => {
      if (disposed) return;
      commitStatus(status);
    };
    const subscription = modelSelectionService.onDidChange((view) => {
      registryEventVersion += 1;
      applyStatus(resolveModelSelectionReadinessStatus(view));
    });
    const initialReadVersion = registryEventVersion;
    void modelSelectionService
      .getView()
      .then((view) => {
        // A read started before the change event and returning after loses; the event snapshot is newer, never overwritten.
        if (registryEventVersion !== initialReadVersion) return;
        applyStatus(resolveModelSelectionReadinessStatus(view));
      })
      .catch((error) => {
        handleReadinessFailure(error);
      });

    function handleReadinessFailure(error: unknown) {
      if (disposed) return;
      // A registry read error is not no-model. Keep the Host gate as backup, never showing a
      // transient app-global service fault as a user configuration problem.
      commitStatus("check-failed");
      logger.warn("[v4-draft-readiness] provider registry 检查失败，回落 Host 门禁", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
    }

    return () => {
      disposed = true;
      subscription?.dispose();
    };
  }, [commitStatus, enabled, modelSelectionService, workspaceKey]);

  const effectiveState: DraftModelReadinessState =
    state.gateKey === gateKey
      ? state
      : { gateKey, status: enabled ? "checking" : "ready", dismissed: false };

  const markProviderNotReady = useCallback(() => {
    commitStatus("missing", { revealMissing: true });
  }, [commitStatus]);

  const ensureReadyForSend = useCallback(async (): Promise<boolean> => {
    if (!enabled) return true;
    try {
      const view = await modelSelectionService.getView();
      const status = resolveModelSelectionReadinessStatus(view);
      commitStatus(status, { revealMissing: status === "missing" });
      if (status === "missing") {
        logger.info("[v4-draft-readiness] 无可用 provider/model，草稿首发在 UI admission 拒绝", {
          providerCount: view.providers.length,
          revision: view.revision,
          workspaceKey,
        });
        return false;
      }
      return true;
    } catch (error) {
      // As at mount: a registry failure never poses as no-model; the Host startup gate decides.
      commitStatus("check-failed");
      logger.warn("[v4-draft-readiness] 首发复查 provider registry 失败，回落 Host 门禁", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
      return true;
    }
  }, [commitStatus, enabled, modelSelectionService, workspaceKey]);

  const error = useMemo(
    () =>
      enabled && effectiveState.status === "missing" && !effectiveState.dismissed
        ? buildModelConfigMissingUiError()
        : null,
    [effectiveState.dismissed, effectiveState.status, enabled],
  );

  const dismissError = useCallback(() => {
    setState((current) =>
      current.gateKey === gateKey && current.status === "missing"
        ? { ...current, dismissed: true }
        : current,
    );
  }, [gateKey]);

  return {
    agentStartupAllowed:
      !enabled || effectiveState.status === "ready" || effectiveState.status === "check-failed",
    error,
    dismissError,
    ensureReadyForSend,
    markProviderNotReady,
  };
}
