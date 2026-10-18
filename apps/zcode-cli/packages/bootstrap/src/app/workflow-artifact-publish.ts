// ============================================================
// Execution side of artifact publishing (Boundary B's executeArtifactPublish)
// ============================================================
// Terminology: in this file artifact always means the **user-facing
// artifact** - the bytes a script delivers to the **user** via `artifact.file` / `artifact.markdown`; not the engine-internal
// artifact (`RunSettlement.artifact`, the top-level return value of `serializeWorkflowArtifact`, which is for
// the **model**). This file never touches the latter.
//
// Same division of labor as workflow-world-read.ts: the driver proper (workflow-driver.ts) owns actor-session and
// turn orchestration; this half turns one `(op, id, path | content, opts)` into one real **byte copy**
// without touching sessions, models, or the journal. Four duties live here, and only here:
//   1. **Argument/opts shape validation**. The engine only guarantees `id` and payload are non-empty strings
//      (runtime guard); `opts` is the script's verbatim third argument - what a title may look like is decided here,
//      same discipline as `worldReadStringArgs`: fail loudly, never `String(...)`-coerce.
//   2. **Path resolution and containment**. The resolver is the world-read one (`resolveWithinWorkspace`) plus
//      one realpath recheck; see {@link resolveWorkspaceFile}.
//   3. **Cap enforcement**. Constants in the pure package (`ARTIFACT_CAPS`), enforcement here, since only this side
//      sees the bytes; over-cap is always **rejected, never truncated** (same house policy as world-read - a
//      silently truncated PDF is a bad deliverable, while a named-cap refusal is a contract the script can act on).
//   4. **Write the tool-artifact store**, normalizing the store receipt into `ArtifactVersionRecord`.
//
// Refusals are always structured `WorkflowError` (codes: ArtifactSourceMissing /
// ArtifactPathOutsideWorkspace / ArtifactTooLarge / ArtifactStoreUnavailable), because a content member is a
// catchable promise in the script - the gating idiom `try { await artifact.file(...) } catch { ... }` presumes
// these refusals reach the script.

import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import {
  isFileSystemPortError,
  type FileSystemPort,
  type FileSystemReadBytesResult,
  type SessionId,
  type ToolArtifactStorePort,
  type ToolArtifactWriteResult,
} from "@zcode/contracts";
import {
  ARTIFACT_CAPS,
  ARTIFACT_ID_PATTERN,
  WorkflowError,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
} from "@zcode/dynamic-workflow";
import { resolveWithinWorkspace, toWorkspaceRelative } from "./workflow-world-read.js";

/** Ports and base directory artifact publishing needs (a subset of driver deps, cf. {@link WorldReadDeps}). */
interface ArtifactPublishDeps {
  /** File-system port used to read the published file's bytes. */
  readonly fileSystemPort: FileSystemPort;
  /** Base directory for path resolution/relativization (the workspace root). */
  readonly cwd: string;
  /**
   * Byte destination. **Optional**: pure replay / fake assemblies have no store.
   * When absent, content members reject loudly with `ArtifactStoreUnavailable` - never a silent
   * publish of an empty artifact, nor a fallback to workspace writes.
   */
  readonly artifactStore?: ToolArtifactStorePort;
  /**
   * Session scope for store writes = this run's **parent session**. Paired with `artifactStore`: every store write
   * is accounted per session (`zcode-artifact://<session>/<id>`), and without a session id no readable record can be
   * written. Both present means publishing is assembled; either missing is `ArtifactStoreUnavailable` (no store =
   * this assembly has no storage; no id = a wiring error - to the script they are the same thing: this publish
   * cannot happen, and it must be loud).
   */
  readonly parentSessionId?: SessionId;
}

/**
 * Execute one content-artifact publish: validate shape -> confirm the store -> get bytes (file read / markdown body)
 * -> write store -> normalize into the persisted record.
 *
 * The order is not arbitrary: **shape, then store, then IO**. Shape validation is cheapest and assembly-independent;
 * with the store absent a disk read is wasted work - worse, it would mask the real cause
 * (this assembly has no storage at all) behind an `ArtifactSourceMissing`.
 */
