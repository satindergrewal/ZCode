// Enter the provider-visible embedded search branch by default. Bash find/grep prelude
// injection is controlled separately by the execution layer; a shell without function support must not change the model-visible
// tool/prompt surface。
const ENABLE_EMBEDDED_SEARCH_BRANCH = true;

export interface EmbeddedSearchBranchCapabilityContext {
  bashAvailable: boolean;
  embeddedSearchBranchEnabled?: boolean;
}

export type EmbeddedSearchBranchCapabilityReason =
  | "supported"
  | "disabled_by_global_flag"
  | "bash_unavailable";

export interface EmbeddedSearchBranchCapabilityDecision {
  reason: EmbeddedSearchBranchCapabilityReason;
  useEmbeddedSearchBranch: boolean;
}

export function evaluateEmbeddedSearchBranchCapability(
  context: EmbeddedSearchBranchCapabilityContext,
): EmbeddedSearchBranchCapabilityDecision {
  const branchEnabled = context.embeddedSearchBranchEnabled ?? ENABLE_EMBEDDED_SEARCH_BRANCH;

  if (!branchEnabled) {
    return {
      reason: "disabled_by_global_flag",
      useEmbeddedSearchBranch: false,
    };
  }

  if (!context.bashAvailable) {
    return {
      reason: "bash_unavailable",
      useEmbeddedSearchBranch: false,
    };
  }

  return {
    reason: "supported",
    useEmbeddedSearchBranch: true,
  };
}

export function resolveEmbeddedSearchBranchCapability(input: {
  bashAvailable: boolean;
  embeddedSearchBranchEnabled?: boolean;
}): EmbeddedSearchBranchCapabilityDecision {
  return evaluateEmbeddedSearchBranchCapability({
    bashAvailable: input.bashAvailable,
    embeddedSearchBranchEnabled: input.embeddedSearchBranchEnabled,
  });
}
