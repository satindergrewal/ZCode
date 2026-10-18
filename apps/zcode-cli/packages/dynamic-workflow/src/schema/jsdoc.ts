import ts from "typescript";
import type { JsonSchema, JsonValue } from "./types.js";

/**
  * JSDoc harvesting: pulls doc comments off symbols (interface members, type aliases, ask result types) plus supported
  * constraint tags into JSON Schema fragments.
 *
  * - Body text -> description.
  * - A tag subset -> constraint keywords: minimum/maximum/exclusiveMinimum/exclusiveMaximum and friends.
 *   @minLength @maxLength @pattern @format @minItems @maxItems @default`。
 *
  * Tags outside the subset are silently ignored (not an error).
 */

/** Numeric-valued tags -> their numeric keyword names. */
const NUMERIC_TAGS: Record<string, keyof JsonSchema> = {
  exclusiveMaximum: "exclusiveMaximum",
  exclusiveMinimum: "exclusiveMinimum",
  maximum: "maximum",
  maxItems: "maxItems",
  maxLength: "maxLength",
  minimum: "minimum",
  minItems: "minItems",
  minLength: "minLength",
};

//** String-valued tags -> their string keyword names. */
const STRING_TAGS: Record<string, keyof JsonSchema> = {
  format: "format",
  pattern: "pattern",
};

/**
  * Harvest one symbol's description and constraint tags, returning a fragment with only the relevant keywords,
  * for the synthesizer to merge into that symbol's schema.
 */
export function harvestConstraints(symbol: ts.Symbol, checker: ts.TypeChecker): Partial<JsonSchema> {
  const out: Partial<JsonSchema> = {};

  const doc = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  if (doc.length > 0) out.description = doc;

  for (const tag of symbol.getJsDocTags(checker)) applyTag(out, tag);
  return out;
}

function applyTag(out: Partial<JsonSchema>, tag: ts.JSDocTagInfo): void {
  const raw = ts.displayPartsToString(tag.text).trim();

  const numericKey = NUMERIC_TAGS[tag.name];
  if (numericKey !== undefined) {
    const value = Number(raw);
    if (Number.isFinite(value)) (out as Record<string, unknown>)[numericKey] = value;
    return;
  }

  const stringKey = STRING_TAGS[tag.name];
  if (stringKey !== undefined) {
    if (raw.length > 0) (out as Record<string, unknown>)[stringKey] = raw;
    return;
  }

  if (tag.name === "default") {
    out.default = parseDefault(raw);
  }
    // Tags outside the subset: ignore.
}

/** The default tag's value is JSON-parsed first (number/bool/object/array/quoted string); on failure, taken as a bare string. */
function parseDefault(raw: string): JsonValue {
  if (raw.length === 0) return "";
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}

/** Merge a harvested fragment into an existing schema: constraint keywords added; description never overrides. */
export function mergeConstraints(schema: JsonSchema, extra: Partial<JsonSchema>): JsonSchema {
  const merged: JsonSchema = { ...schema };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (key === "description" && merged.description !== undefined) continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}
