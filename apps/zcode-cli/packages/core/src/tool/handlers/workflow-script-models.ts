// ============================================================
// Script-named models: resolve to a binding table, report unresolvable as 9011 (shared by CreateWorkflow / AmendWorkflow / direct launch / GUI settings)
// ============================================================
// See docs/dynamic-workflow/launch.md "Models the script names" and
// docs/dynamic-workflow/authoring.md「Choosing a model per subagent」。
//
// The compiler guarantees the set of models a script may hand to subagents is closed (9010), delivered as `modelReferences`.
// This is the half the compiler cannot do — resolve every name against **this machine's** model catalog:
//
//   - `resolveInput` writes the resolved ones into the input's `model_bindings` (verbatim name -> canonical string);
//   - `prepareApproval` skips the dialog when a name lacks a binding;
//   - the handler reports unbound names as 9011 diagnostics on the compile-failure path (file/line, edit the file, resubmit via `path`).
//
// An unresolvable name is **not** a business failure of the call (unlike an unresolvable `subagent_model`): it lives in the script file, so it must
// look exactly like a compile error, not a "change your params" hint.

import {
  MODEL_UNRESOLVED_CODE,
  type AnalyzeResult,
  type ModelReference,
} from "@zcode/dynamic-workflow";
import type { CreateWorkflowDiagnostic, ModelCatalogPort, ModelSelection } from "@zcode/contracts";
import { parseModelPickerValue } from "@zcode/shared/model-selection";
import type { ToolInputResolutionResult } from "../types.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import { resolveModelReference } from "./model-reference.js";

/** Name -> canonical `providerId/modelId[$level]` string. */
export type ScriptModelBindings = Record<string, string>;

/** With no host model catalog, the per-name 9011 copy (the script-side fix, not a param-side one). */
export const SCRIPT_MODELS_UNAVAILABLE =
  "This host cannot choose models; remove `model` from the personas (the subagents then run on the run's subagent model).";

/**
 * Result of resolving one name. `inherited` present means the binding came from the predecessor (`AmendWorkflow` / GUI settings):
 * that branch resolves the recorded canonical string, and the failure copy must say "the inherited model is gone", or the model edits
 * a name it never wrote wrong.
 */
type NameResolution = { ok: true; canonical: string } | { ok: false; message: string };

function resolveName(
  name: string,
  catalog: ModelCatalogPort | undefined,
  inherited: ScriptModelBindings | undefined,
): NameResolution {
  if (catalog === undefined) return { ok: false, message: SCRIPT_MODELS_UNAVAILABLE };
  const entries = catalog.listModels();
  const previous = inherited?.[name];
  if (previous !== undefined) {
    // Inheriting the predecessor's binding resolves the recorded canonical string (first tier), not the name — if the user swapped that
    // name's model in the predecessor's dialog, re-resolving the name would silently undo that choice.
    const resolution = resolveModelReference(previous, entries);
    if (resolution.ok) return { ok: true, canonical: resolution.canonical };
    return {
      ok: false,
      message: `"${name}" keeps the model the amended run bound it to, ${previous}, which cannot be used now. ${resolution.message}`,
    };
  }
  const resolution = resolveModelReference(name, entries);
  if (resolution.ok) return { ok: true, canonical: resolution.canonical };
  return {
    ok: false,
    message: `The model "${name}" named in the script cannot be used: ${resolution.message}`,
  };
}

/** Deduped names in first-occurrence order (the dialog draws rows and the result copy lists names in this order). */
export function distinctModelNames(references: readonly ModelReference[]): string[] {
  return [...new Set(references.map((reference) => reference.name))];
}

/**
 * Resolve every script-named name into the binding table. Only resolvable ones enter; unresolvable do not — both `prepareApproval`
 * and the handler key on "a name lacks a binding", so failure needs no second carrier.
 */
export function resolveScriptModelBindings(
  names: readonly string[],
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): ScriptModelBindings {
  const bindings: ScriptModelBindings = {};
  for (const name of names) {
    const resolution = resolveName(name, catalog, inherited);
    if (resolution.ok) bindings[name] = resolution.canonical;
  }
  return bindings;
}

/**
 * Last step of `resolveInput`: compile the normalized script (the single-slot memo makes the next two compiles free) and write `model_bindings`
 * into the input. **Unconditionally override** the model's value (the same posture as `adjustable_settings`: forged is invalid); a script that
 * fails to compile or names no models leaves the whole key absent.
 */
export function withScriptModelBindings(
  input: Record<string, unknown>,
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): Record<string, unknown> {
  const { model_bindings: _forged, ...rest } = input;
  void _forged;
  const script = rest.script;
  if (typeof script !== "string") return rest;
  const analysis = analyzeScript(script);
  if (!analysis.ok) return rest;
  const names = distinctModelNames(analysis.modelReferences);
  if (names.length === 0) return rest;
  const bindings = resolveScriptModelBindings(names, catalog, inherited);
  return Object.keys(bindings).length === 0 ? rest : { ...rest, model_bindings: bindings };
}

