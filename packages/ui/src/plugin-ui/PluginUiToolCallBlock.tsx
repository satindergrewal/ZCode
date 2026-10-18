import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { McpToolCallBlock } from "@/ToolCallBlocks/renderers/mcp.js";
import { usePluginUiToolCallModel } from "@/plugin-ui/adapters/usePluginUiToolCallModel.js";
import { PluginUiToolCallView } from "@/plugin-ui/components/PluginUiToolCallBlock.js";
import { readPluginUiPresentation } from "@/plugin-ui/domain/readPluginUiPresentation.js";

/** Host tool-row render slot; the plain MCP card is injected as a display dependency outside the module. */
export function PluginUiToolCallBlock(context: ToolCallBlockRenderContext) {
  const model = usePluginUiToolCallModel(context);
  return <PluginUiToolCallView {...model} fallback={<McpToolCallBlock {...context} />} />;
}
export function shouldRenderPluginUi(
  context: Pick<ToolCallBlockRenderContext, "toolCallNode" | "pluginUi">,
): boolean {
  return Boolean(
    context.pluginUi?.scope.sessionId &&
    readPluginUiPresentation(context.toolCallNode.toolCall.raw),
  );
}
