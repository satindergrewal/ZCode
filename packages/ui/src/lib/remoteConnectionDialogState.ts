import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";

interface RemoteConnectionDialogSnapshot {
  currentStep: RemoteWizardStep;
  loading: boolean;
  connectedSessionId: string | null;
}

type RemoteConnectionCompletionStatus = "success" | "error";

interface RemoteConnectionCompletionDialogState {
  open: boolean;
  step: RemoteWizardStep;
}

interface RemoteConnectionDirectoryFailureState {
  connectedSessionId: string | null;
  step: RemoteWizardStep;
}

export function isRemoteConnectionFlowActive(snapshot: RemoteConnectionDialogSnapshot): boolean {
  return snapshot.loading || Boolean(snapshot.connectedSessionId);
}

export function shouldResetRemoteConnectionOnOpen(
  snapshot: RemoteConnectionDialogSnapshot,
): boolean {
  return !isRemoteConnectionFlowActive(snapshot);
}

export function getRemoteConnectionCompletionDialogState(
  status: RemoteConnectionCompletionStatus,
): RemoteConnectionCompletionDialogState {
  return {
    // Once the connection dialog is dismissed, completion only advances internal state without re-showing it,
    // leaving the user elsewhere with no directory picker or failure reason. Always raise the dialog to the result step.
    open: true,
    step: status === "success" ? "directory" : "connecting",
  };
}

export function getRemoteConnectionDirectoryFailureState(params: {
  connectedSessionId: string;
  sessionStillRegistered: boolean;
}): RemoteConnectionDirectoryFailureState {
  if (params.sessionStillRegistered) {
    return {
      connectedSessionId: params.connectedSessionId,
      step: "directory",
    };
  }

  // A failed workspace init recycles the unconfirmed logical session; holding the old sessionId in the
  // directory step yields empty services and an eternal "loading". Send the user back to settings.
  return {
    connectedSessionId: null,
    step: "settings",
  };
}
