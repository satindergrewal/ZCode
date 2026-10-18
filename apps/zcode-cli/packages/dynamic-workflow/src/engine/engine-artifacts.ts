/**
 * engine.ts is at the oxlint max-lines cap (400), so user-facing artifact (artifact.*) publish /
 * declare / admit / settle / resume-recover live here; the public face still exports from engine.ts.
 *
 * ⚠ Terminology: everything below is the user-facing artifact (what the script shows the user), not RunSettlement.artifact.
 * Free functions touch engine state via the {@link EngineState} seam; same-named methods on WorkflowEngine are thin delegates.
 */

import { canonicalJson, inputHash } from "./hash.js";
import { ARTIFACT_CAPS } from "../facade/artifact-caps.js";
import {
  isArtifactPresetOp,
  type ArtifactContentOp,
  type ArtifactPresetOp,
} from "../facade/registry.js";
import { heldResolution } from "./replay-order.js";
import {
  primaryArtifactId,
  primaryConflict,
  primaryConflictMessage,
} from "./engine-artifacts-primary.js";
import { validateArtifactSpec } from "./artifact-spec.js";
import { hashMismatch } from "./hash-mismatch.js";
import type { EngineState } from "./engine-state.js";
import type {
  ArtifactPublishRequest,
  ArtifactRef,
  ArtifactVersionRecord,
  InstanceRef,
} from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/**
 * Publish one content artifact (artifact.file / artifact.markdown). Effect family: bytes copied
 * into the store via driver; resolves {@link ArtifactRef} on success, rejects catchably on
 * failure - the script's gating idiom is try/catch around the await.
 *
 * Order:
 * 1. nextOrdinal -> journal hit? A hit short-circuits: compare inputHash; on success return the recorded ArtifactRef,
 *    on failure re-reject per the record (resume is crash recovery, not re-verification: a failed
 *    publish stays that failure; rerunning it would walk the catch branch twice differently).
 *    Hits never re-emit events (same as report).
 * 2. Miss: kind check -> id-count cap -> version cap; all three node-level rejections (a promise exists to reject).
 * 3. The version is computed before dispatch and handed to the driver (the store's toolCallId carries it; one row of bytes per version).
 * 4. putNode(running) -> driver -> success putNode(completed) + artifact-published;
 *    failure putNode(failed) + artifact-failed -> reject.
 *
 * Neither path emits node lifecycle events (node-queued/dispatched/settled): artifact sites are
 * nodes in neither graph; a node-settled there would be reduced into nodes[] and become an
 * unexplainable unknown node in the run panel.
 */
