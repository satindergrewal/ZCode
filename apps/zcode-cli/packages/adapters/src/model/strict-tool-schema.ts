// ============================================================
// Anthropic strict tool schema: eligibility check plus subset folding.
// ============================================================
// Anthropic `strict: true` uses constrained decoding to guarantee tool_use.input matches input_schema,
// but accepts only a JSON Schema subset (API docs, JSON Schema Limitations):
//   supported: object/array/string/integer/number/boolean/null, enum/const/anyOf/allOf,
//         some string formats, `additionalProperties: false` (all object properties required).
//   unsupported: numeric constraints (minimum/maximum/multipleOf), string length, complex array constraints, recursive $ref,
//         `additionalProperties` values other than false.
// This module rewrites a plain schema into an equivalent inside that subset: foldable constraints are folded into the
// description (model still reads it, engine-side validator still enforces); unrepresentable shapes return undefined (sent as-is, no strict).
// First consumer: the dwf mono subagent's typed `submit_result`.

import type { JsonSchema } from "@zcode/contracts";

/** String formats known to strict mode; the rest are folded into the description. */
const STRICT_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** Keywords folded into the description, with their wording. */
const FOLDED_KEYWORDS: Record<string, (value: unknown) => string> = {
  minimum: (v) => `minimum ${String(v)}`,
  maximum: (v) => `maximum ${String(v)}`,
  exclusiveMinimum: (v) => `greater than ${String(v)}`,
  exclusiveMaximum: (v) => `less than ${String(v)}`,
  multipleOf: (v) => `multiple of ${String(v)}`,
  minLength: (v) => `at least ${String(v)} characters`,
  maxLength: (v) => `at most ${String(v)} characters`,
  pattern: (v) => `must match /${String(v)}/`,
  minItems: (v) => `at least ${String(v)} items`,
  maxItems: (v) => `at most ${String(v)} items`,
  default: (v) => `default ${JSON.stringify(v)}`,
};

/**
 * Whether modelId is a first-party Anthropic model (bare `claude-` prefix; gateway-routed ids such as
 * `anthropic/claude-...` do not count). Only first-party models use strict: compat gateways may reject unknown
 * tool fields, so eligibility and provider capability stay separate; unknown eligibility keeps plain-schema behavior.
 */
export function isAnthropicFirstPartyModelId(modelId: string | undefined): boolean {
  return typeof modelId === "string" && modelId.startsWith("claude-");
}

/**
 * Rewrite the schema into a strict-subset equivalent; undefined when the shape is not representable.
 *
 * Not representable: `$ref`/`$defs` (recursion), `additionalProperties` as a schema (Record<string, T>),
 * empty schema `{}` (`unknown`, nothing to constrain), tuples (`prefixItems`). Foldable: FOLDED_KEYWORDS
 * plus non-strict `format`. Objects default to `additionalProperties: false` (synthesis emits it anyway).
 */
export function toStrictToolSchema(schema: JsonSchema): JsonSchema | undefined {
  const out = strictNode(schema);
  return out === INELIGIBLE ? undefined : out;
}

const INELIGIBLE = Symbol("ineligible");
type StrictNode = JsonSchema | typeof INELIGIBLE;

function strictNode(node: JsonSchema): StrictNode {
  if ("$ref" in node || "$defs" in node || "prefixItems" in node) return INELIGIBLE;

  const notes: string[] = [];
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    const fold = FOLDED_KEYWORDS[key];
    if (fold !== undefined) {
      notes.push(fold(value));
      continue;
    }
    if (key === "format" && typeof value === "string" && !STRICT_STRING_FORMATS.has(value)) {
      notes.push(`format ${value}`);
      continue;
    }
    out[key] = value;
  }

  // Recursion: properties / items / anyOf / allOf / additionalProperties.
  if (isRecord(out.properties)) {
    const properties: Record<string, JsonSchema> = {};
    for (const [name, child] of Object.entries(out.properties)) {
      if (!isRecord(child)) return INELIGIBLE;
      const strictChild = strictNode(child);
      if (strictChild === INELIGIBLE) return INELIGIBLE;
      properties[name] = strictChild;
    }
    out.properties = properties;
  }
  if (isRecord(out.items)) {
    const items = strictNode(out.items);
    if (items === INELIGIBLE) return INELIGIBLE;
    out.items = items;
  }
  for (const combinator of ["anyOf", "allOf"] as const) {
    const branches = out[combinator];
    if (!Array.isArray(branches)) continue;
    const strictBranches: JsonSchema[] = [];
    for (const branch of branches) {
      if (!isRecord(branch)) return INELIGIBLE;
      const strictBranch = strictNode(branch);
      if (strictBranch === INELIGIBLE) return INELIGIBLE;
      strictBranches.push(strictBranch);
    }
    out[combinator] = strictBranches;
  }

  const types = Array.isArray(out.type) ? out.type : out.type === undefined ? [] : [out.type];
  if (types.includes("object")) {
    // Record<string, T>: additionalProperties is a schema, not expressible in the strict subset.
    if (isRecord(out.additionalProperties)) return INELIGIBLE;
    if (out.additionalProperties !== false) out.additionalProperties = false;
    if (!isRecord(out.properties)) out.properties = {};
  }
  // Empty schema (unknown): nothing to constrain, strict rejects it.
  if (Object.keys(out).length === 0 && notes.length === 0) return INELIGIBLE;

  if (notes.length > 0) {
    const existing = typeof out.description === "string" ? out.description.trim() : "";
    const folded = notes.join("; ");
    out.description = existing.length > 0 ? `${existing} (${folded})` : folded;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
