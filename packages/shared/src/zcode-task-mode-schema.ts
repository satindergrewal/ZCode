import { z } from "zod";

// Both the validation aggregator and the legacy protocol use this schema; it must stay in a leaf module with no reverse deps.
// Root cause: protocol imports it from validation, while validation imports protocol's resource-sampling schema --
// under ESM/Jiti in a clean Docker, bindings can be read before init and `.optional()` crashes at startup.
export const zcodeTaskModeSchema = z.enum([
  "default",
  "yolo",
  "guarded",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
]);
