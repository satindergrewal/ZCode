import { memo, useMemo } from "react";
import type { PluginUiScopeRef } from "@zcode/shared/mcp-apps";
import { readPluginUiScopeRef, type PluginUiSidePaneTab } from "@/plugin-ui/contract.js";
import {
  PluginUiConversationScope,
  usePluginUiSidePaneModel,
} from "@/plugin-ui/adapters/usePluginUiSidePaneModel.js";
import { PluginUiSidePaneView } from "@/plugin-ui/components/PluginUiSidePane.js";

type Props = {
  tab: PluginUiSidePaneTab;
  onOpenBrowserUrl?: (url: string) => void;
  /** Host closes this tab when the page asks to return inline. */
  onCloseTab?: (tabId: string) => void;
};
function Content(props: Props & { scopeRef: PluginUiScopeRef }) {
  return <PluginUiSidePaneView {...usePluginUiSidePaneModel(props)} />;
}

/** Module assembly: wires the read-only session adapter to the pure view. */
export const PluginUiSidePane = memo(function PluginUiSidePane(props: Props) {
  const scopeRef = useMemo(
    () => readPluginUiScopeRef(props.tab),
    [props.tab.surfaceId, props.tab.toolCallId],
  );
  if (!scopeRef) return null;
  return (
    <PluginUiConversationScope tab={props.tab}>
      <Content {...props} scopeRef={scopeRef} />
    </PluginUiConversationScope>
  );
});
