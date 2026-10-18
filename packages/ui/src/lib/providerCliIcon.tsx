import type { ZCodeProvider } from "@zcode/shared";
import { GlmMonochromeIcon } from "@/components/ui/GlmMonochromeIcon.js";

export function renderProviderCliIcon(_provider: ZCodeProvider = "glm", className?: string) {
  // Only the glm provider remains; keep the original logo shape, just grayscale it.
  // The earlier outline treatment was more strictly mono but lost too much brand recognition;
  // a unified filter keeps the real logo while toning the color down.
  return <GlmMonochromeIcon className={className} />;
}
