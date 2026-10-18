import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getZCodeDataRootDir } from "@zcode/services/node";
import type {
  MaterializeWorkflowArtifactFileRequest,
  MaterializeWorkflowArtifactFileResult,
} from "@zcode/shared";

/**
 * Host-side copy of a dwf artifact "opened as a file" (docs/dynamic-workflow/authoring.md "How the user sees them").
 *
 * Terminology: artifact = output published to the user via `artifact.*`, not the engine's `RunSettlement.artifact`.
 *
 * Why desktop writes its own copy instead of opening the file in the CLI artifact store:
 *   - the store follows the CLI, which for SSH/WSL/Docker workspaces lives on another machine;
 *   - an external editor writing the store's file mutates a published version under the journal;
 *   - the protocol must hand a host path to the renderer.
 * The bytes are exactly what the artifact tab already read, so no protocol or CLI change is needed.
 */

const WORKFLOW_ARTIFACT_DIR = "workflow-artifacts";

/** Same byte cap tier as `artifact.file` (dynamic-workflow/src/facade/artifact-caps.ts). */
export const WORKFLOW_ARTIFACT_FILE_MAX_BYTES = 20 * 1024 * 1024;

const MAX_SEGMENT_LENGTH = 120;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;

/**
 * Location: `~/.zcode/tmp/workflow-artifacts/<runId>-<digest>/<artifactId>-<digest>/v<N>/<name>` (see {@link identitySegment}).
 *
 * **Write only when the path is absent**: one version's bytes never change, so an existing copy is
 * either those same bytes or a user's edit in an external app — both must survive, and reopening
 * must hit the same file. Implementation is "temp file + link": link fails with EEXIST without
 * overwriting when the target exists, so two concurrent clicks still land one complete file, and a
 * crash mid-write never leaves half a file at the final path (it would then never be rewritten
 * because it "exists").
 */
export async function materializeWorkflowArtifactFile(
  payload: MaterializeWorkflowArtifactFileRequest,
): Promise<MaterializeWorkflowArtifactFileResult> {
  const request = parseRequest(payload);
  const dir = join(
    getZCodeDataRootDir(),
    "tmp",
    WORKFLOW_ARTIFACT_DIR,
    identitySegment(request.runId),
    identitySegment(request.artifactId),
    `v${request.version}`,
  );
  const localPath = join(dir, sanitizeFileName(request.fileName, request.artifactId));

  await mkdir(dir, { recursive: true });
  const temporaryPath = join(dir, `.${randomUUID()}.partial`);
  await writeFile(temporaryPath, request.bytes, { flag: "wx" });
  try {
    await link(temporaryPath, localPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return { localPath };
}

/** Requests come from the renderer (IPC boundary); shape and caps are re-validated before touching disk. */
function parseRequest(payload: unknown): MaterializeWorkflowArtifactFileRequest {
  const fields = (payload ?? {}) as Partial<
    Record<keyof MaterializeWorkflowArtifactFileRequest, unknown>
  >;
  const { runId, artifactId, version, fileName, bytes } = fields;
  if (
    typeof runId !== "string" ||
    runId.trim().length === 0 ||
    typeof artifactId !== "string" ||
    artifactId.trim().length === 0 ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    typeof fileName !== "string" ||
    !(bytes instanceof Uint8Array)
  ) {
    throw new Error("Workflow artifact file request is invalid");
  }
  if (bytes.byteLength > WORKFLOW_ARTIFACT_FILE_MAX_BYTES) {
    throw new Error(
      `Workflow artifact is too large to open as a file (${bytes.byteLength} bytes, cap ${WORKFLOW_ARTIFACT_FILE_MAX_BYTES})`,
    );
  }
  return { runId, artifactId, version, fileName, bytes };
}

/**
 * run/artifact dirs: the sanitized id is for humans; the suffix is a digest of the **raw** id so
 * distinct ids always land in distinct directories.
 *
 * Fix (MR !2837 review CR-02): directory names used to be just the sanitized id, but "EEXIST means
 * same artifact" presumes the path uniquely maps to (run, artifact, version). Two legal ids can
 * collide: macOS/Windows filesystems are case-insensitive by default (`Report` vs `report`), and
 * sanitization strips leading dots (`.notes` vs `notes`). On collision the EEXIST hit attaches the
 * other artifact's file, opening a different artifact plus its user edits. runId is minted
 * `dwfrun-<uuid>` by the CLI and would not collide, but the IPC boundary only checks non-empty —
 * directory uniqueness must not rest on that convention, so both segments follow the same rule.
 */
function identitySegment(id: string): string {
  const digest = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8);
  return `${sanitizeSegment(id)}-${digest}`;
}

/** Directory segment (runId/artifactId): keep `[A-Za-z0-9._-]`, strip leading dots (no `.`/`..`, no hidden dirs). */
function sanitizeSegment(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, MAX_SEGMENT_LENGTH);
  return cleaned.length === 0 ? "_" : cleaned;
}

/**
 * File name: take the last segment (`/` and `\` both separate), replace platform-illegal and
 * control chars, keep Unicode and the extension — the extension picks the opening app. Strip
 * leading dots (no hidden files, no `..`) plus trailing dots/spaces (Windows eats them silently),
 * prefix underscores for Windows reserved names; fall back to the artifact id if empty.
 */
function sanitizeFileName(fileName: string, artifactId: string): string {
  const leaf = fileName.split(/[\\/]/u).at(-1) ?? "";
  let cleaned = leaf
    // oxlint-disable-next-line no-control-regex -- control chars are exactly what is being replaced.
    .replace(/[<>:"|?*\u0000-\u001f]/gu, "_")
    .trim()
    .replace(/^\.+/u, "")
    .replace(/[. ]+$/u, "");
  if (cleaned.length === 0) cleaned = sanitizeSegment(artifactId);
  if (WINDOWS_RESERVED_NAME.test(cleaned)) cleaned = `_${cleaned}`;
  if (cleaned.length > MAX_SEGMENT_LENGTH) {
    const dot = cleaned.lastIndexOf(".");
    const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
    cleaned = cleaned.slice(0, MAX_SEGMENT_LENGTH - extension.length) + extension;
  }
  return cleaned;
}
