import { z } from "zod";

// Both the validation aggregate and the legacy protocol use this schema; it must stay a leaf with no reverse deps.
// Root cause: protocol imports it from validation, while validation imports protocol's resource-sampling schema,
// so in clean Docker ESM/Jiti reads an uninitialized binding and .optional() crashes at boot.
export const zcodeTaskModeSchema = z.enum(["yolo", "plan", "edit", "auto", "autoEdit", "build"]);
