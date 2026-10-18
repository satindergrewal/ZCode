export interface RemoteServerBundleValidationInput {
  bundledInputs: string[];
  source: string;
}

const unresolvedUndiciRuntimeImportPattern = /\b(?:require|import)\d*\(["']undici["']\)/;

export function validateRemoteServerBundle({ source }: RemoteServerBundleValidationInput): void {
  const hasUnresolvedUndiciRuntimeImport = unresolvedUndiciRuntimeImportPattern.test(source);

  if (hasUnresolvedUndiciRuntimeImport) {
    // Remote deploy uploads a single zcode-server.cjs into ~/.zcode/server/.
    // A bare undici runtime import left in the bundle is the only signal that
    // the remote still depends on node_modules; if the code no longer uses
    // undici, do not mistake "no dependency" for "not inlined".
    throw new Error(
      'Remote server bundle must inline undici. Found unresolved runtime dependency "undici".',
    );
  }
}