export function publishContentArtifact(
  state: EngineState,
  siteId: string,
  op: ArtifactContentOp,
  args: unknown[],
): Promise<ArtifactRef> {
  if (state.isRunSettled()) return Promise.reject(state.runError());
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };

  const id = args[0];
  const payload = args[1];
  // Runtime guard for arg shapes (the compile-time literal-id diagnostic and facade types are the
  // front door): a non-string here means something bypassed compilation. DriverError, not an
  // Artifact* code - keep those codes meaning exactly their one thing (same argument as
  // probeReportItem's code for non-JSON item).
  //
  // These two write no journal row and emit no event, unlike every failure path below: they are
  // deterministic - the verdict depends on args alone, no driver round trip, so a resume rerun
  // gets the same refusal and no row is needed to pin it (the settled-failure-must-be-journaled
  // rule targets driver-executed failures that may not recur). There is no id here anyway to put
  // into artifact_id or an event - inventing one would imply an artifact exists.
  if (typeof id !== "string" || id === "") {
    return Promise.reject(
      new WorkflowError(
        "DriverError",
        `artifact.${op}: id must be a non-empty string (at ${refToString(instance)}).`,
      ),
    );
  }
  if (typeof payload !== "string") {
    return Promise.reject(
      new WorkflowError(
        "DriverError",
        op === "file"
          ? `artifact.file: path must be a string (at ${refToString(instance)}).`
          : `artifact.markdown: content must be a string (at ${refToString(instance)}).`,
      ),
    );
  }
  // opts.primary is read by the engine: the driver passes unknown opts keys through, while
  // at-most-one-primary-per-run is run-level fact only the engine knows. Non-boolean joins the
  // deterministic guards above - no row, no event.
  const primaryOption = (args[2] as { primary?: unknown } | undefined)?.primary;
  if (primaryOption !== undefined && typeof primaryOption !== "boolean") {
    return Promise.reject(
      new WorkflowError(
        "DriverError",
        `artifact.${op}: opts.primary must be a boolean (at ${refToString(instance)}).`,
      ),
    );
  }
  const hash = inputHash({ args, id, op });

  const recorded = state.journal.getNode(state.runId, siteId, ordinal);
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      const err = hashMismatch(instance, recorded.inputHash, hash);
      state.failRun(err);
      return Promise.reject(err);
    }
    // Same as ask/world hits: the release passes the replay settle-order gate
    // (docs/execution-engine.md "Replaying the settle order"). A publish is an effect the script
    // awaits, so it is a release point that orders continuations; preset declares are sync void,
    // never this path, never gated.
    if (recorded.status === "completed") {
      const record = recorded.result as ArtifactVersionRecord;
      return heldResolution(state.holdForReplay, instance, () => ({
        id: record.id,
        version: record.version,
      }));
    }
    if (recorded.status === "failed") {
      return heldResolution(state.holdForReplay, instance, () => {
        throw WorkflowError.fromJSON(recorded.error!);
      });
    }
    // status running: crashed mid-execution, re-executes live below (the byte copy is idempotent,
    // and the version derives from completed rows, so a rerun skips no numbers).
  }

  // Stickiness: once an id is primary, every later version is, regardless of primary at publish.
  const idState = state.artifacts.get(id);
  const primary = primaryOption === true || idState?.primary === true;
  const admission = admitArtifact(state, id, op, primary);
  if (admission !== undefined) {
    return Promise.reject(settleArtifactFailure(state, instance, hash, { id, op }, admission));
  }

  const version = (idState?.versions ?? 0) + 1;
  const publish = state.driver.executeArtifactPublish;
  if (publish === undefined) {
    // The rig has no driver-side publish (pure replay / store-less fake). One loud named failure,
    // not a silent empty artifact: the script sees it and the node lands failed.
    return Promise.reject(
      settleArtifactFailure(
        state,
        instance,
        hash,
        { id, op },
        new WorkflowError(
          "ArtifactStoreUnavailable",
          `Cannot publish "${id}": this host has no artifact store (at ${refToString(instance)}).`,
        ),
      ),
    );
  }

  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal,
    kind: "artifact",
    inputHash: hash,
    status: "running",
    artifactId: id,
  });

  const request: ArtifactPublishRequest = {
    runId: state.runId,
    siteId,
    ordinal,
    op,
    id,
    version,
    ...(op === "file" ? { path: payload } : { content: payload }),
    ...(args[2] === undefined ? {} : { opts: args[2] }),
  };
  return publish.call(state.driver, request).then(
    (record) => settleArtifactPublish(state, instance, hash, { id, op, version, primary }, record),
    (cause: unknown) => {
      const err =
        cause instanceof WorkflowError
          ? cause
          : new WorkflowError("DriverError", `Artifact publish failed: ${op} "${id}".`, {
              cause,
            });
      throw settleArtifactFailure(state, instance, hash, { id, op }, err);
    },
  );
}

/**
 * Declare a preset artifact (artifact.chart/table/metrics/board). Declaration family: sync, void, no driver - a declaration has nothing to await.
 *
 * Order: nextOrdinal -> hit returns -> spec shape check -> same-id declared? equal canonical =>
 * idempotent no-op (no row, no event); differing => failRun -> caps -> putNode(completed) + artifact-published.
 *
 * All three failures (bad spec / same id different spec / over cap) failRun, not reject: void has no rejection channel, same argument as report's two caps.
 */