export async function executeArtifactPublish(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
): Promise<ArtifactVersionRecord> {
  assertArtifactId(request);
  const opts = artifactPublishOptions(request);
  const store = requireArtifactStore(deps, request);
  const payload =
    request.op === "file" ? await readFilePayload(deps, request, opts) : markdownPayload(request);
  const written = await writePayload(store, request, payload);
  return {
    id: request.id,
    kind: request.op,
    version: request.version,
    ...(opts.title === undefined ? {} : { title: opts.title }),
    ...(opts.description === undefined ? {} : { description: opts.description }),
    // contentType takes the **locally computed** value, not the store receipt: the extension table plus the
    // `opts.contentType` override decide it, and the UI switch-dispatches on this string; letting the store's
    // normalization (derived from the persisted filename) be authoritative would make a dispatch depend on the store
    // implementation.
    // bytes / uri come from the store receipt: that is the copy **actually persisted**, and the one read back later.
    bytes: written.bytes,
    uri: written.uri,
    ...(payload.kind === "binary" ? { sourcePath: payload.sourcePath } : {}),
    // The engine has no clock (pure core, replayable), so this side stamps the publish time. It is a required field.
    publishedAt: Date.now(),
  };
}

// ------------------------------- internal: shape validation -------------------------------

/** Validated `opts` (the facade's `ArtifactOptions` / `ArtifactFileOptions`). */
interface ArtifactPublishOptions {
  title?: string;
  description?: string;
  /** Only `file` reads it: markdown is always `text/markdown`. */
  contentType?: string;
}

/**
 * Runtime guard for artifact ids. Compile-time literal diagnostics (the analyzer) are the front gate and the engine
 * re-checks non-empty-string; the charset/length check lives here because **only this side uses the id as a key**: it
 * goes into the store `toolCallId` and ends up as part of the persisted file name. An invalid id here means something
 * bypassed compilation - a `DriverError`, not an `Artifact*` code, keeps those codes meaning exactly their one thing.
 */
function assertArtifactId(request: ArtifactPublishRequest): void {
  const { id } = request;
  if (id.length > ARTIFACT_CAPS.maxIdLength || !ARTIFACT_ID_PATTERN.test(id)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: id '${id}' is not a valid artifact id. Use at most ` +
        `${ARTIFACT_CAPS.maxIdLength} characters from [A-Za-z0-9_.-].`,
    );
  }
}

/**
 * Extract and validate the script's `opts`. Three rules, same lineage as {@link worldRunArgs}:
 *   1. Absent is legal (`opts?`); present must be an options object (not an array, not null).
 *   2. Known keys are type/length-checked, **never coerced** - a title turned into
 *      "undefined" by `String(undefined)` renders as an inexplicable string on the card instead of a fixable error.
 *   3. Unknown keys are silently ignored (the facade's type signature catches them at compile time; runtime errors
 *      would just move a compile-time problem to runtime). The `markdown` family therefore never reads `contentType`.
 */
function artifactPublishOptions(request: ArtifactPublishRequest): ArtifactPublishOptions {
  const raw = request.opts;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: opts must be an options object, got ${describeArg(raw)}. ` +
        `Pass an object or omit the argument.`,
    );
  }
  const bag = raw as { title?: unknown; description?: unknown; contentType?: unknown };
  const title = optionalText(request, "title", bag.title, ARTIFACT_CAPS.maxTitleLength);
  const description = optionalText(
    request,
    "description",
    bag.description,
    ARTIFACT_CAPS.maxDescriptionLength,
  );
  const contentType =
    request.op === "file" ? optionalContentType(request, bag.contentType) : undefined;
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

