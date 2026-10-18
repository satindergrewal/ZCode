const EMPTY_TOOL_NAME_PLACEHOLDER = "empty_tool_name";

/**
 * Empty-name recovery only serves model continuation and must not materialize as a user-visible tool row.
 * Fixed placeholder strings can also be legitimate registry / MCP / alias tool names, so they alone do not justify hiding.
 * live recognizes only the original empty name; cold/legacy also requires the placeholder plus persisted original-name metadata.
 */
export function shouldHideInvalidToolCallFromProduct(
  toolName: unknown,
  metadata?: Record<string, unknown>,
): boolean {
  if (typeof toolName !== "string") return false;
  if (toolName.trim().length === 0) return true;

  const providerToolName = metadata?.providerToolName;
  return (
    toolName === EMPTY_TOOL_NAME_PLACEHOLDER &&
    providerToolName !== undefined &&
    typeof providerToolName === "string" &&
    providerToolName.trim().length === 0
  );
}
