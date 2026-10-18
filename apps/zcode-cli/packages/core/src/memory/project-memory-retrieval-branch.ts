export type ProjectMemoryRetrievalBranch = "default-index" | "semantic-recall";

// The default retrieval branch keeps Semantic Recall off for now; flipping it later touches this one value only.
const PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED = false;

export function resolveProjectMemoryRetrievalBranch(
  semanticRecallEnabled: boolean,
): ProjectMemoryRetrievalBranch {
  return semanticRecallEnabled ? "semantic-recall" : "default-index";
}

export const ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH = resolveProjectMemoryRetrievalBranch(
  PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED,
);