/** An optional bounded text option (title / description). Length counted in characters (UTF-16 code units). */
function optionalText(
  request: ArtifactPublishRequest,
  name: string,
  value: unknown,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: opts.${name} must be a string, got ${describeArg(value)}.`,
    );
  }
  if (value.length > max) {
    // Reject, don't truncate: a title with its second half chopped is a **normal-looking** bad deliverable, and
    // nothing on the card can show where it was cut.
    throw new WorkflowError(
      "ArtifactTooLarge",
      `artifact.${request.op}: opts.${name} is ${value.length} characters, over the cap of ` +
        `${max}. Shorten it.`,
    );
  }
  return value;
}

/**
 * The `opts.contentType` override. Must be a **bare** MIME without parameters (`type/subtype`): consumers
 * dispatch exactly on it (`text/markdown` -> markdown card, `application/pdf` -> pdf card); a
 * `text/markdown; charset=utf-8` would miss the branch entirely - type declared yet landing in the download card.
 */
function optionalContentType(request: ArtifactPublishRequest, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: opts.contentType must be a string, got ${describeArg(value)}.`,
    );
  }
  if (!CONTENT_TYPE_PATTERN.test(value)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: opts.contentType '${value}' is not a bare MIME type such as ` +
        `'application/pdf'. Drop any parameters ('; charset=...'); the viewer dispatches on ` +
        `the exact string.`,
    );
  }
  return value;
}

// ------------------------------- internal: fetching bytes -------------------------------

/** One pending store write. `file` writes binary, `markdown` writes text. */
type ArtifactPayload =
  | {
      readonly kind: "binary";
      readonly bytes: Uint8Array;
      readonly contentType: string;
      /** Extension for the persisted file name (the store re-derives the type from it on read, so it must survive). */
      readonly extension?: string;
      /** Workspace-relative original path (provenance + show-in-workspace). */
      readonly sourcePath: string;
    }
  | { readonly kind: "text"; readonly text: string; readonly contentType: "text/markdown" };

/**
 * `artifact.file(id, path, opts)`: resolve path -> read bytes (cap+1 probe) -> decide contentType.
 */
async function readFilePayload(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
  opts: ArtifactPublishOptions,
): Promise<ArtifactPayload> {
  const given = request.path;
  if (typeof given !== "string" || given === "") {
    // The engine verified payload is a string; an empty one means a wiring error.
    throw new WorkflowError(
      "DriverError",
      `artifact.file: path must be a non-empty string, got ${describeArg(given)}. Pass the ` +
        `workspace-relative path the subagent wrote.`,
    );
  }
  const { real, relative } = await resolveWorkspaceFile(deps, given);
  const bytes = await readCappedBytes(deps, given, real);
  const extension = fileExtension(real);
  return {
    kind: "binary",
    bytes,
    contentType:
      opts.contentType ??
      (extension === undefined ? undefined : EXTENSION_CONTENT_TYPES[extension]) ??
      // Not in the extension table = no guessing (no magic-byte sniffing). The UI then offers a download /
      // show-in-workspace card instead of rendering something it cannot parse.
      "application/octet-stream",
    ...(extension === undefined ? {} : { extension }),
    sourcePath: relative,
  };
}

/**
 * Resolve a script-supplied **workspace-relative** path into a readable real path, with a two-step containment check.
 *
 * First lexical ({@link resolveWithinWorkspace}, the same test as `files.read`); the second after realpath -
 * **symlinks are judged by the resolved real path**. The world-read
 * side deliberately checks lexically only (the bytes read are what the script itself sees; containment is the
 * script's own business), but this side cannot copy that: publishing **copies bytes into a durable store and puts
 * them in front of the user**, and one symlink would turn `~/.ssh/id_rsa` into a card. This recheck is where that
 * invariant lands on the write path.
 * `cwd` itself is realpathed too: on macOS `/tmp` is a symlink to `/private/tmp`; unnormalized, every workspace
 * file would be judged outside.
 */
async function resolveWorkspaceFile(
  deps: ArtifactPublishDeps,
  given: string,
): Promise<{ real: string; relative: string }> {
  const resolved = resolveWithinWorkspace(deps.cwd, given);
  if (resolved === undefined) throw outsideWorkspace(given);
  // Provenance keeps the **script-supplied path** (normalized), not the realpath: the card's show-in-workspace must
  // point where the user knows, not where the symlink lands.
  const relative = toWorkspaceRelative(deps.cwd, resolved);

  let realCwd: string;
  let real: string;
  try {
    realCwd = await realpath(deps.cwd);
  } catch (cause) {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: cannot resolve the workspace root '${deps.cwd}': ${errorText(cause)}`,
      { cause },
    );
  }
  try {
    real = await realpath(resolved);
  } catch (cause) {
    // ENOENT (including a missing middle segment) lands here: a missing path and a symlink to a missing target are
    // the same fact.
  }
  if (resolveWithinWorkspace(realCwd, real) === undefined) throw outsideWorkspace(given);
  return { real, relative };
}

