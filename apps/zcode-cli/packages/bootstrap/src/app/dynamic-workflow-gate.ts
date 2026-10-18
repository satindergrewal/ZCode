import { join } from "node:path";
import type { SkillRoot } from "@zcode/contracts";
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "./bundled-skills.js";

/**
 * The dynamic-workflow gradation gate's skill subtraction at the App assembly layer (docs/dynamic-workflow/launch.md "Gray release").
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
 * unrelated-to-gradation skills are not swept up with them.
 */
export function collectDynamicWorkflowDisabledSkillPaths(
  bundledSkillRoots: readonly SkillRoot[],
): string[] {
  return bundledSkillRoots.map((root) =>
    join(root.path, DYNAMIC_WORKFLOW_SKILL_NAME, SKILL_MANIFEST_FILE_NAME),
  );
}
