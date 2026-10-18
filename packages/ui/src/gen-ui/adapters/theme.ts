import { readPluginUiStyleVariables } from "@/plugin-ui/hostPrimitives.js";

/** Gen UI uses body-tier type and neutral controls; never MCP App tokens. */
export function readGenUiStyleVariables(): Record<string, string> {
  const variables = readPluginUiStyleVariables();
  const root = getComputedStyle(document.documentElement);
  const size = Number.parseFloat(root.getPropertyValue("--ui-font-size")) || 14;
  return {
    ...variables,
    "--font-text-md-size": `${size}px`,
    "--font-text-sm-size": `${Math.max(11, size - 2)}px`,
  };
}
