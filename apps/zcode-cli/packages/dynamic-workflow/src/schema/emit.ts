import ts from "typescript";
import { harvestConstraints, mergeConstraints } from "./jsdoc.js";
import type { JsonSchema, JsonValue } from "./types.js";
import { MAX_UNION_MEMBERS } from "./types.js";

/**
  * The type-to-JSON-Schema emitter, driven by the checker's structural view (generics / aliases /
  * mapped / conditional already flattened by the checker).
 *
  * Recursive types via defs and refs: only types actually re-referenced by themselves (on the synthesis stack) become
  * named defs; non-recursive named types stay inlined, keeping snapshots readable. Detection: push a stack frame per composite type;
  * if the same ts.Type is entered again while emitting its subtree, mark it requested and return a
  * ref; at frame end, a requested type registers into defs.
 *
  * Non-JSON-serializable types throw {@link SchemaRejection}, which the synthesizer turns into a diagnostic
  * pinned to the ask site (the analysis pipeline's diagnostic shape and UX).
 */

/** Emission failure: the reason plus the offending JSON path, for the synthesizer to assemble a located diagnostic. */
export class SchemaRejection extends Error {
  constructor(
    readonly reason: string,
    readonly path: string,
  ) {
    super(reason);
    this.name = "SchemaRejection";
  }
}

/**
  * Built-in objects rejected by name: host objects and class instances, not pure data. Promise included,
  * with a clearer diagnostic than the plain function-type one. User classes fall through to the class flag.
 */
