/**
 * Shape validation for preset artifact specs.
 *
 * ⚠ Terminology: artifact = the **user-facing deliverable** (a board the script publishes), not RunSettlement.artifact,
 * the top-level return value.
 *
 * Why validation in the **engine core**, not the driver: preset declarations never pass the driver (no executable effect),
 * and a malformed spec must be stopped before the journal -- journal rows are the only truth for projections and cold
 * recovery; an undrawable spec, once persisted, re-explodes on every read face.
 *
 * Hand-written, not zod: the package has zero runtime dependencies (facade / compiler / engine rely on typescript only)
 * and the spec shape fits one screen. A schema library to validate four objects would change the pure package's dependency premise.
 *
 * Returns a **human-readable sentence**, not a boolean: the message lands via ArtifactSpecInvalid in the run's
 * failure_json, and the reader (model or author) must fix the script from it -- invalid-spec helps no one.
 */

import { ARTIFACT_CAPS } from "../facade/artifact-caps.js";
import type { ArtifactPresetOp } from "../facade/registry.js";
import { canonicalJson } from "./hash.js";

/** One invalidity reason; undefined means pass. */
type ArtifactSpecProblem = string | undefined;

/**
 * Validate one preset spec. The op decides required fields; the common part (title / description lengths) is checked for all four kinds.
 * A passing spec guarantees: plain object, required fields present and well-shaped, normalized size within 8KB.
 */
export function validateArtifactSpec(op: ArtifactPresetOp, spec: unknown): ArtifactSpecProblem {
  if (!isPlainObject(spec)) return `${op} spec must be an object literal, got ${describe(spec)}`;

  const common = checkOptions(spec);
  if (common !== undefined) return common;

  const shape = checkShape(op, spec);
  if (shape !== undefined) return shape;

  // Size cap checked last: shape errors first, then size -- for a spec both malformed and oversized, the author
  // learns the malformation first.
  const bytes = utf8ByteLength(canonicalJson(spec));
  if (bytes > ARTIFACT_CAPS.maxSpecSerializedBytes) {
    return `${op} spec is ${bytes} bytes serialized, over the ${ARTIFACT_CAPS.maxSpecSerializedBytes}-byte limit`;
  }
  return undefined;
}

function checkShape(op: ArtifactPresetOp, spec: Record<string, unknown>): ArtifactSpecProblem {
  if (op === "chart") {
    const x = checkField(spec.x, "x");
    if (x !== undefined) return x;
    const y = spec.y;
    if (Array.isArray(y)) {
      if (y.length === 0) return "chart spec y is an empty array; give it at least one series";
      for (const [index, entry] of y.entries()) {
        const problem = checkField(entry, `y[${index}]`);
        if (problem !== undefined) return problem;
      }
    } else {
      const problem = checkField(y, "y");
      if (problem !== undefined) return problem;
    }
    if (spec.type !== undefined && !["line", "bar", "scatter"].includes(String(spec.type))) {
      return `chart spec type must be "line", "bar" or "scatter", got ${describe(spec.type)}`;
    }
    if (spec.scale !== undefined && !["linear", "log"].includes(String(spec.scale))) {
      return `chart spec scale must be "linear" or "log", got ${describe(spec.scale)}`;
    }
    if (spec.baseline !== undefined) return checkField(spec.baseline, "baseline");
    return undefined;
  }
  if (op === "table") {
    const columns = checkFieldList(spec.columns, "columns");
    if (columns !== undefined) return columns;
    if (spec.key !== undefined && !isNonEmptyString(spec.key)) {
      return "table spec key must be a non-empty string (the field that identifies a row)";
    }
    return undefined;
  }
  if (op === "metrics") return checkFieldList(spec.metrics, "metrics");
  // board
  if (!isNonEmptyString(spec.key))
    return "board spec key must be a non-empty string (the field that identifies a card)";
  if (!isNonEmptyString(spec.status)) {
    return "board spec status must be a non-empty string (the field that picks a card's column)";
  }
  if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
    return "board spec columns must be a non-empty array of strings (the column order)";
  }
  for (const [index, column] of spec.columns.entries()) {
    if (!isNonEmptyString(column)) return `board spec columns[${index}] must be a non-empty string`;
  }
  // cardTitle is the **field name** (which field becomes the card title), distinct from ArtifactOptions.title (the board's own
  // title) -- the two used to collide on one key; the rename lets one board say both.
  if (spec.cardTitle !== undefined && !isNonEmptyString(spec.cardTitle)) {
    return "board spec cardTitle must be a non-empty string (the field used as the card title)";
  }
  if (spec.detail !== undefined) return checkFieldList(spec.detail, "detail");
  return undefined;
}

/** Common display metadata (ArtifactOptions): types and lengths. */
function checkOptions(spec: Record<string, unknown>): ArtifactSpecProblem {
  if (spec.title !== undefined) {
    if (typeof spec.title !== "string")
      return `spec title must be a string, got ${describe(spec.title)}`;
    if (spec.title.length > ARTIFACT_CAPS.maxTitleLength) {
      return `spec title is ${spec.title.length} characters, over the ${ARTIFACT_CAPS.maxTitleLength} limit`;
    }
  }
  if (spec.description !== undefined) {
    if (typeof spec.description !== "string") {
      return `spec description must be a string, got ${describe(spec.description)}`;
    }
    if (spec.description.length > ARTIFACT_CAPS.maxDescriptionLength) {
      return (
        `spec description is ${spec.description.length} characters, over the ` +
        `${ARTIFACT_CAPS.maxDescriptionLength} limit`
      );
    }
  }
  if (spec.primary !== undefined && typeof spec.primary !== "boolean") {
    return `spec primary must be a boolean, got ${describe(spec.primary)}`;
  }
  return undefined;
}

/** A non-empty ArtifactField list. */
function checkFieldList(value: unknown, where: string): ArtifactSpecProblem {
  if (!Array.isArray(value) || value.length === 0) {
    return `spec ${where} must be a non-empty array of fields ({ field: "…" })`;
  }
  for (const [index, entry] of value.entries()) {
    const problem = checkField(entry, `${where}[${index}]`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** One ArtifactField: field must be a non-empty string (dotted path); label / unit optional. */
function checkField(value: unknown, where: string): ArtifactSpecProblem {
  if (!isPlainObject(value)) return `spec ${where} must be { field: "…" }, got ${describe(value)}`;
  if (!isNonEmptyString(value.field)) {
    return `spec ${where}.field must be a non-empty string (a dot path into the item, e.g. "timing.after")`;
  }
  for (const key of ["label", "unit"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      return `spec ${where}.${key} must be a string, got ${describe(value[key])}`;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Got-value description for error text (never the whole object -- an 8KB spec would fill failure_json). */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array (${value.length} items)`;
  if (typeof value === "object") return "object";
  if (typeof value === "string") return JSON.stringify(value.slice(0, 40));
  return String(value);
}

/** UTF-8 byte length (the same ruler as the report caps). */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
