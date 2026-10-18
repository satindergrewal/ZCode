/**
  * engine.ts sat at oxlint max-lines cap (400); the **user-facing artifact** (dot-family)
  * publish/declare/admit/settle/resume-restore paths live here; the public surface still exports from engine.ts.
 *
  * ⚠ Terminology: below always means the **user-facing deliverable**, not RunSettlement.artifact.
  * Free functions read/write engine state via the EngineState seam; the same-named WorkflowEngine methods are thin delegates.
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
import { hashMismatch } from "./scheduler.js";
import type { EngineState } from "./engine-state.js";
import type {
  ArtifactPublishRequest,
  ArtifactRef,
  ArtifactVersionRecord,
  InstanceRef,
} from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/**
  * Publish a **content artifact** (file / markdown). The effect family: the driver copies bytes into
  * the store; success fulfills the ref, failure rejects catchably -- the script gating idiom is
  * try/catch around the publish.
 *
  * Order:
  * 1. nextOrdinal -> journal hit? A hit short-circuits: compare inputHash; on success record and return its ref;
  *    on failure re-reject with the recorded one (resume is crash recovery, not re-verification: a failed publish stays
  *    that failure after recovery; re-running it would walk the catch branch twice differently). Hits never re-emit events (as in report).
  * 2. Miss: kind attribution -> id-count cap -> version cap; all three node-level rejections (a promise to reject).
  * 3. The version number is computed before dispatch and handed to the driver (it belongs in the store toolCallId; one byte set per version).
  * 4. putNode running -> driver -> success putNode completed + published event;
  *    failure putNode failed + failed event -> reject.
 *
  * Neither path emits node lifecycle events (queued/dispatched/settled): artifact sites are nodes in neither
  * graph, and a node-settled on such a site would be reduced into the node list by the projections, becoming
  * an unexplainable unknown node on the run panel.
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
    // Runtime guard for arg shape (the compile-time literal-id diagnostic and facade types are the front door): a non-string here
    // means something bypassed compilation. DriverError, not an Artifact code -- keep those codes meaning
    // exactly their one thing (the same coding argument as the report probe).
  //
    // These two write no journal row and emit no event, unlike every failure path below: they are **deterministic** --
    // the verdict depends only on the args, no driver round trip; a resume re-run gets the same rejection, so
    // no row is needed to pin it (the settled-failure-must-persist rule targets driver-executed
    // failures that may not repeat). Besides, there is no id yet for the artifact column or an event --
    // minting one would suggest an artifact that does not exist.
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
    // The primary flag is read by the **engine**: the driver passes through unknown
    // opts keys, and at-most-one-primary-per-run is a run-level fact only the engine knows. A non-boolean
    // belongs to the same deterministic guard class -- no row, no event.
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
        // As with ask/world hits: the release passes the replay order gate. Publishing is an effect the script awaits, so it is
        // a release point that orders subsequent continuations; preset declarations are synchronous void, never here, never gated.
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
        // status running: crashed mid-execution; re-live below (the byte copy is idempotent,
        // and version numbers derive from **completed rows**, so a re-run cannot skip numbers).
  }

    // Sticky: an id already primary stays primary this version, flag passed again or not.
  const idState = state.artifacts.get(id);
  const primary = primaryOption === true || idState?.primary === true;
  const admission = admitArtifact(state, id, op, primary);
  if (admission !== undefined) {
    return Promise.reject(settleArtifactFailure(state, instance, hash, { id, op }, admission));
  }

  const version = (idState?.versions ?? 0) + 1;
  const publish = state.driver.executeArtifactPublish;
  if (publish === undefined) {
        // No driver-side publish capability (pure replay, or a fake without a store). One loud named failure,
        // not a silent empty-artifact publish -- visible to the script, the node persists failed.
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
  * Declare a **preset artifact** (chart / table / metrics / board). Declaration family: synchronous,
  * no return, **never the driver** -- a declaration has nothing to await.
 *
  * Order: nextOrdinal -> hit returns -> spec shape validation
  * -> same id declared? equal canonical: idempotent no-op (no row, no event); different: failRun
  * -> caps -> completed row + published event.
 *
  * All three failures (bad spec / same id different spec / over cap) are failRun, not rejection: void has no
  * rejection channel -- the same argument as both report caps.
 */
