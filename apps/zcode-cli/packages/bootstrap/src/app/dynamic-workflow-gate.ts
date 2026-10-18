import { join } from "node:path";
import type { SkillRoot } from "@zcode/contracts";
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "./bundled-skills.js";

/**
 * The app assembly layer filters companion skills by the dynamic-workflow flag.
 * Tool-surface subtraction lives in core's registerBuiltInTools; the `/` catalog and `/workflow` expansion subtraction live in
 * zcode-protocol/slash-commands.ts and builtin-prompt-command.ts; this file only removes skills needing bootstrap-side path derivation.
 */

const SKILL_MANIFEST_FILE_NAME = "SKILL.md";

/**
 * Absolute SKILL.md paths to remove from skill discovery when dynamic workflows are disabled.
 *
 * Why filter by path, not root: NodeSkillAdapter offers `disabledPaths` as its only removal mechanism
 * (config.json's `skill.<path>.enable=false` uses it too). The input is the bundled skill pack root
 * (bundled-skills.ts); a missing path is just a never-matching Set member with no side effects, and skills later added
 * to the pack that are unrelated to the dynamic-workflow flag are not caught in the net either.
 */
export function collectDynamicWorkflowDisabledSkillPaths(
  bundledSkillRoots: readonly SkillRoot[],
): string[] {
  return bundledSkillRoots.map((root) =>
    join(root.path, DYNAMIC_WORKFLOW_SKILL_NAME, SKILL_MANIFEST_FILE_NAME),
  );
}
