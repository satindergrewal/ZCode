// ============================================================
// The workspace transcript read face (the bodies of DynamicWorkflowRunPort's two workspace methods)
// ============================================================
//
// A run's `files.*` / `git.*` / `world.run` calls are journal `dwf_node` rows with `kind` in {world-read,
// world-run}: `input_json` (migration 0030) is op + args, `result_json` the body.
// The UI replays them as tool cards -- the manifest (no bodies) first, bodies on expand.
//
// Split from dynamic-workflow-run-service.ts (that file carries max-lines debt already), for the
// same reason as artifact-read.ts.
//
// **The authorization chain** (the readArtifact discipline; both queries):
//
//   the caller's runId
//        |-1. does the dwf_run row exist?                              no => undefined
//        |-2. is that row's parent_session_id this service's parent session? no => undefined
//        +-3. only then touch node rows
//
// The manifest is authorized too, not just bodies: `files.read` bodies are workspace file contents, and manifest args are already
// paths and command lines -- neither should be served for "not your run". All three rejections normalize to undefined (the gateway to empty list /
// not found), never telling an overreaching caller which half it guessed.

import type { DwfRunIntrospectionQueries, DwfWorldNodeRow } from "@zcode/adapters/storage";
import type {
  DynamicWorkflowRunError,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
  DynamicWorkflowRunWorkspaceNodeSummary,
} from "@zcode/contracts";
import type { JournalStorePort, NodeRecord } from "@zcode/dynamic-workflow";

/** Display length of failure messages (= the protocol side's `WORKFLOW_WORKSPACE_LIMITS.maxErrorMessageLength`). */
const ERROR_MESSAGE_MAX_CHARS = 2000;

/**
  * The journal with workspace reads. The signature's single source is adapters' {@link DwfRunIntrospectionQueries}
  * (`import type`, zero runtime deps) -- the artifact-read argument again: `listWorldNodes` is not on the
  * engine's {@link JournalStorePort} (the engine never enumerates by kind), so only capability probing attaches it.
 */
interface WorkspaceReadableJournal
  extends JournalStorePort, Pick<DwfRunIntrospectionQueries, "listWorldNodes"> {}

/** Whether the journal has the workspace reads. Deliberately a sibling of `supportsArtifactReads`, not a widening (same argument). */
function supportsWorkspaceReads(journal: JournalStorePort): journal is WorkspaceReadableJournal {
  return typeof (journal as Partial<DwfRunIntrospectionQueries>).listWorldNodes === "function";
}

interface WorkflowWorkspaceReadDeps {
  journal: JournalStorePort;
    /** This service's parent session (= this app's); the comparison object of chain step 2. */
  parentSessionId: string;
}

/** Chain steps 1+2. `getRun` is on the engine port; no introspection probe needed. */
function authorizeRun(deps: WorkflowWorkspaceReadDeps, runId: string): boolean {
  const run = deps.journal.getRun(runId);
  if (run === undefined) return false;
    // Legacy rows with NULL parent_session_id do **not** pass: "cannot judge" is not "judged ok".
  return run.parentSessionId !== undefined && run.parentSessionId === deps.parentSessionId;
}

/** The workspace transcript manifest: world rows in persistence order, no bodies. */
export async function listWorkspaceNodesFrom(
  deps: WorkflowWorkspaceReadDeps,
  runId: string,
): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined> {
  if (!supportsWorkspaceReads(deps.journal)) return undefined;
  if (!authorizeRun(deps, runId)) return undefined;
  return deps.journal.listWorldNodes(runId).map(toWorkspaceNode);
}

function toWorkspaceNode(row: DwfWorldNodeRow): DynamicWorkflowRunWorkspaceNode {
  const summary = summaryOf(row);
  return {
    siteId: row.siteId,
    ordinal: row.ordinal,
    kind: row.kind === "world-run" ? "world-run" : "world-read",
    ...(row.input === undefined
      ? {}
      : {
          op: row.input.op,
          args: row.input.args,
          ...(row.input.truncated === true ? { inputTruncated: true as const } : {}),
        }),
    status: row.status,
    ...(row.error === undefined ? {} : { error: toRunError(row.error) }),
    ...(summary === undefined ? {} : { summary }),
    createdAt: row.timeCreated,
    updatedAt: row.timeUpdated,
  };
}

/** The store's in-DB computed summary -> port shape; only rows with bodies (settled ok) have one. */
function summaryOf(row: DwfWorldNodeRow): DynamicWorkflowRunWorkspaceNodeSummary | undefined {
  if (row.status !== "completed" || row.resultBytes === undefined) return undefined;
  return {
    resultBytes: row.resultBytes,
    ...(row.resultCount === undefined ? {} : { resultCount: row.resultCount }),
    ...(row.exitCode === undefined ? {} : { exitCode: row.exitCode }),
    ...(row.stdoutBytes === undefined ? {} : { stdoutBytes: row.stdoutBytes }),
    ...(row.stderrBytes === undefined ? {} : { stderrBytes: row.stderrBytes }),
  };
}

