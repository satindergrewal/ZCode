/**
 * Any script value in a workflow run (the top-level returned artifact, `report(item)` entries) ->
 * text for the model or a reader. Rules: strings as-is; else `JSON.stringify(v, null, 2)`;
 * falling back to `String(v)` when stringify returns undefined or throws; `undefined` returns `undefined`
 *
 * Native to contracts (dynamic-workflow-run.port.ts): its three cross-package consumers then--the completion notice's
 * `<result>` / `<reports>` (core), `resultText` on runtime task entries (core, the only source of TaskOutput),
 * and `workflowRuns.reports[].preview` (the v4 projection, the detail page's Results row)--must emit
 * byte-identical text. When the fourth consumer appeared it moved here: the `reports[].preview` reduction sank with the shared
 * reducer (workflow-runs-reducer.ts), and dependency direction is contracts -> shared, which cannot import contracts.
 * contracts keeps a re-export in place; core-side consumers unchanged.
 *
 * Likewise no length cap here: the notice side truncates at 120k, TaskOutput has the artifact budget, the projection has
 * `maxReportPreviewLength`--bounds belong to each boundary.
 *
 * Artifact shapes are unconstrained--records, arrays, strings, numbers, null all legal--so there is no `isRecord` gate
 (the original read via legacy `Workflow`'s output.response, the cause of that desktop-measured bug).
 */
export function serializeWorkflowArtifact(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    // JSON.stringify returns undefined for undefined / function / symbol and throws on cycles--
    // both fall back to String(value); a value is never dropped whole.
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}
