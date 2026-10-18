import type { GenUiTweakMessage, GenUiTweakResult } from "@zcode/shared/gen-ui";

/** Type boundary validated by the Gen UI message schema; function bodies stay upstream JavaScript. */
export function installGenUiTweakRuntime(
  callTool: (
    name: "__zcode_visualization_annotations__",
    message: GenUiTweakMessage,
  ) => Promise<GenUiTweakResult>,
): void;
