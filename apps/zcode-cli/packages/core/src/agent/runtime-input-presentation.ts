import { parseRuntimeInputPresentation } from "@zcode/contracts";
import type { RuntimeMessageMetadata } from "./message-history.js";

/** The newer flag decides true input identity; the coordinator must not inherit the guide's real_user. */
export function runtimeInputMetadata(value: unknown): RuntimeMessageMetadata | undefined {
  const inputPresentation = parseRuntimeInputPresentation(value);
  if (!inputPresentation) return undefined;
  return {
    source: inputPresentation === "user_steer" ? "real_user" : "legacy_synthetic",
    inputPresentation,
  };
}
