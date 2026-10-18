// ============================================================
// Workflow script analysis -- the single-slot memo's shared entry.
// ============================================================
//
// The approval gate analyzes pre-execution and the handler analyzes again post-run, so one approved call
 ran TypeScript twice. A single-slot memo keyed on the exact script text folds the pair into one compile;
 deliberately not a general cache -- the only repetition worth collapsing is this adjacent before/after pair.
//
// Extracted because **two** tools now share it: CreateWorkflow compiles before running, SaveWorkflow
 before saving, and it must be the same checker -- "saves but does not run" is this feature's
 hardest-to-explain failure.

import { analyzeWorkflowScript, type AnalyzeResult } from "@zcode/dynamic-workflow";

let lastAnalysis: { script: string; result: AnalyzeResult } | null = null;

/** Compile and analyze a workflow script; an adjacent repeat call hits the memo slot. */
export function analyzeScript(script: string): AnalyzeResult {
  if (lastAnalysis?.script === script) return lastAnalysis.result;
  const result = analyzeWorkflowScript(script);
  lastAnalysis = { script, result };
  return result;
}
