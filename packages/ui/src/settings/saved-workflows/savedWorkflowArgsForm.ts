// Saved-workflow args form and metadata declaration table.
// Pure functions: flatten frontmatter args declarations into editable fields, then collect them back into an arg bag / declaration;
// validation mirrors the CLI's validateWorkflowArgs (required, per-type parse; default backfill happens server-side).
import type { ZCodeSavedWorkflowArgType, ZCodeSavedWorkflowArgsDeclaration } from "@zcode/shared";

export interface SavedWorkflowArgField {
  name: string;
  type: ZCodeSavedWorkflowArgType;
  description?: string;
  required: boolean;
  hasDefault: boolean;
  /** Text as shown in the editor; booleans use true / false. */
  value: string;
}

export type SavedWorkflowArgFieldError = "required" | "invalid_number" | "invalid_json";

/** Encode a default/existing value into editor text by type. */
export function formatSavedWorkflowArgValue(
  type: ZCodeSavedWorkflowArgType,
  value: unknown,
): string {
  if (value === undefined) return type === "boolean" ? "false" : "";
  switch (type) {
    case "string":
      return typeof value === "string" ? value : JSON.stringify(value);
    case "number":
      return typeof value === "number" ? String(value) : String(value);
    case "boolean":
      return value === true ? "true" : "false";
    case "json":
      return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  }
}

/**
 * Declaration to editable fields. When initialArgs is present, each field prefers its value (Run again prefills the args
 * used by that run, docs/dynamic-workflow/transcript-and-notifications.md "Run again"):
 * what ran last is likely what runs next. Keys absent from the declaration never enter the form -- the declaration
 * shapes it; an old arg set must not sprout fields.
 */
export function buildSavedWorkflowArgFields(
  declaration: ZCodeSavedWorkflowArgsDeclaration | undefined,
  initialArgs?: Record<string, unknown>,
): SavedWorkflowArgField[] {
  if (!declaration) return [];
  return Object.entries(declaration).map(([name, spec]) => {
    const initial = initialArgs?.[name];
    return {
      name,
      type: spec.type,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      required: spec.required === true,
      hasDefault: spec.default !== undefined,
      value: formatSavedWorkflowArgValue(spec.type, initial === undefined ? spec.default : initial),
    };
  });
}

type SavedWorkflowArgParse =
  | { ok: true; omitted: true }
  | { ok: true; omitted: false; value: unknown }
  | { ok: false; error: SavedWorkflowArgFieldError };

/**
 * One field to an arg value. Empty text means not-passed for string/number/json: with a default it is backfilled server-side,
 * without one a non-required key is absent; required-but-empty is the only required error. Booleans always have a value.
 */
export function parseSavedWorkflowArgField(field: SavedWorkflowArgField): SavedWorkflowArgParse {
  const raw = field.value;
  if (field.type === "boolean") {
    return { ok: true, omitted: false, value: raw === "true" };
  }
  if (raw.trim().length === 0) {
    if (field.required && !field.hasDefault) return { ok: false, error: "required" };
    return { ok: true, omitted: true };
  }
  switch (field.type) {
    case "string":
      return { ok: true, omitted: false, value: raw };
    case "number": {
      const parsed = Number(raw.trim());
      // NaN / Infinity fail JSON and the CLI's number check; intercept here.
      if (!Number.isFinite(parsed)) return { ok: false, error: "invalid_number" };
      return { ok: true, omitted: false, value: parsed };
    }
    case "json": {
      try {
        return { ok: true, omitted: false, value: JSON.parse(raw) as unknown };
      } catch {
        return { ok: false, error: "invalid_json" };
      }
    }
  }
}

type SavedWorkflowArgsCollect =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errors: Record<string, SavedWorkflowArgFieldError> };

/** Whole form to arg bag; collects every error at once (validateWorkflowArgs-style, no fail-fast). */
export function collectSavedWorkflowArgs(
  fields: readonly SavedWorkflowArgField[],
): SavedWorkflowArgsCollect {
  const args: Record<string, unknown> = {};
  const errors: Record<string, SavedWorkflowArgFieldError> = {};
  for (const field of fields) {
    const parsed = parseSavedWorkflowArgField(field);
    if (!parsed.ok) {
      errors[field.name] = parsed.error;
      continue;
    }
    if (!parsed.omitted) args[field.name] = parsed.value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, args };
}

// ── Metadata editor: the args declaration table ──

export interface SavedWorkflowArgRow {
  /** The row's stable identity (present for new rows too; the name may be empty). */
  key: string;
  name: string;
  type: ZCodeSavedWorkflowArgType;
  required: boolean;
  /** Default value editor text; empty = no default (booleans use empty, true, or false). */
  defaultText: string;
  description: string;
}

export type SavedWorkflowArgRowError = "empty_name" | "duplicate_name" | "invalid_default";

export function argsDeclarationToRows(
  declaration: ZCodeSavedWorkflowArgsDeclaration | undefined,
): SavedWorkflowArgRow[] {
  if (!declaration) return [];
  return Object.entries(declaration).map(([name, spec], index) => ({
    key: `${index}:${name}`,
    name,
    type: spec.type,
    required: spec.required === true,
    defaultText:
      spec.default === undefined
        ? ""
        : spec.type === "boolean"
          ? spec.default === true
            ? "true"
            : "false"
          : formatSavedWorkflowArgValue(spec.type, spec.default),
    description: spec.description ?? "",
  }));
}

function parseDefaultText(
  type: ZCodeSavedWorkflowArgType,
  text: string,
): { ok: true; value?: unknown } | { ok: false } {
  if (text.trim().length === 0) return { ok: true };
  switch (type) {
    case "string":
      return { ok: true, value: text };
    case "number": {
      const parsed = Number(text.trim());
      return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false };
    }
    case "boolean":
      if (text === "true") return { ok: true, value: true };
      if (text === "false") return { ok: true, value: false };
      return { ok: false };
    case "json":
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false };
      }
  }
}

type SavedWorkflowArgRowsCollect =
  | { ok: true; args: ZCodeSavedWorkflowArgsDeclaration | undefined }
  | { ok: false; errors: Record<string, SavedWorkflowArgRowError> };

/**
 * Declaration table to declarations. Names need only be non-empty and unique (declarations are records; args.x parsing is not identifier-bound);
 * an empty table returns undefined (no args key in frontmatter, rather than an empty object).
 */
export function rowsToArgsDeclaration(
  rows: readonly SavedWorkflowArgRow[],
): SavedWorkflowArgRowsCollect {
  const errors: Record<string, SavedWorkflowArgRowError> = {};
  const seen = new Set<string>();
  const args: ZCodeSavedWorkflowArgsDeclaration = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name.length === 0) {
      errors[row.key] = "empty_name";
      continue;
    }
    if (seen.has(name)) {
      errors[row.key] = "duplicate_name";
      continue;
    }
    seen.add(name);
    const parsedDefault = parseDefaultText(row.type, row.defaultText);
    if (!parsedDefault.ok) {
      errors[row.key] = "invalid_default";
      continue;
    }
    const description = row.description.trim();
    args[name] = {
      type: row.type,
      ...(description.length === 0 ? {} : { description }),
      ...(row.required ? { required: true } : {}),
      ...(parsedDefault.value === undefined ? {} : { default: parsedDefault.value }),
    };
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, args: Object.keys(args).length === 0 ? undefined : args };
}
