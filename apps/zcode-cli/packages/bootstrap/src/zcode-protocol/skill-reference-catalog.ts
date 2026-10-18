// Read-only catalog for Composer skills.
// Separate from the Skills Settings management API: sessionId decides authority here; no enable/disable/delete.
import {
  zcodeSkillsReferenceCatalogParamsSchema,
  type ZCodeSkillReferenceCatalogEntry,
  type ZCodeSkillsReferenceCatalogResult,
} from "@zcode/shared";
import type { SkillLoadOutcome, SkillMetadata } from "@zcode/contracts";
import { listZCodeSkills } from "../skills.js";
import {
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

export async function getSkillReferenceCatalog(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeSkillsReferenceCatalogResult> {
  const params = parseParams(zcodeSkillsReferenceCatalogParamsSchema, rawParams);
  if (params.sessionId) {
    const record = requireSession(context, params.sessionId);
    const outcome = await record.app.getSkillCatalog();
    return toResult("session", outcome);
  }

  // The legacy UI cache scans only on first workspace mount, so skills added manually from the filesystem
  // leave new conversations on a stale snapshot. Draft requests reuse the CLI's real discovery config agent-side,
  // and every reference-panel open reads the current workspace catalog.
  const outcome = await listZCodeSkills({
    env: context.deps.env,
    includeVisualize: true,
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  return toResult("workspace", outcome);
}

function toResult(
  authority: ZCodeSkillsReferenceCatalogResult["authority"],
  outcome: SkillLoadOutcome,
): ZCodeSkillsReferenceCatalogResult {
  return {
    authority,
    // The bundled skill pack (bundled-skills.ts) stays out of the reference panel: the builtin command (`/workflow`) loads it, so it is not
    // something users manage or reference; the protocol scope is a closed enum that old clients validate strictly -- no new enum value here.
    skills: outcome.skills
      .filter((skill) => skill.source !== "bundled")
      .map(toReferenceCatalogEntry),
  };
}

function toReferenceCatalogEntry(skill: SkillMetadata): ZCodeSkillReferenceCatalogEntry {
  const scope =
    skill.source === "plugin" ? "plugin" : skill.scope === "project" ? "workspace" : "user";
  return {
    // `glm:` is the existing UI provider-filter contract; the path keeps same-name different-source rows stably identifiable.
    id: `glm:${scope}:${skill.path}`,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    scope,
    enabled: true,
    ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
  };
}