/** Wrapped over one normalization result by {@link withScriptModelBindings}: failure passes through, success gains the binding table. */
export function withScriptModelBindingsResolved(
  resolution: ToolInputResolutionResult,
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): ToolInputResolutionResult {
  if (!resolution.result) return resolution;
  const input = resolution.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return resolution;
  return {
    result: true,
    input: withScriptModelBindings(input as Record<string, unknown>, catalog, inherited),
  };
}

/** The input's binding table (written by `resolveInput`; a hook-mangled shape counts as absent). */
export function readScriptModelBindings(input: unknown): ScriptModelBindings {
  if (typeof input !== "object" || input === null) return {};
  const raw = (input as { model_bindings?: unknown }).model_bindings;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const bindings: ScriptModelBindings = {};
  for (const [name, canonical] of Object.entries(raw)) {
    if (typeof canonical === "string") bindings[name] = canonical;
  }
  return bindings;
}

/** Are all script-named names bound? (`prepareApproval` decides the dialog from this.) */
export function allScriptModelsBound(
  analysis: AnalyzeResult,
  bindings: ScriptModelBindings,
): boolean {
  return analysis.modelReferences.every((reference) => bindings[reference.name] !== undefined);
}

/**
 * Unbound name -> 9011 diagnostic, **one per name**, at its first occurrence. Reporting every site would repeat a forty-line
 * candidate list N times; a name fixed by one edit needs one report. The copy comes from re-resolution (the handler holds the catalog),
 * so `resolveInput` need not stuff failure copy into the input.
 */
export function unresolvedScriptModelDiagnostics(
  analysis: AnalyzeResult,
  bindings: ScriptModelBindings,
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): CreateWorkflowDiagnostic[] {
  const diagnostics: CreateWorkflowDiagnostic[] = [];
  const reported = new Set<string>();
  for (const reference of analysis.modelReferences) {
    if (bindings[reference.name] !== undefined || reported.has(reference.name)) continue;
    reported.add(reference.name);
    const resolution = resolveName(reference.name, catalog, inherited);
    diagnostics.push({
      code: MODEL_UNRESOLVED_CODE,
      line: reference.line,
      column: reference.column,
      // Resolving here despite the earlier miss means the catalog changed after resolveInput (provider re-added). Still report:
      // the approved dialog (or absent one) did not include this model; silently using it is an unseen choice.
      message: resolution.ok
        ? `The model "${reference.name}" became available only after this call was checked; submit the script again.`
        : resolution.message,
    });
  }
  return diagnostics;
}

/** Binding table -> the structured selection the port wants. An unresolvable canonical string is a wiring fault (`resolveInput` only writes resolvable ones). */
export function scriptModelSelections(
  bindings: ScriptModelBindings,
): Record<string, ModelSelection> | undefined {
  const names = Object.keys(bindings);
  if (names.length === 0) return undefined;
  const selections: Record<string, ModelSelection> = {};
  for (const name of names) {
    try {
      selections[name] = parseModelPickerValue(bindings[name]!);
    } catch (cause) {
      throw new Error(`workflow model_bindings reached the handler un-canonicalised: ${name}`, {
        cause,
      });
    }
  }
  return selections;
}

/**
 * The sentence in the result copy (docs/dynamic-workflow/launch.md "Models the script names"): canonical strings,
 * pasteable into the next call. Present only when the table is non-empty; leading space, appended after the settings sentence.
 */
export function describeScriptModelBindings(bindings: ScriptModelBindings): string {
  const entries = Object.entries(bindings);
  if (entries.length === 0) return "";
  const pairs = entries.map(([name, canonical]) => `"${name}" = ${canonical}`);
  return ` Models named in the script: ${pairs.join("; ")}.`;
}

/**
 * The two no-dialog launch paths (hub direct launch, GUI settings) finish in one step: resolve every name, hand over the port's selections and
 * 9011 for unbound names. Caller rejects when `unbound` is non-empty; `selections` unused then.
 */
export function bindScriptModels(
  analysis: AnalyzeResult,
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): {
  selections: Record<string, ModelSelection> | undefined;
  unbound: CreateWorkflowDiagnostic[];
} {
  const bindings = resolveScriptModelBindings(
    distinctModelNames(analysis.modelReferences),
    catalog,
    inherited,
  );
  const unbound = unresolvedScriptModelDiagnostics(analysis, bindings, catalog, inherited);
  return { selections: unbound.length > 0 ? undefined : scriptModelSelections(bindings), unbound };
}
