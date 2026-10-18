import type { JsonSchema } from "./types.js";

/**
  * Deterministic serialization: recursively sort the schema's object keys before JSON.stringify, keeping snapshots stable and
  * independent of emission insertion order. Arrays (enum/required/prefixItems/anyOf and the like) keep their order --
  * it is meaningful (and fixed by the checker's property/member order).
 */

export function serializeSchema(schema: JsonSchema): string {
  return `${JSON.stringify(canonicalize(schema), null, 2)}\n`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