export function declarePresetArtifact(
  state: EngineState,
  siteId: string,
  op: ArtifactPresetOp,
  args: unknown[],
): void {
  if (state.isRunSettled()) return; // as report / log
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };

  const id = args[0];
  if (typeof id !== "string" || id === "") {
    state.failRun(
      new WorkflowError(
        "DriverError",
        `artifact.${op}: id must be a non-empty string (at ${refToString(instance)}).`,
      ),
    );
    return;
  }
  const spec = args[1];
  const hash = inputHash({ args, id, op });

  const recorded = state.journal.getNode(state.runId, siteId, ordinal);
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      state.failRun(hashMismatch(instance, recorded.inputHash, hash));
      return;
    }
    return; // replay dedupe: silent skip (as report)
  }

  const problem = validateArtifactSpec(op, spec);
  if (problem !== undefined) {
    state.failRun(
      new WorkflowError(
        "ArtifactSpecInvalid",
        `Artifact "${id}" has an invalid spec (at ${refToString(instance)}): ${problem}`,
      ),
    );
    return;
  }

  const canonical = canonicalJson(spec);
  const idState = state.artifacts.get(id);
  if (idState !== undefined) {
    if (idState.kind !== op) {
      state.failRun(
        new WorkflowError(
          "ArtifactKindMismatch",
          `Artifact id "${id}" is already a ${idState.kind} and cannot be declared as a ${op} ` +
            `(at ${refToString(instance)}). An id belongs to one artifact kind for the whole run; ` +
            `use a different id.`,
        ),
      );
      return;
    }
    if (idState.spec === canonical) return; // idempotent no-op: no row, no event
    state.failRun(
      new WorkflowError(
        "ArtifactRedeclared",
        `Artifact "${id}" was already declared with a different spec (at ${refToString(instance)}). ` +
          `The spec for one id must stay identical (an identical re-declaration is a no-op); ` +
          `declare it once at the top of the script.`,
      ),
    );
    return;
  }
  // primary is inside the canonical spec, so same-id flag changes are ArtifactRedeclared (refused
  // above); only a NEW id claiming primary while another holds it remains - declaration family has
  // no rejection channel, failRun.
  const wantsPrimary = (spec as { primary?: unknown }).primary === true;
  const holder = wantsPrimary ? primaryArtifactId(state) : undefined;
  if (holder !== undefined && holder !== id) {
    state.failRun(
      new WorkflowError(
        "ArtifactPrimaryConflict",
        primaryConflictMessage(id, holder, `declare "${id}" without primary`, instance),
      ),
    );
    return;
  }
  if (state.artifacts.size >= ARTIFACT_CAPS.maxArtifactsPerRun) {
    state.failRun(
      new WorkflowError(
        "ArtifactCapExceeded",
        `Cannot declare "${id}": this run already has ${ARTIFACT_CAPS.maxArtifactsPerRun} artifact ` +
          `ids, the maximum. Reuse an existing id or publish fewer artifacts.`,
      ),
    );
    return;
  }

  // A declaration is one-write (as report): no driver call between admission and settlement; nothing can fail between.
  const record = presetRecord(id, op, spec);
  state.artifacts.set(id, {
    kind: op,
    spec: canonical,
    versions: 1,
    ...(wantsPrimary ? { primary: true as const } : {}),
  });
  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal,
    kind: "artifact",
    inputHash: hash,
    status: "completed",
    result: record,
    artifactId: id,
  });
  state.record({ type: "artifact-published", instance, artifact: record });
}

/**
 * Content admission: kind check -> id cap -> version cap. Returns the refusal reason; undefined passes.
 *
 * All three are node-level rejections (content has a promise to reject), mirroring the preset family's failRun-only trio: one fact, two channels; the return type differs, not severity.
 */
function admitArtifact(
  state: EngineState,
  id: string,
  op: ArtifactContentOp,
  primary: boolean,
): WorkflowError | undefined {
  const idState = state.artifacts.get(id);
  if (idState !== undefined && idState.kind !== op) {
    return new WorkflowError(
      "ArtifactKindMismatch",
      `Artifact id "${id}" is already a ${idState.kind} and cannot be published as a ${op}. An id ` +
        `belongs to one artifact kind for the whole run (publishing the same id again creates a ` +
        `new version, and a version cannot change what it is); use a different id.`,
    );
  }
  // primary conflict precedes caps: an id wanting to be the deliverable is refused for 'already has one', not 'full'.
  const holder = primaryConflict(state, id, primary);
  if (holder !== undefined) {
    return new WorkflowError(
      "ArtifactPrimaryConflict",
      primaryConflictMessage(id, holder, `publish "${id}" without primary`, undefined),
    );
  }
  if (idState === undefined && state.artifacts.size >= ARTIFACT_CAPS.maxArtifactsPerRun) {
    return new WorkflowError(
      "ArtifactCapExceeded",
      `Cannot publish "${id}": this run already has ${ARTIFACT_CAPS.maxArtifactsPerRun} artifact ` +
        `ids, the maximum. Publish a new version of an existing id instead.`,
    );
  }
  if (idState !== undefined && idState.versions >= ARTIFACT_CAPS.maxVersionsPerArtifact) {
    return new WorkflowError(
      "ArtifactVersionCapExceeded",
      `Artifact "${id}" already has ${idState.versions} versions, the maximum of ` +
        `${ARTIFACT_CAPS.maxVersionsPerArtifact}. Publish the final content in fewer versions.`,
    );
  }
  return undefined;
}

/**
 * Content publish success: completed row + bookkeeping + artifact-published; returns the script-facing ref.
 *
 * Identity (id/kind/version) always comes from the engine's own computation (issued), never the
 * driver record's same-named fields: the version is engine-derived and issued; round-tripping it
 * through the driver only adds a skew point. The driver record owns what it truly owns -
 * uri/bytes/contentType/sourcePath - journaled verbatim.
 */
