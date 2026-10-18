// ============================================================
// The two run settings adjustable in the confirm dialog (shared by CreateWorkflow / AmendWorkflow)
// ============================================================
// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」。
//
// Three things, one implementation:
//   1. the `adjustable_settings` block backfilled by `resolveInput` (tells the dialog this agent will apply in-dialog values);
//   2. after approval, apply answer changes to the input (the executor calls via `ToolEntry.applyInputAdjustments`);
//   3. the result-copy sentence "before approval, the user adjusted settings in the dialog".
//
// The post-application shape equals resolveInput's product — "one canonical form or none", "a number or none" — so
// handler, run port, and journal need not know an adjustment happened; only the model-facing sentence does.

import {
  parseWorkflowSettingsAdjustment,
  type WorkflowAdjustableSettings,
  type WorkflowSettingsAdjustment,
} from "@zcode/contracts";
import type {
  ToolHandlerFailure,
  ToolInputAdjustmentResult,
  ToolInputResolutionContext,
  ToolInputResolutionResult,
} from "../types.js";
import { normalizeWorkflowMaxConcurrency } from "./create-workflow-source.js";
import { resolveModelReference } from "./model-reference.js";

/** A runtime schema where safeParse suffices (both tools' strict input schemas). */
interface WorkflowInputSchemaLike {
  safeParse(value: unknown): { success: boolean };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The backfill block only when the port exists — no run port, no run, nowhere for a dialog value to land. The model cell reads the catalog port:
 * a host that cannot resolve model names offers only the bound (failing after approval with "cannot choose models here" books a wiring gap to the user).
 */
export function workflowAdjustableSettings(
  context: ToolInputResolutionContext,
): WorkflowAdjustableSettings | undefined {
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined) return undefined;
  // The wire key `concurrency_ceiling` predates the "default concurrency" concept and stays for old hosts; it now carries the default
  // D — the stepper hint and the "equals default = no bound of its own" test, not a cap.
  const defaultConcurrency = port.defaultConcurrency?.();
  return {
    subagent_model: context.modelCatalogPort !== undefined,
    ...(defaultConcurrency === undefined ? {} : { concurrency_ceiling: defaultConcurrency }),
  };
}

/**
 * Adds the backfill block to a successful normalization (unconditionally overriding the model's value: forged is invalid). `includeWhen` lets the caller
 * exclude shapes with no dialog — AmendWorkflow's in-place concurrency normalization has no script, hence no dialog.
 */
export function withWorkflowAdjustableSettings(
  resolution: ToolInputResolutionResult,
  context: ToolInputResolutionContext,
  includeWhen: (input: Record<string, unknown>) => boolean = () => true,
): ToolInputResolutionResult {
  if (!resolution.result || !isPlainRecord(resolution.input)) return resolution;
  const { adjustable_settings: _forged, ...rest } = resolution.input;
  void _forged;
  const block = includeWhen(rest) ? workflowAdjustableSettings(context) : undefined;
  return {
    result: true,
    input: block === undefined ? rest : { ...rest, adjustable_settings: block },
  };
}

/** The model chosen in the dialog cannot resolve right now (deleted, disabled, or no catalog): the whole call fails, nothing starts. */
function adjustedModelFailure(errorCode: number, detail: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode,
    message: `workflow_subagent_model_unresolved: the subagent model the user chose in the confirmation window cannot be used now. ${detail} Nothing was started; ask the user which model to use.`,
  };
}

/** Model chosen in the dialog but no catalog: the backfill block already said `subagent_model: false` on such hosts; this only guards bypassing clients. */
const ADJUSTED_MODEL_WITHOUT_CATALOG = "This host cannot choose a subagent model.";

/**
 * Applies answer changes onto an already-normalized input. Three states, same rules as AmendWorkflow's model face: string -> resolve via the catalog to
 * canonical form (the dialog sends canonical, hits the first tier); `null` -> delete the key (session model / default concurrency); number -> floor
 * to at least 1, no ceiling. A change equal to the input's current value does not count as applied (absent from `applied`), keeping the result copy free of empty words.
 */
