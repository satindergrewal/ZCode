import type { ExecutionShellSelection } from "@zcode/contracts";

// The provider-visible embedded branch is on by default; the execution layer injects find()/grep() aliases only into
// session shells that explicitly support POSIX shell functions.
const ENABLE_EMBEDDED_SEARCH_BASH_PRELUDE = true;

export function shouldInjectEmbeddedSearchBashPrelude(): boolean {
  return ENABLE_EMBEDDED_SEARCH_BASH_PRELUDE;
}

export function supportsEmbeddedSearchShellSelection(
  selection: ExecutionShellSelection | undefined,
): boolean {
  return selection?.dialect === "posix" || selection?.dialect === "git-bash";
}
