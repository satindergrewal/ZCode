import type { ProviderConfigObject } from "@zcode/provider";

/** Product-display exception: plan GLM-5.3 image input is server-side bridging, which must not be badged as native vision. */
export function shouldShowModelVisionBadge(
  modelId: string,
  supportsImage: boolean | null | undefined,
  access?: ProviderConfigObject["access"],
): boolean {
  if (supportsImage !== true) return false;
  // Trial plans are in the display exception too; like Coding Plan, hide only the GLM-5.3 badge.
  const hideGlm53Vision =
    access?.type === "zhipu-coding-plan-api-key" ||
    (access?.type === "zhipu-account" &&
      (access.mode === "individual-coding-plan" ||
        access.mode === "team-coding-plan" ||
        access.mode === "start-plan"));
  // Badge-only: never alters capability facts, attachment validation, or exact model identity; Flash and other models are unaffected.
  return !(hideGlm53Vision && modelId.toLowerCase() === "glm-5.3");
}
