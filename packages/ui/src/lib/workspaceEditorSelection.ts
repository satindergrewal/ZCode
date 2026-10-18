import type { EditorInfo, OpenInEditorRemoteTarget, RemoteTarget } from "@zcode/shared";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";

const REMOTE_SSH_EDITOR_IDS = ["vscode", "vscode-insiders"];
const REMOTE_WSL_EDITOR_IDS = ["vscode", "vscode-insiders", "explorer"];

type WorkspaceEditorSelectionKind = "preferred" | "fallback" | "empty" | "explicit";

interface WorkspaceEditorSelectionState {
  availableEditors: EditorInfo[];
  selectedEditor: EditorInfo | null;
  selectionKind: Exclude<WorkspaceEditorSelectionKind, "explicit">;
}

export function resolveWorkspaceFileManagerEditor(
  availableEditors: EditorInfo[],
  remoteTarget?: RemoteTarget | OpenInEditorRemoteTarget,
): EditorInfo | null {
  // WSL Explorer already handles UNC mapping, so "reveal in file manager" must reuse the same
  // editor entry as "open with -> Explorer"; SSH/Docker keep failing closed.
  if (remoteTarget?.kind !== "wsl") {
    return null;
  }
  return availableEditors.find((editor) => editor.id === "explorer") ?? null;
}

function filterEditorsByIdOrder(
  installedEditors: EditorInfo[],
  orderedIds: string[],
): EditorInfo[] {
  return orderedIds
    .map((id) => installedEditors.find((editor) => editor.id === id) ?? null)
    .filter((editor): editor is EditorInfo => editor !== null);
}

export function resolveWorkspaceEditorSelection({
  installedEditors,
  selectedEditorId,
  remoteTarget,
}: {
  installedEditors: EditorInfo[];
  selectedEditorId: string | null;
  remoteTarget?: RemoteTarget | OpenInEditorRemoteTarget;
}): WorkspaceEditorSelectionState {
  let availableEditors: EditorInfo[];

  if (remoteTarget?.kind === "ssh") {
    // SSH workspace paths exist only remotely; local apps such as Finder/Explorer/Terminal cannot
    // open `/root/...` directly and would land in a wrong or nonexistent local directory.
    availableEditors = filterEditorsByIdOrder(installedEditors, REMOTE_SSH_EDITOR_IDS);
  } else if (remoteTarget?.kind === "wsl") {
    // WSL workspacePath is a Linux path; only VS Code Remote-WSL and the Windows Explorer UNC
    // boundary consume it correctly. Other local editors must not receive bare `/home/...`.
    availableEditors = filterEditorsByIdOrder(installedEditors, REMOTE_WSL_EDITOR_IDS);
  } else if (remoteTarget) {
    // Remote paths (Docker etc.) have no URI/UNC mapping a local editor can consume;
    // offering local apps would treat the Linux path as local -- fail closed at the capability layer.
    availableEditors = [];
  } else {
    availableEditors = sortInstalledEditorsForOpenWith(installedEditors);
  }
  const preferredEditor =
    selectedEditorId === null
      ? null
      : (availableEditors.find((editor) => editor.id === selectedEditorId) ?? null);
  const fallbackEditor = availableEditors[0] ?? null;

  if (preferredEditor) {
    return {
      availableEditors,
      selectedEditor: preferredEditor,
      selectionKind: "preferred",
    };
  }

  return {
    availableEditors,
    selectedEditor: fallbackEditor,
    selectionKind: fallbackEditor ? "fallback" : "empty",
  };
}

export function shouldPersistWorkspaceEditorSelection(
  selectionKind: WorkspaceEditorSelectionKind,
): boolean {
  // SSH workspaces can auto-fallback to VS Code once local apps are filtered out.
  // That fallback is not a user choice and must not overwrite the global editor preference used for local workspaces.
  return selectionKind === "explicit";
}