export function declarePresetArtifact(
  state: EngineState,
  siteId: string,
  op: ArtifactPresetOp,
  args: unknown[],
): void {
    if (state.isRunSettled()) return; // as in report / log
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
        return; // replay dedupe: skip silently (as in report)
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
        if (idState.spec === canonical) return; // idempotent no-op: no new row, no event
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
    // primary is inside the canonical spec, so flag-changing on the same id is redeclared (rejected above); left here is
    // only a **new** id wanting primary while another is -- the preset family has no rejection channel: failRun.
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

    // Declaration is a **single write** (as report): no driver call between admission and settlement, nothing to fail in between.
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
  * Content-artifact admission: kind attribution -> id cap -> version cap. Returns the rejection reason; undefined passes.
 *
  * All three are **node-level** (content members have a promise to reject), contrasting with the same-named preset trio --
  // that family can only failRun. One fact, two channels; the difference is the return type, never severity.
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
    // The primary conflict precedes the caps: an id wanting to be the deliverable should be told one-exists-already, not full.
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
  * Content publish success: completed row + accounting + published event; returns the script-facing ref.
 *
  * Identity (id / kind / version) always comes from the **engine-computed** issue, never the same-named fields in
  * the driver record: the version is engine-derived and handed out; letting it round-trip the driver
  * only adds one more inconsistency point. The driver record owns what it truly owns -- uri / bytes /
  * contentType / sourcePath -- persisted verbatim.
 */
function settleArtifactPublish(
  state: EngineState,
  instance: InstanceRef,
  hash: string,
  issued: { id: string; op: ArtifactContentOp; version: number; primary: boolean },
  record: ArtifactVersionRecord,
): ArtifactRef {
  if (state.isRunSettled()) throw state.runError();
    // A driver round trip sits between admission and settlement: two concurrent primary publishes can both pass admission. Recheck at settlement;
    // the loser takes the failure path -- failed rows never claim the flag, so two completed primaries cannot exist.
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
    // The flag is engine-stamped: the driver record owns only uri / bytes / contentType / sourcePath.
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
  * Content publish failure: failed row + failed event; returns the error to throw.
 *
  * Persisting is a standing replay-sanity requirement (a settled failure must be in the journal), else resume re-runs a failure
  * the script already caught -- exactly what crash-recovery-not-reverification prevents.
 *
  * node-settled readers
  * would reduce it into the node list and search the graph by site id, yet artifact sites are in no graph -- an
  * unexplainable unknown node on the run panel. The failed event carries what a failure card needs
  * (id / kind / structured error) without posing as a unit of work. Success likewise emits only the published event.
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
  * Resume restore: fold one **completed** artifact row from the journal into memory state.
 *
  * **Only completed rows claim the id**: failed publishes take no id, no kind, no version. Not merely graph tidiness --
  * a failed row result is empty, kind unrecoverable; if live claimed and resume could not,
  * one script would hold two cap ledgers across the crash. Kind conflicts have their own compile-time diagnostic;
  * the runtime one here governs ids that truly published.
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

/** Whether the id is already a declared **preset** (a legal report-label target). */
export function isDeclaredPreset(state: EngineState, id: string): boolean {
  const idState = state.artifacts.get(id);
  return idState !== undefined && isArtifactPresetOp(idState.kind);
}

/** Declared preset ids, lexicographic -- only to make the undeclared message actionable. */
export function declaredPresetIds(state: EngineState): string[] {
  return [...state.artifacts.entries()]
    .filter(([, idState]) => isArtifactPresetOp(idState.kind))
    .map(([id]) => id)
    .sort();
}

/**
  * The persisted declaration record. Title/description are **lifted** from the spec: card readers (run side panel,
  * notices, the hub) get only this record and should not parse the spec to show a title; the spec stays verbatim for
  * renderers needing the full shape. Version always 1 -- a declaration has no versions; it happens once.
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
