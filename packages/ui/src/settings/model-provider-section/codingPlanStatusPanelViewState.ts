import type { CodingPlanStatus } from "./constants.js";

export interface CodingPlanStatusPanelViewState {
  displayStatus: CodingPlanStatus;
  actionStatus: CodingPlanStatus;
  balanceStatus: CodingPlanStatus;
  loginLoading: boolean;
}

export function resolveCodingPlanStatusPanelViewState({
  status,
  loginPending,
}: {
  status: CodingPlanStatus;
  loginPending: boolean;
}): CodingPlanStatusPanelViewState {
  if (!loginPending) {
    return buildStableCodingPlanStatusPanelViewState(status, false);
  }

  if (status === "purchased" || status === "notPurchased") {
    // Both statuses come from a resolved entitlement snapshot. During background refresh, keep
    // showing the cached result with only a loading marker so the detail pane does not flicker
    // between stale data and checking.
    return buildStableCodingPlanStatusPanelViewState(status, true);
  }

  return {
    // Login-pending and entitlement-checking are different semantics.
    // The logged-in status copy must reflect checking, while the button keeps its pre-click state
    // with a spinner; the Start Plan balance card must not appear early due to login pending.
    displayStatus: "checking",
    actionStatus: status,
    balanceStatus: status,
    loginLoading: true,
  };
}

function buildStableCodingPlanStatusPanelViewState(
  status: CodingPlanStatus,
  loginLoading: boolean,
): CodingPlanStatusPanelViewState {
  return {
    displayStatus: status,
    actionStatus: status,
    balanceStatus: status,
    loginLoading,
  };
}