/**
 * Read bytes with the **cap+1 probe**: the port's `maxBytes` means over-cap is `too_large`, never truncated, so
 * requesting cap+1 distinguishes exactly-cap (pass) from over-cap (reject) while reading at most one extra byte.
 * Same idiom as `files.grep` / `git.diff`.
 */
async function readCappedBytes(
  deps: ArtifactPublishDeps,
  given: string,
  path: string,
): Promise<Uint8Array> {
  const cap = ARTIFACT_CAPS.maxFileBytes;
  let result: FileSystemReadBytesResult;
  try {
    result = await deps.fileSystemPort.readBinaryFile({ path, maxBytes: cap + 1 });
  } catch (cause) {
    if (isFileSystemPortError(cause)) {
      if (cause.code === "too_large") throw tooLarge(given, cap);
      // not_found / is_directory / not_file all mean: no publishable regular file here.
      if (
        cause.code === "not_found" ||
        cause.code === "is_directory" ||
        cause.code === "not_file"
      ) {
        throw sourceMissing(given, cause);
      }
    }
    throw new WorkflowError(
      "DriverError",
      `artifact.file: failed to read '${given}': ${errorText(cause)}`,
      { cause },
    );
  }
  if (result.content.byteLength > cap) throw tooLarge(given, cap);
  return result.content;
}