/** The journal's `WorkflowErrorJson` -> port code + message (no other field crosses; message tail-cut). */
function toRunError(error: { code: string; message: string }): DynamicWorkflowRunError {
  const message =
    error.message.length > ERROR_MESSAGE_MAX_CHARS
      ? `${error.message.slice(0, ERROR_MESSAGE_MAX_CHARS - 1)}…`
      : error.message;
  return { code: error.code, message };
}

/| One node's body, shape-preserving bounded to `query.maxBytes`. */
export async function readWorkspaceNodeResultFrom(
  deps: WorkflowWorkspaceReadDeps,
  runId: string,
  siteId: string,
  ordinal: number,
  query: DynamicWorkflowRunWorkspaceNodeResultQuery,
): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined> {
  if (!authorizeRun(deps, runId)) return undefined;
  const node = deps.journal.getNode(runId, siteId, ordinal);
  if (node === undefined) return undefined;
  if (node.kind !== "world-read" && node.kind !== "world-run") return undefined;
  return toNodeResult(node, query.maxBytes);
}

function toNodeResult(node: NodeRecord, maxBytes: number): DynamicWorkflowRunWorkspaceNodeResult {
  if (node.status === "failed") {
    return {
      status: "failed",
      ...(node.error === undefined ? {} : { error: toRunError(node.error) }),
      truncated: false,
      totalBytes: 0,
    };
  }
  if (node.status !== "completed" || !("result" in node)) {
    return { status: node.status, truncated: false, totalBytes: 0 };
  }
  const bounded = boundWorkspaceResult(node.result, maxBytes);
  return {
    status: "completed",
    result: bounded.result,
    truncated: bounded.truncated,
    totalBytes: bounded.totalBytes,
  };
}

// -- shape-preserving bounding ---------------------------------------------------
// Engine-side `WORLD_READ_CAPS` policy is "overflow rejects, never truncate-plus-flag" -- that is the script's data face;
// half a grep result makes scripts decide wrong. This is the audit face: a card wants "what ran, first few hundred lines",
// so truncating **and saying so** (`truncated` + `totalBytes`) beats "too large to read".

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Cuts a string to <= maxBytes UTF-8 bytes, never inside a surrogate pair. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes));
    // Drop a trailing incomplete multibyte sequence: decode would turn it into U+FFFD; rather one char less.
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  if (end > 0 && (bytes[end - 1]! & 0b1100_0000) === 0b1100_0000) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/**
  * Bounding by body shape:
  * - strings (read / diff / status): tail-cut;
  * - arrays (glob / grep / changedFiles / log): accumulate per item, drop the tail;
  * - `world.run`'s {exitCode, stdout, stderr}: exitCode always kept, half the budget per output;
  * - else: verbatim if the serialization fits, else degraded to tail-cut JSON text (shape unsalvageable).
 */
function boundWorkspaceResult(
  result: unknown,
  maxBytes: number,
): { result: unknown; truncated: boolean; totalBytes: number } {
  const serialized = JSON.stringify(result) ?? "null";
  const totalBytes = utf8ByteLength(serialized);
  if (totalBytes <= maxBytes) return { result, truncated: false, totalBytes };

  if (typeof result === "string") {
    return { result: truncateUtf8(result, maxBytes), truncated: true, totalBytes };
  }
  if (Array.isArray(result)) {
    const kept: unknown[] = [];
        let used = 2; // the brackets
    for (const item of result) {
      const itemBytes = utf8ByteLength(JSON.stringify(item) ?? "null") + 1;
      if (used + itemBytes > maxBytes) break;
      kept.push(item);
      used += itemBytes;
    }
    return { result: kept, truncated: true, totalBytes };
  }
  if (isRunResult(result)) {
    const overhead = utf8ByteLength(JSON.stringify({ ...result, stdout: "", stderr: "" }));
    const budget = Math.max(0, maxBytes - overhead);
    const stderrWant = utf8ByteLength(result.stderr);
    const stdoutWant = utf8ByteLength(result.stdout);
        // Half each; one side's leftover budget goes to the other.
    const stderrBudget = Math.min(stderrWant, Math.max(budget >> 1, budget - stdoutWant));
    const stdoutBudget = Math.max(0, budget - stderrBudget);
    return {
      result: {
        ...result,
        stdout: truncateUtf8(result.stdout, stdoutBudget),
        stderr: truncateUtf8(result.stderr, stderrBudget),
      },
      truncated: true,
      totalBytes,
    };
  }
  return { result: truncateUtf8(serialized, maxBytes), truncated: true, totalBytes };
}

function isRunResult(
  value: unknown,
): value is { exitCode: number; stdout: string; stderr: string } & Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return (
    typeof fields.exitCode === "number" &&
    typeof fields.stdout === "string" &&
    typeof fields.stderr === "string"
  );
}
