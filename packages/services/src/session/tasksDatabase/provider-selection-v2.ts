import type { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "@zcode/shared";

// Freeze 0002's pre-release encoding; never call runtime parsers/identity tables that may change later.
// Keep escape/separator precedence identical to legacy decodeCustomModelValue / parseModelPickerValue.
const providerNames: Readonly<Record<string, string>> = {
  "builtin:bigmodel": "bigmodel-api",
  "builtin:zai": "zai-api",
  "builtin:bigmodel-start-plan": "account:bigmodel-start-plan",
  "builtin:zai-start-plan": "account:zai-start-plan",
  "builtin:bigmodel-coding-plan": "account:bigmodel-individual-coding-plan",
  "builtin:zai-coding-plan": "account:zai-individual-coding-plan",
};
function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface LegacySelectionRow {
  automation_id: string;
  model: string | null;
  provider: string | null;
  thought_level: string | null;
}

function decodeLegacySelection(row: LegacySelectionRow): ModelSelection | undefined {
  const value = row.model?.trim();
  if (!value) return undefined;
  let provider = row.provider?.trim() ?? "";
  let model = value;
  let reasoningLevel = row.thought_level?.trim();
  if (value.startsWith("custom:")) {
    const body = value.slice(7);
    const separator = body.indexOf(":");
    if (separator < 0) return undefined;
    const parts = body.split(":");
    if (parts.length >= 3 && parts[0] === "builtin") {
      provider = `builtin:${parts[1]}`;
      model = decodeComponent(parts.slice(2).join(":"));
    } else {
      provider = decodeComponent(body.slice(0, separator));
      model = decodeComponent(body.slice(separator + 1));
    }
  } else if (value.includes("/")) {
    const separator = value.indexOf("/");
    provider = value.slice(0, separator);
    model = value.slice(separator + 1);
    const levelSeparator = model.indexOf("$");
    if (levelSeparator > 0 && levelSeparator < model.length - 1) {
      reasoningLevel = model.slice(levelSeparator + 1).trim();
      if (!reasoningLevel) return undefined;
      model = model.slice(0, levelSeparator);
    }
  } else if (["glm", "zcode"].includes(provider)) {
    // Legacy provider=glm/zcode is the execution backend, not a vendor identity.
    return undefined;
  }
  provider = provider.trim();
  model = model.trim();
  if (!provider || !model) return undefined;
  const providerId = provider.startsWith("builtin:") ? providerNames[provider] : provider;
  if (!providerId) return undefined;
  return { providerId, modelId: model, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) };
}

/**
 * The one-shot 0002 conversion: the runtime Reader reads new columns; legacy three stay untouched.
 * Legacy sources may rebuild unpublished targets; indeterminate identity stays SQL NULL, defaults written as JSON null.
 * Call within the DB-level migration transaction; never restore per-read imports.
 */
export function importLegacyAutomationSelections(db: DatabaseSync): void {
  const rows = db
    .prepare(
      "SELECT automation_id, model, provider, thought_level FROM automations WHERE model IS NOT NULL",
    )
    .all() as unknown as LegacySelectionRow[];
  for (const row of rows) {
    const decoded = decodeLegacySelection(row);
    if (!decoded) {
      // Legacy explicit intent with indeterminate identity: keep no unpublished "default" middle state, avoiding silent model switches.
      if (row.model?.trim())
        db.prepare("UPDATE automations SET model_selection=NULL WHERE automation_id=?").run(
          row.automation_id,
        );
      continue;
    }
    // The outer IMMEDIATE transaction reads legacy and writes in one snapshot; legacy columns/timestamps untouched.
    db.prepare(
      `UPDATE automations SET model_selection = ?
       WHERE automation_id = ?
         AND model IS ? AND provider IS ? AND thought_level IS ?`,
    ).run(JSON.stringify(decoded), row.automation_id, row.model, row.provider, row.thought_level);
  }
  db.exec(`UPDATE automations SET model_selection='null'
    WHERE model_selection IS NULL AND (model IS NULL OR trim(model)='')`);
}
