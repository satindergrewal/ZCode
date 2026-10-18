import { z } from "zod";

/** auto stays an internal permission; plan is accepted only at the legacy-format read boundary. */
export const executionPermissionModeSchema = z.enum(["build", "edit", "yolo", "guarded", "auto"]);
export const executionStateSchema = z.object({
  mode: executionPermissionModeSchema,
  planEnabled: z.boolean(),
});
export type ExecutionState = z.infer<typeof executionStateSchema>;

/** Legacy request semantics are pinned at the admission boundary; queue consumption must not reinterpret them per current config. */
export function resolveExecutionState(
  input: { mode?: string; planEnabled?: boolean },
  current: ExecutionState = { mode: "build", planEnabled: false },
): ExecutionState {
  const mode = executionPermissionModeSchema.safeParse(input.mode);
  return {
    mode: mode.success ? mode.data : current.mode,
    planEnabled:
      input.planEnabled ??
      (input.mode === "plan" ? true : mode.success ? false : current.planEnabled),
  };
}