/** `artifact.markdown(id, content, opts)`: the body counts bytes as UTF-8; over-cap rejects. */
function markdownPayload(request: ArtifactPublishRequest): ArtifactPayload {
  const content = request.content;
  if (typeof content !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.markdown: content must be a string, got ${describeArg(content)}.`,
    );
  }
  const bytes = Buffer.byteLength(content, "utf8");
  const cap = ARTIFACT_CAPS.maxMarkdownBytes;
  if (bytes > cap) {
    throw new WorkflowError(
      "ArtifactTooLarge",
      `artifact.markdown: content is ${bytes} bytes, over the cap of ${cap} bytes. Shorten ` +
        `it, or write the long content to a workspace file and publish it with artifact.file.`,
    );
  }
  return { kind: "text", text: content, contentType: "text/markdown" };
}

// ------------------------------- internal: store write -------------------------------

/** The confirmed publish destination: the store plus session scope (see {@link ArtifactPublishDeps}). */
interface ArtifactStoreTarget {
  readonly store: ToolArtifactStorePort;
  readonly sessionId: SessionId;
}

/**
 * Confirm this publish has a destination, else `ArtifactStoreUnavailable`. **Probed per op**: file needs binary
 * writes (`writeToolResultBinaryArtifact` is optional on the port), markdown only text. A text-only store can
 * therefore publish markdown but not files - and cannot-publish is a named refusal, not a PDF forced through the
 * text channel as UTF-8 (which silently destroys bytes).
 */
function requireArtifactStore(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
): ArtifactStoreTarget {
  const store = deps.artifactStore;
  if (store === undefined) {
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.${request.op}: cannot publish "${request.id}" because this assembly has no ` +
        `artifact store.`,
    );
  }
  if (request.op === "file" && store.writeToolResultBinaryArtifact === undefined) {
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.file: cannot publish "${request.id}" because this assembly's artifact store ` +
        `does not support binary writes.`,
    );
  }
  const sessionId = deps.parentSessionId;
  if (sessionId === undefined || sessionId === "") {
    // Store present but session id missing is a wiring error (they ship together in production). Same
    // code nonetheless: to the script it is the same fact - this publish has no destination.
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.${request.op}: cannot publish "${request.id}" because the artifact store has ` +
        `no session scope (parent session id not wired).`,
    );
  }
  return { store, sessionId };
}

/**
 * Write to the store. The four arguments, constrained:
 *   - `retention: project` - the artifact must outlive the session (the hub reads artifacts across sessions).
 *   - `toolName: CreateWorkflow` - the owning tool of the publish is the one that started this run.
 *   - `toolCallId: runId:siteId@ordinal` - one byte-set per version, and (run, site, ordinal) uniquely identifies
 *     one publish (the engine computes the version before dispatch; a rerun of the same version = same ordinal).
 *   - `sessionId` = the parent session.
 */
async function writePayload(
  target: ArtifactStoreTarget,
  request: ArtifactPublishRequest,
  payload: ArtifactPayload,
): Promise<ToolArtifactWriteResult> {
  const common = {
    sessionId: target.sessionId,
    toolCallId: `${request.runId}:${request.siteId}@${request.ordinal}`,
    toolName: ARTIFACT_TOOL_NAME,
    retention: "project" as const,
  };
  try {
    if (payload.kind === "text") {
      return await target.store.writeToolResultArtifact({
        ...common,
        content: payload.text,
        contentType: payload.contentType,
      });
    }
    /** Binary-write presence already probed in requireArtifactStore (the op === file branch). */
    const writeBinary = target.store.writeToolResultBinaryArtifact;
    if (writeBinary === undefined) {
      throw new WorkflowError(
        "ArtifactStoreUnavailable",
        `artifact.file: cannot publish "${request.id}" because this assembly's artifact store ` +
          `does not support binary writes.`,
      );
    }
    return await writeBinary.call(target.store, {
      ...common,
      content: payload.bytes,
      contentType: payload.contentType,
      // The extension rides along with the bytes: the store re-derives the type from the persisted
      // name, and a lost extension reads a .xlsx back as application/octet-stream.
      ...(payload.extension === undefined ? {} : { extension: payload.extension }),
    });
  } catch (cause) {
    if (cause instanceof WorkflowError) throw cause;
    // A write failure (disk full, permissions, the store's own error) is a **specific** failure,
    // not has-no-store, so ArtifactStoreUnavailable is not reused: carry the reason text so the
    // journal failure_json can say why.
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: writing "${request.id}" v${request.version} to the artifact ` +
        `store failed: ${errorText(cause)}`,
      { cause },
    );
  }
}

// ------------------------------- pure helpers -------------------------------

/** The owning tool name of artifacts in the store: a publish is the artifact of the CreateWorkflow call. */
const ARTIFACT_TOOL_NAME = "CreateWorkflow";

/**
 * Extension -> MIME. Anything unlisted is `application/octet-stream`: **no content sniffing**
 * (magic bytes add a second oracle, and two oracles eventually disagree).
 *
 * Why not reuse core's `inferAttachmentMimeFromPath`: that table serves **model input attachments**
 * and falls back to text/plain (feeding the model anything text-ish is what it wants). Here the consumer is the
 * UI dispatch, and the fallback must be don't-know-it-give-the-download-card - the correct fallback is the
 * opposite in the two places.
 */
const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Bare MIME (`type/subtype`, no parameters). Rationale at {@link optionalContentType}. */
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

/**
 * The file name's extension (lowercase, no dot). Only `[a-z0-9]+`: `archive.tar.gz` yields `gz`, while
 * `Makefile`, dotfiles like `.gitignore`, and `report.v2 final` have no extension.
 */
function fileExtension(path: string): string | undefined {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : undefined;
}

function outsideWorkspace(given: string): WorkflowError {
  return new WorkflowError(
    "ArtifactPathOutsideWorkspace",
    `artifact.file: path '${given}' resolves outside the workspace (symlinks are judged by ` +
      `their real path). Only files inside the workspace can be published.`,
  );
}

function sourceMissing(given: string, cause: unknown): WorkflowError {
  return new WorkflowError(
    "ArtifactSourceMissing",
    `artifact.file: '${given}' does not exist or is not a regular file. Confirm the subagent ` +
      `actually wrote it before publishing.`,
    { cause },
  );
}

function tooLarge(given: string, cap: number): WorkflowError {
  return new WorkflowError(
    "ArtifactTooLarge",
    `artifact.file: '${given}' is over the cap of ${cap} bytes. Publish a smaller artifact ` +
      `(a summary, a slice, or a compressed version).`,
  );
}

/** Short description of the argument shape (error messages only; never echoes full content). */
function describeArg(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** One-line text of anything thrown (for error messages). */
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
