// ============================================================
// Byte read-back for user-facing artifacts (the body of DynamicWorkflowRunPort.readArtifact)
// ============================================================
//
// Terminology: "artifact" here is output the script published to the **user** via `artifact.*` (journal
// rows with `kind = "artifact"`), **not** the engine-internal `RunSettlement.artifact` (the script's top-level return,
// `output` / `result` on the port).
//
// Split from dynamic-workflow-run-service.ts (that file already carries max-lines debt; no more), for the
// same reason the driver's publish path became workflow-artifact-publish.ts: one byte read
// crosses authorize -> locate -> store, and each step has a discipline that must be written down.
//
// **The authorization chain** (same discipline as attachmentRead):
//
//   the caller's (runId, artifactId, version)
//        │
//        |-1. does the runId's dwf_run row exist?                 no => undefined
//        |-2. is that row's parent_session_id this service's parent session? no => undefined
//        |-3. a completed (artifactId, version) artifact row       no => undefined
//        |    in the journal?
//        |-4. does that row's record carry a uri? (preset boards do not) no => undefined
//        +-5. read from the store using the **row's** uri
//
// Step 5 is the whole point: renderer-supplied ids only **look up rows in the journal**, never become paths directly.
// Any intermediate failure returns undefined, never throws -- "no such version" / "not your run" / "it's a board"
// are one business fact to the caller (the gateway normalizes to not found); telling them apart only tells an
// overreaching caller which half it guessed right.

import type {
  DynamicWorkflowRunArtifactBytes,
  ToolArtifactStorePort,
} from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";

import {
  artifactRowId,
  supportsArtifactReads,
} from "./dynamic-workflow-run-artifact-queries.js";

interface WorkflowArtifactReadDeps {
  journal: JournalStorePort;
    /** This service's parent session (= this app's session); the comparison object of chain step 2. */
  parentSessionId: string;
  /**
      * Where the bytes live. **Optional**: replay-only / store-less assemblies have no bytes; the whole read is then absent
      * (the same assembly fact as the driver-side `ArtifactStoreUnavailable`, two faces of it).
   */
  artifactStore?: ToolArtifactStorePort;
}

/**
  * Reads one artifact version's full bytes. Chunking is the gateway's (<=512 KiB each); this returns all at once -- the
  * 20 MiB cap matches attachments, and slicing the authorization chain into the chunk loop would
  * make every chunk re-walk the journal.
 */
export async function readWorkflowArtifactBytes(
  deps: WorkflowArtifactReadDeps,
  runId: string,
  artifactId: string,
  version: number,
): Promise<DynamicWorkflowRunArtifactBytes | undefined> {
  const store = deps.artifactStore;
    // Binary read-back is an **optional member**: a store without it must not fall back to text-read-then-decode -- that is
    // the bug recorded on ToolBinaryArtifactReadResult (office files corrupted by utf8 decoding).
  if (store?.readToolResultBinaryArtifact === undefined) return undefined;

    // 1+2: the run exists and belongs to this session. getRun is on the engine port; no introspection probe needed.
  const run = deps.journal.getRun(runId);
  if (run === undefined) return undefined;
    // Legacy rows with NULL parent_session_id do **not** pass: the design requires sessionId == the run's
    // parentSessionId, and NULL means there is nothing to compare -- "cannot judge" is not "judged ok".
  if (run.parentSessionId === undefined || run.parentSessionId !== deps.parentSessionId) {
    return undefined;
  }

    // 3+4: locate the row in the journal; take the row's uri.
  const located = locateArtifactVersion(deps.journal, runId, artifactId, version);
  if (located === undefined) return undefined;

    // 5: only here is the store touched, fed the **row's** uri.
  const result = await store.readToolResultBinaryArtifact({ uri: located.uri });
  return {
    bytes: result.bytes,
        // contentType comes from the **journal record**, not the store's filename-based guess: the record's is
        // driver-computed from the extension table, overridable via `opts.contentType`, and exactly the UI renderer-dispatch
        // match contract. The store's inference table knows 8 extensions; using it turns `.csv` into application/json.
    contentType: located.contentType ?? result.contentType,
  };
}

/**
  * Finds the **completed** artifact row for (artifactId, version) in the journal and extracts its
  * `uri` and `contentType`.
 *
  * completed only: failed publishes never claim id/kind/version -- their `result` is empty,
  * and passing them through just reads an undefined uri. Preset-board records have no `uri` (no bytes; their data is
  * the label report rows in the journal) -- blocked here too; the caller gets undefined.
 */
function locateArtifactVersion(
  journal: JournalStorePort,
  runId: string,
  artifactId: string,
  version: number,
): { uri: string; contentType?: string } | undefined {
  if (!supportsArtifactReads(journal)) return undefined;
  for (const row of journal.listArtifactRows(runId)) {
    if (row.status !== "completed") continue;
    if (artifactRowId(row) !== artifactId) continue;
    const record = row.result;
    if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
    const fields = record as Record<string, unknown>;
    if (fields.version !== version) continue;
    const uri = typeof fields.uri === "string" && fields.uri.length > 0 ? fields.uri : undefined;
    if (uri === undefined) return undefined;
    const contentType =
      typeof fields.contentType === "string" && fields.contentType.length > 0
        ? fields.contentType
        : undefined;
    return { uri, ...(contentType === undefined ? {} : { contentType }) };
  }
  return undefined;
}
