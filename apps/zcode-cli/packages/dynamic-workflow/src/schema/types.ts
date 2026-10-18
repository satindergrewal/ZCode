/**
 * The schema subsystem's shared vocabulary: the JSON Schema subset we emit, and the
 * violation model the validator produces. This {@link JsonSchema} is not general JSON Schema -- it
 * matches exactly the keyword set {@link synthesizeAskSchemas} produces, and the validator knows only that subset.
 */

/** Any legal JSON value. Literals in const/enum/default are expressed with it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The JSON Schema base-type labels we emit. The validator supports integer; the synthesizer never emits it itself. */
export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null"
  | "array"
  | "object";

/**
 * The JSON Schema subset we emit. Fields are the union of optional keywords: a concrete schema uses only
 * those relevant to its shape (an object schema uses properties/required/additionalProperties;
 * a union uses enum or anyOf). The validator handles only the keywords here.
 */
export interface JsonSchema {
  // structure
  type?: JsonSchemaType | JsonSchemaType[];
  const?: JsonValue;
  enum?: JsonValue[];
  anyOf?: JsonSchema[];
  // object
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  // array / tuple
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  // string constraints
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  // number constraints
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  // annotations
  description?: string;
  default?: JsonValue;
  // recursion: the ref and definition table
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
}

/**
 * One validator violation, shaped to enter a repair tool_result directly: one line, with
 * the JSON path, expected, and got.
 */
export interface Violation {
  /** JSON path of the violation, like the root, a property, or an item. */
  path: string;
  /** Short description of the expected shape/value. */
  expected: string;
  /** Short description of the got value. */
  got: string;
}

/** Synthesizer diagnostic codes. 9001 is taken by the facade-siting rules (see analysis/sites.ts). */
export const SCHEMA_DIAGNOSTIC_CODE = 9002;

/**
 * Union member cap. Beyond it: a pathologically wide union, diagnosed at the ask site.
 *
 * 100: roomy for reasonable enums (status and country codes sit far below) while catching
 * runaway types. Applies to literal unions (to enum) and general unions (to anyOf) alike.
 *
 * In practice the trigger is rarely a hand-written giant union but the checker expanding template
 * literal types into a Cartesian product -- a two-dimensional cross
 * already explodes into a literal union of every combination.
 */
export const MAX_UNION_MEMBERS = 100;