function settleArtifactPublish(
  state: EngineState,
  instance: InstanceRef,
  hash: string,
  issued: { id: string; op: ArtifactContentOp; version: number; primary: boolean },
  record: ArtifactVersionRecord,
): ArtifactRef {
  if (state.isRunSettled()) throw state.runError();
  // A driver round trip sits between admission and settlement: two concurrent primary publishes can both pass. Recheck at settlement; the loser takes the failure path - failed rows never claim the flag, so two completed primaries cannot exist.
  const holder = primaryConflict(state, issued.id, issued.primary);
  if (holder !== undefined) {
    throw settleArtifactFailure(
      state,
      instance,
      hash,
      issued,
      new WorkflowError(
        "ArtifactPrimaryConflict",
        primaryConflictMessage(
          issued.id,
          holder,
          `publish "${issued.id}" without primary`,
          instance,
        ),
      ),
    );
  }
  // The flag is engine-stamped: the driver record owns only uri/bytes/contentType/sourcePath.
  const stored: ArtifactVersionRecord = issued.primary ? { ...record, primary: true } : record;
  state.journal.putNode({
    runId: state.runId,
    siteId: instance.siteId,
    ordinal: instance.ordinal,
    kind: "artifact",
    inputHash: hash,
    status: "completed",
    result: stored,
    artifactId: issued.id,
  });
  state.artifacts.set(issued.id, {
    kind: issued.op,
    versions: issued.version,
    ...(issued.primary ? { primary: true as const } : {}),
  });
  state.record({ type: "artifact-published", instance, artifact: stored });
  return { id: issued.id, version: issued.version };
}

/**
 * Content publish failure: failed row + artifact-failed; returns the error to throw.
 *
 * Persistence is the standing replay-sanity requirement (settled failures in journal); else resume reruns a failure the script already caught - what crash-recovery-not-reverify guards.
 *
 * node-settled readers would reduce it into nodes[] and hunt the graph by site id, but artifact
 * sites are in no graph - an unexplainable unknown node in the run panel. artifact-failed carries
 * what a failure card needs (id/kind/structured error) without posing as work; success likewise
 * emits only artifact-published.
 */
function settleArtifactFailure(
  state: EngineState,
  instance: InstanceRef,
  hash: string,
  issued: { id: string; op: ArtifactContentOp },
  error: WorkflowError,
): WorkflowError {
  const json = error.toJSON();
  state.journal.putNode({
    runId: state.runId,
    siteId: instance.siteId,
    ordinal: instance.ordinal,
    kind: "artifact",
    inputHash: hash,
    status: "failed",
    error: json,
    artifactId: issued.id,
  });
  state.record({
    type: "artifact-failed",
    instance,
    id: issued.id,
    op: issued.op,
    error: json,
  });
  return error;
}

/**
 * Resume recovery: fold one completed artifact row from the journal into memory state.
 *
 * Only completed rows claim the id: failed publishes take no id, kind, or version. Not just
 * graph tidiness - a failed row's result is empty, kind unrecoverable; if live claimed and resume
 * could not, one script would hold two cap ledgers across the crash. Kind conflicts have a
 * compile-time diagnostic; this runtime ArtifactKindMismatch governs ids that truly published.
 */
export function rememberArtifactRow(
  state: EngineState,
  id: string | undefined,
  result: unknown,
): void {
  if (id === undefined || id === "") return;
  const record = (result ?? undefined) as ArtifactVersionRecord | undefined;
  if (record?.kind === undefined) return;
  const existing = state.artifacts.get(id);
  const spec = record.spec === undefined ? existing?.spec : canonicalJson(record.spec);
  const primary = record.primary === true || existing?.primary === true;
  state.artifacts.set(id, {
    kind: record.kind,
    ...(spec === undefined ? {} : { spec }),
    versions: (existing?.versions ?? 0) + 1,
    ...(primary ? { primary: true as const } : {}),
  });
}

/** Whether the id is a declared preset (a legal `report` tag target). */
export function isDeclaredPreset(state: EngineState, id: string): boolean {
  const idState = state.artifacts.get(id);
  return idState !== undefined && isArtifactPresetOp(idState.kind);
}

/** Declared preset ids (sorted) - only to make the ArtifactUndeclared message actionable. */
export function declaredPresetIds(state: EngineState): string[] {
  return [...state.artifacts.entries()]
    .filter(([, idState]) => isArtifactPresetOp(idState.kind))
    .map(([id]) => id)
    .sort();
}

/**
 * Persisted preset declaration. title/description are lifted out of the spec: card readers (run
 * side panel, notifications, hub) get only this record and must not parse spec for a title; spec
 * stays verbatim for renderers needing the full shape. Version always 1 - declarations happen once.
 */
function presetRecord(id: string, op: ArtifactPresetOp, spec: unknown): ArtifactVersionRecord {
  const options = (spec ?? {}) as { title?: unknown; description?: unknown; primary?: unknown };
  return {
    id,
    kind: op,
    version: 1,
    ...(typeof options.title === "string" ? { title: options.title } : {}),
    ...(typeof options.description === "string" ? { description: options.description } : {}),
    spec,
    ...(options.primary === true ? { primary: true as const } : {}),
  };
}