export function applyWorkflowSettingsAdjustments(
  input: unknown,
  adjustments: Readonly<Record<string, unknown>>,
  context: ToolInputResolutionContext,
  options: { errorCode: number; schema: WorkflowInputSchemaLike },
): ToolInputAdjustmentResult {
  const adjustment = parseWorkflowSettingsAdjustment(adjustments);
  if (adjustment === undefined || !isPlainRecord(input)) return { result: true, input };
  const next: Record<string, unknown> = { ...input };
  const applied: WorkflowSettingsAdjustment = {};

  if (adjustment.subagent_model === null) {
    if (next.subagent_model !== undefined) applied.subagent_model = null;
    delete next.subagent_model;
  } else if (adjustment.subagent_model !== undefined) {
    const catalog = context.modelCatalogPort;
    if (catalog === undefined) {
      return adjustedModelFailure(options.errorCode, ADJUSTED_MODEL_WITHOUT_CATALOG);
    }
    const resolution = resolveModelReference(adjustment.subagent_model, catalog.listModels());
    if (!resolution.ok) return adjustedModelFailure(options.errorCode, resolution.message);
    if (next.subagent_model !== resolution.canonical) applied.subagent_model = resolution.canonical;
    next.subagent_model = resolution.canonical;
  }

  if (adjustment.max_concurrency === null) {
    if (next.max_concurrency !== undefined) applied.max_concurrency = null;
    delete next.max_concurrency;
  } else if (adjustment.max_concurrency !== undefined) {
    const bound = normalizeWorkflowMaxConcurrency(adjustment.max_concurrency);
    if (next.max_concurrency !== bound) applied.max_concurrency = bound;
    next.max_concurrency = bound;
  }

  // The settled input must still pass the tool's runtime schema: the handler accepts that one shape and gets no second path for adjustments.
  if (!options.schema.safeParse(next).success) {
    return {
      result: false,
      errorCode: options.errorCode,
      message:
        "workflow_settings_adjustment_invalid: the settings adjusted in the confirmation window did not produce a valid call. Nothing was started.",
    };
  }
  return Object.keys(applied).length === 0
    ? { result: true, input: next }
    : { result: true, input: next, applied };
}

/** The handler reads `context.inputAdjustments`: the executor passes exactly the `applied` above; this only re-checks the shape. */
export function readAppliedWorkflowSettings(
  inputAdjustments: Readonly<Record<string, unknown>> | undefined,
): WorkflowSettingsAdjustment {
  return parseWorkflowSettingsAdjustment(inputAdjustments) ?? {};
}

/**
 * The sentence in the result copy (docs/dynamic-workflow/launch.md "Adjusting the settings in the window"). The model's
 * tool_use block keeps its own params; unsaid, it believes its values apply and may even "correct" a run that is following the
 * user's intent. Only the changed half is named; each `null` gets its own sentence. Leading space, appended to the previous sentence.
 */
export function describeWorkflowSettingsAdjustment(
  applied: WorkflowSettingsAdjustment,
  defaultConcurrency: number | undefined,
): string {
  const halves: string[] = [];
  if (applied.subagent_model === null) {
    halves.push("subagents are back on the session model");
  } else if (applied.subagent_model !== undefined) {
    halves.push(
      `subagents run on ${applied.subagent_model} (the main agent stays on the session model)`,
    );
  }
  if (applied.max_concurrency === null) {
    halves.push("the limit on subagents at once is back to the default");
  } else if (applied.max_concurrency !== undefined) {
    const subject =
      applied.max_concurrency === 1
        ? "1 subagent runs"
        : `${applied.max_concurrency} subagents run`;
    halves.push(
      `at most ${subject} at once${defaultConcurrency === undefined ? "" : ` (the default is ${defaultConcurrency})`}`,
    );
  }
  if (halves.length === 0) return "";
  return ` Before approving, the user adjusted the settings in the confirmation window: ${halves.join("; ")}.`;
}

/**
 * The three settings sentences of the result copy: the adjustment sentence first; an unadjusted item keeps its own sentence (the adjustment
 * sentence already covered it). Shared by both tools so the same fact is the same sentence in both results.
 */
export function describeWorkflowRunSettings(options: {
  applied: WorkflowSettingsAdjustment;
  defaultConcurrency: number | undefined;
  describeLimit: () => string;
  describeModel: () => string;
  /**
   * The script-named-models sentence (lists every binding): not adjustable in the dialog, so it always appears, letting the model
   * paste every canonical string back verbatim next call.
   */
  describeScriptModels?: () => string;
}): string {
  const { applied, defaultConcurrency } = options;
  return [
    describeWorkflowSettingsAdjustment(applied, defaultConcurrency),
    applied.max_concurrency === undefined ? options.describeLimit() : "",
    applied.subagent_model === undefined ? options.describeModel() : "",
    options.describeScriptModels?.() ?? "",
  ].join("");
}