const REJECTED_BUILTINS = new Set<string>([
  "Date",
  "RegExp",
  "Map",
  "WeakMap",
  "ReadonlyMap",
  "Set",
  "WeakSet",
  "ReadonlySet",
  "Promise",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

interface Frame {
  requested: boolean;
}

/** Reads an object type's flags (not exposed in the public typings; taken directly). */
function objectFlagsOf(type: ts.Type): ts.ObjectFlags {
  return (type.flags & ts.TypeFlags.Object) !== 0 ? (type as ts.ObjectType).objectFlags : 0;
}

export class SchemaEmitter {
  private readonly defs = new Map<ts.Type, { name: string; schema: JsonSchema }>();
  private readonly inProgress = new Map<ts.Type, Frame>();
  private readonly defName = new Map<ts.Type, string>();
  private readonly usedNames = new Set<string>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly location: ts.Node,
  ) {}

    /** Emit the root type; any produced defs hang off the root schema. */
  emitTop(type: ts.Type): JsonSchema {
    const schema = this.emit(type, "$");
    if (this.defs.size === 0) return schema;
    const $defs: Record<string, JsonSchema> = {};
    for (const { name, schema: defSchema } of this.defs.values()) $defs[name] = defSchema;
    return { ...schema, $defs };
  }

  private emit(type: ts.Type, path: string): JsonSchema {
    const settled = this.defs.get(type);
    if (settled !== undefined) return { $ref: `#/$defs/${settled.name}` };
    const frame = this.inProgress.get(type);
    if (frame !== undefined) {
      frame.requested = true;
      return { $ref: `#/$defs/${this.nameFor(type)}` };
    }

    const flags = type.flags;
    if (flags & ts.TypeFlags.Any) {
      throw new SchemaRejection("type 'any' is not allowed; use 'unknown' or a concrete type", path);
    }
    if (flags & ts.TypeFlags.Unknown) return {};
    if (flags & ts.TypeFlags.Never) throw new SchemaRejection("type 'never' cannot be represented", path);
    if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
      throw new SchemaRejection("'undefined' is only allowed on optional properties", path);
    }
    if (flags & ts.TypeFlags.Null) return { type: "null" };
    if (flags & ts.TypeFlags.BooleanLiteral) return { const: this.booleanValue(type) };
    if (flags & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (flags & ts.TypeFlags.StringLiteral) return { const: (type as ts.StringLiteralType).value };
    if (flags & ts.TypeFlags.NumberLiteral) return { const: (type as ts.NumberLiteralType).value };
    if (flags & ts.TypeFlags.String) return { type: "string" };
    if (flags & ts.TypeFlags.Number) return { type: "number" };
    if (flags & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) {
      throw new SchemaRejection("'bigint' is not JSON-serializable", path);
    }
    if (flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) {
      throw new SchemaRejection("'symbol' is not JSON-serializable", path);
    }
    if (type.isUnion()) return this.composite(type, () => this.emitUnion(type, path));
    if (type.isIntersection()) return this.composite(type, () => this.emitIntersection(type, path));
    if (flags & ts.TypeFlags.Object) return this.composite(type, () => this.emitObjectLike(type, path));

    throw new SchemaRejection("type is not JSON-serializable", path);
  }

    /** A composite type's stack-frame wrapper: re-referenced by itself during emission -> promoted to a def, returns a ref. */
  private composite(type: ts.Type, build: () => JsonSchema): JsonSchema {
    this.inProgress.set(type, { requested: false });
    const schema = build();
    const frame = this.inProgress.get(type)!;
    this.inProgress.delete(type);
    if (!frame.requested) return schema;
    const name = this.nameFor(type);
    this.defs.set(type, { name, schema });
    return { $ref: `#/$defs/${name}` };
  }

    /** Assign a stable, unique def name (from the alias/symbol name), lazy and deduped. */
  private nameFor(type: ts.Type): string {
    const cached = this.defName.get(type);
    if (cached !== undefined) return cached;
    const base = type.aliasSymbol?.name ?? type.getSymbol()?.name ?? "Schema";
    let name = base;
    let suffix = 1;
    while (this.usedNames.has(name)) {
      suffix += 1;
      name = `${base}${suffix}`;
    }
    this.usedNames.add(name);
    this.defName.set(type, name);
    return name;
  }

  private booleanValue(type: ts.Type): boolean {
    return (type as unknown as { intrinsicName?: string }).intrinsicName === "true";
  }

  private emitUnion(type: ts.UnionType, path: string): JsonSchema {
    const members = type.types;
    if (members.length > MAX_UNION_MEMBERS) {
      throw new SchemaRejection(
        `union has too many members (${members.length} > ${MAX_UNION_MEMBERS})`,
        path,
      );
    }
    for (const member of members) {
      if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
        throw new SchemaRejection("'undefined' is only allowed on optional properties", path);
      }
    }
    return this.emitMembers(members, path);
  }

    /** Member types -> enum (when all-literal) or anyOf. Also reused by the optional-property de-undefined path. */
  emitMembers(members: readonly ts.Type[], path: string): JsonSchema {
    const literals = this.asLiterals(members);
    if (literals !== undefined) return { enum: literals };
    return { anyOf: members.map((member, index) => this.emit(member, `${path}|${index}`)) };
  }

    /** If every member is a literal (string/number/boolean literal or null), return the value array. */
  private asLiterals(members: readonly ts.Type[]): JsonValue[] | undefined {
    const values: JsonValue[] = [];
    for (const member of members) {
      const flags = member.flags;
      if (flags & ts.TypeFlags.StringLiteral) values.push((member as ts.StringLiteralType).value);
      else if (flags & ts.TypeFlags.NumberLiteral) values.push((member as ts.NumberLiteralType).value);
      else if (flags & ts.TypeFlags.BooleanLiteral) values.push(this.booleanValue(member));
      else if (flags & ts.TypeFlags.Null) values.push(null);
      else return undefined;
    }
    return values;
  }

    /** Intersection: merged into one object (the checker merged members' properties onto it). Branded
      * primitives (a string with a brand) emit as their primitive. */
  private emitIntersection(type: ts.IntersectionType, path: string): JsonSchema {
    for (const member of type.types) {
      if (member.flags & ts.TypeFlags.String) return { type: "string" };
      if (member.flags & ts.TypeFlags.Number) return { type: "number" };
      if (member.flags & ts.TypeFlags.Boolean) return { type: "boolean" };
    }
    if (type.getCallSignatures().length > 0) {
      throw new SchemaRejection("function types are not JSON-serializable", path);
    }
    return this.emitObject(type, path);
  }

  private emitObjectLike(type: ts.Type, path: string): JsonSchema {
    if (this.isArrayType(type)) return this.emitArray(type as ts.TypeReference, path);
    if (this.isTupleType(type)) return this.emitTuple(type as ts.TupleTypeReference, path);
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      throw new SchemaRejection("function types are not JSON-serializable", path);
    }
    const name = type.getSymbol()?.getName();
    if (name !== undefined && REJECTED_BUILTINS.has(name)) {
      throw new SchemaRejection(`'${name}' is not JSON-serializable`, path);
    }
    if (((type.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) !== 0) {
      throw new SchemaRejection("class instances are not JSON-serializable", path);
    }
    if (this.isThenable(type)) {
      throw new SchemaRejection("Promise/thenable values are not JSON-serializable", path);
    }
    return this.emitObject(type, path);
  }

  private emitObject(type: ts.Type, path: string): JsonSchema {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const prop of this.checker.getPropertiesOfType(type)) {
      const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
      const propPath = `${path}.${prop.name}`;
      const propType = this.checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration ?? this.location);
      const base = optional ? this.emitOptional(propType, propPath) : this.emit(propType, propPath);
      properties[prop.name] = mergeConstraints(base, harvestConstraints(prop, this.checker));
      if (!optional) required.push(prop.name);
    }

    const schema: JsonSchema = { type: "object" };
    if (Object.keys(properties).length > 0) schema.properties = properties;
    if (required.length > 0) schema.required = required;

        // Closed objects (no string index signature) emit additionalProperties false.
        // Not TS-faithful: TS object types are structurally open (excess-property checks fire only on object
        // literals), so a one-prop object accepts extra keys. The real reason for false is validation UX and the structured-
        // output convention: extra keys almost always signal misunderstanding, and false turns that into one clear repair hint,
        // matching strict structured-output practice. With a string index signature, use the value schema.
    const indexInfo = this.checker.getIndexInfoOfType(type, ts.IndexKind.String);
    schema.additionalProperties = indexInfo !== undefined ? this.emit(indexInfo.type, `${path}[*]`) : false;
    return schema;
  }

    /** Optional property: strip undefined from the type, then emit (optionality lives in required, not the type). */
  private emitOptional(propType: ts.Type, path: string): JsonSchema {
    if (!propType.isUnion()) return this.emit(propType, path);
    const rest = propType.types.filter(
      (member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0,
    );
    if (rest.length === propType.types.length) return this.emit(propType, path);
    if (rest.length === 1) return this.emit(rest[0]!, path);
    return this.emitMembers(rest, path);
  }

  private emitArray(type: ts.TypeReference, path: string): JsonSchema {
    const element = this.checker.getTypeArguments(type)[0];
    const items = element !== undefined ? this.emit(element, `${path}[]`) : {};
    return { type: "array", items };
  }

  private emitTuple(type: ts.TupleTypeReference, path: string): JsonSchema {
    const elementFlags = type.target.elementFlags;
    const args = this.checker.getTypeArguments(type);
    const prefixItems: JsonSchema[] = [];
    let minItems = 0;
    let restItems: JsonSchema | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const flag = elementFlags[index] ?? ts.ElementFlags.Required;
      const arg = args[index]!;
      if (flag & ts.ElementFlags.Rest) {
        restItems = this.emit(arg, `${path}[${index}]`);
        continue;
      }
      const optional = (flag & ts.ElementFlags.Optional) !== 0;
      prefixItems.push(optional ? this.emitOptional(arg, `${path}[${index}]`) : this.emit(arg, `${path}[${index}]`));
      if (flag & ts.ElementFlags.Required) minItems += 1;
    }
    const schema: JsonSchema = { type: "array", prefixItems, minItems };
    if (restItems !== undefined) schema.items = restItems;
    else schema.maxItems = prefixItems.length;
    return schema;
  }

  private isArrayType(type: ts.Type): boolean {
    if ((objectFlagsOf(type) & ts.ObjectFlags.Reference) === 0) return false;
    const name = (type as ts.TypeReference).target.getSymbol()?.getName();
    return name === "Array" || name === "ReadonlyArray";
  }

  private isTupleType(type: ts.Type): boolean {
    if ((objectFlagsOf(type) & ts.ObjectFlags.Reference) === 0) return false;
    return (((type as ts.TypeReference).target.objectFlags ?? 0) & ts.ObjectFlags.Tuple) !== 0;
  }

  private isThenable(type: ts.Type): boolean {
    const then = this.checker.getPropertyOfType(type, "then");
    if (then === undefined) return false;
    const thenType = this.checker.getTypeOfSymbolAtLocation(then, then.valueDeclaration ?? this.location);
    return thenType.getCallSignatures().length > 0;
  }
}
