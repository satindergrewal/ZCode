/**
  * engine.ts sat at oxlint max-lines cap (400); the report() publish path (serialization probe,
  * replay dedupe, label check, the two caps, one write) lives here; the public surface still exports from engine.ts.
 *
  * Free functions read/write engine state via the EngineState seam; WorkflowEngine.report is a thin delegate.
 */

import { inputHash } from "./hash.js";
import { REPORT_CAPS } from "../facade/report-caps.js";
import { declaredPresetIds, isDeclaredPreset } from "./engine-artifacts.js";
import { hashMismatch } from "./scheduler.js";
import type { EngineState } from "./engine-state.js";
import type { InstanceRef } from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/**
  * Publish one intermediate result (Boundary A report). Synchronous, no return, no driver round trip:
  * one journal row plus one event, done.
 *
  * Four steps, in a deliberate order:
 *
  * 1. **Serialization probe first**. One JSON.stringify yields two things: whether the item is representable
  *    and its byte size (the cap metric). Before canonicalJson -- a cyclic item would
  *    blow the canonical recursion stack: a crash, not a readable failure.
  * 2. **Replay hits skip**: no event, no row rewrite. Compare inputHash first; a mismatch fails the run
  *    as a purity violation. The check is **defensive** (a report derives from values the journal already pinned)
  *    but free -- and an offset here means the whole replay is untrustworthy, which Results readers must
  *    never see unknowingly.
  * 3. **Caps before persistence**: count or per-item bytes over means ReportCapExceeded fails the run.
  *    Run-level not node-level: report returns void, no channel to reject into.
  * 4. **One write**: completed, no actor fields.
 */
export function publishReport(
  state: EngineState,
  siteId: string,
  item: unknown,
  artifactId?: string,
): void {
    if (state.isRunSettled()) return; // as in log: nothing accepted after settlement
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };

  const serialized = probeReportItem(state, instance, item);
    if (serialized === undefined) return; // the probe already failed the run
    // inputHash deliberately covers **the item only**, never the label: the label is a compile-time literal on the site, and resume
    // requires a byte-identical script (script_hash), so a label for the same site+ordinal cannot change. Adding it to
    // the hash would only make **every** existing label-less journal report
    // InputHashMismatch on resume -- a destructive payload reshaping with zero benefit.
  const hash = inputHash(item);

  const recorded = state.journal.getNode(state.runId, siteId, ordinal);
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      state.failRun(hashMismatch(instance, recorded.inputHash, hash));
      return;
    }
        return; // replay dedupe: skip silently (no event, no double append)
  }

    // Label present: it must already be declared as a **preset** artifact. Checked before the caps -- a label pointing at a nonexistent board
    // is a script bug, not a capacity event; mixing the two makes the error code lie.
    // failRun, not reject, for the same reason as both report caps: a void return has no rejection channel.
  if (artifactId !== undefined && !isDeclaredPreset(state, artifactId)) {
    state.failRun(
      new WorkflowError(
        "ArtifactUndeclared",
        `report() tag "${artifactId}" is not a declared preset artifact ` +
          `(at ${refToString(instance)}). Declare it once at the top of the script, e.g. ` +
          `artifact.chart("${artifactId}", …), before tagging reports with it. Declared presets: ` +
          `${declaredPresetIds(state).join(", ") || "(none)"}.`,
      ),
    );
    return;
  }

  if (!reserveReport(state, instance, serialized)) return;
  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal,
    kind: "report",
    inputHash: hash,
    status: "completed",
    result: item,
        // A labeled report row is where board-equals-journal-projection lands: each point of a board
        // is one row of kind report with that artifact id.
    ...(artifactId === undefined ? {} : { artifactId }),
  });
  state.record({
    type: "report",
    instance,
    item,
    ...(artifactId === undefined ? {} : { artifactId }),
  });
}

/**
  * The runtime JSON guard for report (the compile-time serializability diagnostic is the suspenders; this is the belt).
  * Returns the serialized text; on non-representability fails the run and returns undefined.
 *
  * Why JSON.stringify, not canonicalJson: canonicalJson is total (silently folds
  * undefined/functions to null, blows the stack on cycles) -- right for a hash input,
  * but as a guard it would quietly persist a broken item. JSON.stringify is the opposite: cycles and bigint
  * throw, undefined/function/symbol return undefined -- both become a loud, catchable failure.
 *
  * The code is DriverError, not ReportCapExceeded: this is not a cap (caps are counts) but
  * the item-is-JSON contract breaking; that contract is fronted by the compile-time diagnostic. Reaching here means something
  * bypassed the front door (typically a cycle built through any) -- a contract break, not a capacity event;
  * keeping ReportCapExceeded about caps lets readers act by code.
 */
function probeReportItem(
  state: EngineState,
  instance: InstanceRef,
  item: unknown,
): string | undefined {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(item);
  } catch (cause) {
    state.failRun(
      new WorkflowError(
        "DriverError",
        `report() item cannot be serialized to JSON (a cycle or a bigint) at ` +
          `${refToString(instance)}. Report a plain JSON value.`,
        { cause },
      ),
    );
    return undefined;
  }
  if (serialized === undefined) {
        // JSON.stringify returns undefined for undefined / functions / symbols.
    state.failRun(
      new WorkflowError(
        "DriverError",
        `report() item is not a JSON value (undefined, a function or a symbol) at ` +
          `${refToString(instance)}. Report a plain JSON value.`,
      ),
    );
    return undefined;
  }
  return serialized;
}

/** The two report caps (count, per-item bytes). Either exceeded: failRun, return false. */
function reserveReport(state: EngineState, instance: InstanceRef, serialized: string): boolean {
  const bytes = utf8ByteLength(serialized);
  if (bytes > REPORT_CAPS.maxItemSerializedBytes) {
    state.failRun(
      new WorkflowError(
        "ReportCapExceeded",
        `report() item at ${refToString(instance)} is ${bytes} bytes, over the ` +
          `${REPORT_CAPS.maxItemSerializedBytes}-byte limit. Report a summary instead.`,
      ),
    );
    return false;
  }
  if (state.reportCount() >= REPORT_CAPS.maxItemsPerRun) {
    state.failRun(
      new WorkflowError(
        "ReportCapExceeded",
        `This run already reported ${REPORT_CAPS.maxItemsPerRun} items, the maximum. ` +
          `Report findings, not chatter.`,
      ),
    );
    return false;
  }
  state.countReport();
  return true;
}

/**
  * UTF-8 byte length of a string (the report per-item cap metric). TextEncoder (a WHATWG
  * global), not Buffer.byteLength: the package stays free of node builtins. The cap counts **bytes**, not
  * chars -- a CJK findings text has a third as many chars as bytes; counting chars would hollow the cap.
 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
