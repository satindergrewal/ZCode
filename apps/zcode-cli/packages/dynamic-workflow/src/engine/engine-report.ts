/**
 * engine.ts is at the 400-line cap; report()'s publish path (serialization probe, replay dedupe,
 * tag validation, two caps, one-write) lives here; the public face stays on engine.ts.
 *
 * Free functions touch state via the {@link EngineState} seam; WorkflowEngine.report delegates.
 */

import { inputHash } from "./hash.js";
import { REPORT_CAPS } from "../facade/report-caps.js";
import { declaredPresetIds, isDeclaredPreset } from "./engine-artifacts.js";
import { hashMismatch } from "./hash-mismatch.js";
import type { EngineState } from "./engine-state.js";
import type { InstanceRef } from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/**
 * Publish one intermediate result (Boundary A report). Sync, void, no driver round trip:
 * one journal row + one event, done.
 *
 * Four steps, order matters:
 *
 * 1. Serialization probe first: one JSON.stringify yields both whether the item is representable
 *    and its byte size (the cap metric). Before canonicalJson - a cyclic item would blow the
 *    recursion stack: a crash, not a readable failure.
 * 2. Replay hits skip: no event, no rewrite. First compare inputHash; mismatch fails the run as a
 *    purity violation. Defensive (a report derives from journaled values) but free, and a skew here
 *    means the whole replay is untrustworthy - Results readers should never see that silently.
 * 3. Caps before persistence: per-item bytes, count, or run-level total over -> ReportCapExceeded
 *    fails the run. Run-level, not node: report returns void; there is nothing to reject into.
 * 4. One-write: completed, no actor fields.
 */
export function publishReport(
  state: EngineState,
  siteId: string,
  item: unknown,
  artifactId?: string,
): void {
  if (state.isRunSettled()) return; // as log: nothing accepted after settlement
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };

  const serialized = probeReportItem(state, instance, item);
  if (serialized === undefined) return; // the probe failRun-ed
  // inputHash deliberately covers the ITEM only, tags excluded: a tag is a compile-time literal on
  // the site and resume requires a byte-identical script (script_hash), so a (siteId,ordinal)'s tag
  // cannot change. Adding it to the hash would InputHashMismatch every tagless report already in
  // the journal on resume - destructive payload reshuffle for nothing.
  // the journal on resume - destructive payload reshuffle for nothing.
  const hash = inputHash(item);

  // Compare hashes, never the item (docs/execution-engine.md "Reading the journal"): replaying a
  // 65,536-report script would decode a <=1MiB item per hit only to discard it - paid by total bytes.
  const recorded = state.journal.getNode(state.runId, siteId, ordinal, { withResult: false });
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      state.failRun(hashMismatch(instance, recorded.inputHash, hash));
      return;
    }
    return; // replay dedupe: silent skip (no event, no double append)
  }

  // A present tag must be a DECLARED preset, checked before caps: a tag to an unknown board is a
  // script bug, not a capacity event; conflating them lets the code lie.
  if (artifactId !== undefined && !isDeclaredPreset(state, artifactId)) {
    // failRun, not reject - exactly the two-caps argument: void has no rejection channel.
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
    // Tagged report rows are where board = journal-projection lands: each point of a board is one
    // row kind = report AND artifact_id = that id.
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
/**
 * report's runtime JSON guard (the compile-time serializable diagnostic is the suspender; this is
 * the belt). Returns the serialized text; failRun + undefined when unrepresentable.
 * Why JSON.stringify, not canonicalJson: canonicalJson is total (folds undefined/functions to
 * "null" quietly; blows the stack on cycles) - right for a hash input, but as a guard it would
 * silently persist a broken item. JSON.stringify instead throws on cycles/bigint and returns
 * undefined for undefined/function/symbol - both catchable into one loud failure.
 * The code is DriverError, not ReportCapExceeded: not a cap (caps count) but a broken
 * item-is-JSON contract whose front door is the compile-time diagnostic. Getting here means
 * something bypassed it (typically an any-built cycle) - contract breach, not capacity; keeping
 * ReportCapExceeded caps-only lets readers act by code.
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

/**
 * report's three caps (per-item bytes, count, run-level total). Any over -> failRun, false.
 * Ordered by which check failed: an oversize item is that item's problem, independent of the run's
 * accumulation, so first; both run caps follow, before counting - the refused item never counts,
 * keeping the failure's numbers true.
 */
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
  const tally = state.reportTally();
  if (tally.count >= REPORT_CAPS.maxItemsPerRun) {
    state.failRun(
      new WorkflowError(
        "ReportCapExceeded",
        `This run already reported ${REPORT_CAPS.maxItemsPerRun} items, the maximum. ` +
          `Report findings, not chatter.`,
      ),
    );
    return false;
  }
  if (tally.bytes + bytes > REPORT_CAPS.maxBytesPerRun) {
    state.failRun(
      new WorkflowError(
        "ReportCapExceeded",
        `report() item at ${refToString(instance)} would take this run's reports to ` +
          `${tally.bytes + bytes} bytes, over the ${REPORT_CAPS.maxBytesPerRun}-byte limit per run. ` +
          `Report summaries, and publish large results with artifact.file.`,
      ),
    );
    return false;
  }
  state.countReport(bytes);
  return true;
}

/**
/**
 * UTF-8 byte length of a string (the per-item cap metric). TextEncoder (a standard ECMAScript
 * global) not Buffer.byteLength: this package keeps zero node builtins. Caps count BYTES, not
 * chars - a CJK findings text has ~1/3 the chars of its bytes; char-counting would void the cap.
 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
