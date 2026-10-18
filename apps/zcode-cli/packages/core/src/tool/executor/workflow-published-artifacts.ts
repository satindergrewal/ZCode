/**
 * The model-side projection of a workflow run's **user-facing artifacts**, shared by three sites:
 * the completion notification's `<artifacts>` section (background-tasks.ts), the manifest payload's
 * `artifacts[]` (same), and the `GetWorkflowRun` model-text `<artifacts>` section (handlers/get-workflow-run.ts).
 *
 * Terminology: an artifact here is what the script **published to the user via `artifact.*`** -- a file, a
 * markdown doc, or an image/chart/metric/dashboard fed by tagged `report`s. It is a **different thing** from
 * `serializeWorkflowArtifact` next door (workflow-artifact.ts): that one is the script's top-level return
 * (engine-internal `RunSettlement.artifact`), for the model.
 * Both appear in the completion notification (`<result>` and `<artifacts>`), hence the separate file.
 *
 * One line format, written once: all three readers are the same model; divergent formats make it think the
 * notification artifact and the GetWorkflowRun artifact are two systems.
 */

/** Everything the model side needs about one artifact. The three inputs differ; this is their intersection. */
interface PublishedArtifactSummary {
  id: string;
  kind: string;
  version: number;
  title?: string;
  contentType?: string;
  /** Byte size of a content artifact's (file/markdown) latest version. Preset dashboards have no bytes. */
  bytes?: number;
  /** Tagged `report` count a preset dashboard received (data volume). Always 0 for content artifacts. */
  itemCount?: number;
  /** The run's deliverable: heads the list, flagged `primary` on the row. */
  primary?: true;
  /** Only the deliverable's description enters the manifest: the completed card renders it as a captioned row. */
  description?: string;
}

/** Bound for the manifest deliverable `description` (`ARTIFACT_CAPS.maxDescriptionLength`, same value as shared zod). */
const WORKFLOW_ARTIFACT_DESCRIPTION_MAX_CHARS = 500;

/**
 * Deliverable first, rest in original order (stable). All three lists pass here before truncating, so the cap
 * cannot cut the deliverable. The port's `artifactsOf` already sorts; sorting again covers the snapshot and
 notification paths (they read the projection's order).
function primaryFirst<T extends { primary?: true }>(artifacts: readonly T[]): T[] {
  return [...artifacts].sort(
    (left, right) => Number(right.primary === true) - Number(left.primary === true),
  );
}

/** Max rows listed in the completion notification's `<artifacts>`. Payload cap (<=8) equals the text row cap by design. */
export const WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES = 8;
/** `GetWorkflowRun` `<artifacts>` section cap (bounded 32 = ARTIFACT_CAPS per-run max). */
export const WORKFLOW_ARTIFACTS_INTROSPECTION_MAX_LINES = 32;
/** Manifest `title` bound (`ARTIFACT_CAPS.maxTitleLength`, same value as shared zod). */
const WORKFLOW_ARTIFACT_TITLE_MAX_CHARS = 120;
/** `id` bound (`ARTIFACT_CAPS.maxIdLength`, same value as shared zod). */
const WORKFLOW_ARTIFACT_ID_MAX_CHARS = 64;
/** `contentType` bound (same as shared zod; no legal MIME is this long). */
const WORKFLOW_ARTIFACT_CONTENT_TYPE_MAX_CHARS = 255;

/** The four preset dashboard kinds: no bytes; data volume is the tagged-report count. */
const PRESET_ARTIFACT_KINDS: ReadonlySet<string> = new Set(["chart", "table", "metrics", "board"]);

/**
 * One artifact -> one line: `- {id} ({kind}, v{version}, {contentType}, {bytes} bytes): {title}`.
 *
 * Absent parts are omitted whole, not left blank -- `(file, v2, , : )` reads like corrupt data. Preset
 * dashboards render `{n} items` instead of bytes: an image's "size" is its datapoint count; bytes are
 meaningless to it (it has none).
 *
 * Deliberately **no `uri`**: the model cannot read the tool-artifact store. For content, use GetWorkflowRun
 or send a subagent to the workspace path.
 */
export function formatPublishedArtifactLine(artifact: PublishedArtifactSummary): string {
  // `primary` follows kind: `- report (markdown, primary, v2, ...)` -- the model learns which item to hand over first.
  const parts = artifact.primary === true ? [artifact.kind, "primary"] : [artifact.kind];
  parts.push(`v${artifact.version}`);
  if (artifact.contentType !== undefined && artifact.contentType.length > 0) {
    parts.push(artifact.contentType);
  }
  if (PRESET_ARTIFACT_KINDS.has(artifact.kind)) {
    if (artifact.itemCount !== undefined) {
      parts.push(`${artifact.itemCount} item${artifact.itemCount === 1 ? "" : "s"}`);
    }
  } else if (artifact.bytes !== undefined) {
    parts.push(`${artifact.bytes} bytes`);
  }
  const head = `- ${artifact.id} (${parts.join(", ")})`;
  const title = artifact.title?.trim();
  return title === undefined || title.length === 0 ? head : `${head}: ${title}`;
}

/** The three things an `<artifacts count shown>` section needs; same shape as the `<reports>` one. */
interface WorkflowArtifactsNotificationSection {
  /** **True total count** (not the listed row count). */
  count: number;
  /** Rows actually listed; count > shown means the list is partial. */
  shown: number;
  preview: string;
}

/**
 * Artifact list -> the completion notification / `GetWorkflowRun` `<artifacts>` section.
 *
 * Same rule as `<reports>`: `count` is always the true total; count != shown signals a partial list with the
 full set reachable via run id. Returns `undefined` for zero items so the caller omits the whole section.
 */
export function buildWorkflowArtifactsNotificationSection(
  artifacts: readonly PublishedArtifactSummary[] | undefined,
  maxLines: number,
): WorkflowArtifactsNotificationSection | undefined {
  if (artifacts === undefined || artifacts.length === 0) return undefined;
  const lines = primaryFirst(artifacts).slice(0, maxLines).map(formatPublishedArtifactLine);
  return { count: artifacts.length, shown: lines.length, preview: lines.join("\n") };
}

/** One entry of the manifest payload (`WorkflowNotificationMeta.artifacts`). shared zod uses the same bounds. */
interface WorkflowArtifactManifestEntry {
  id: string;
  kind: "file" | "markdown" | "chart" | "table" | "metrics" | "board";
  title?: string;
  version: number;
  contentType?: string;
  primary?: true;
  /** Only on `primary` entries (the completed card's deliverable row reads it; chips have no room nor need). */
  description?: string;
}

/**
 * The manifest payload's `artifacts` and `artifactsTruncated`.
 *
 * Same source as the section above, different shape: the GUI renders each entry as a chip (icon + truncated
 * title), so the payload carries structured fields, not a joined line; `bytes`/`itemCount` are deliberately
 * excluded -- no room on a chip, the side panel shows all. Truncation happens **before construction**: the
 payload rides the turnHeader row; over-bounds fail zod at persistence.
 * Entries whose `kind` is outside the six literals are dropped whole (no guessing, no normalizing): a chip
 * with unknown kind has no icon, and letting it through would fail zod for the whole payload, chips included.
 *
 * Returns `undefined` for zero items so both fields go absent together.
 */
export function buildWorkflowArtifactsManifestSection(
  artifacts: readonly PublishedArtifactSummary[] | undefined,
): { artifacts: WorkflowArtifactManifestEntry[]; artifactsTruncated?: true } | undefined {
  if (artifacts === undefined || artifacts.length === 0) return undefined;
  const entries: WorkflowArtifactManifestEntry[] = [];
  // Deliverable enters the list first: the cap of 8 can never cut it.
  for (const artifact of primaryFirst(artifacts)) {
    if (entries.length >= WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES) break;
    const kind = manifestArtifactKind(artifact.kind);
    // id is the chip identity key; truncating would fabricate a nonexistent artifact -- over-bounds drop the
    // entry, same rule as unknown kind. Both keep one bad row from taking the other chips down via zod.
    if (kind === undefined || artifact.id.length === 0) continue;
    if (artifact.id.length > WORKFLOW_ARTIFACT_ID_MAX_CHARS) continue;
    // version is a chip locator; shared zod demands a positive integer -- non-positive drops the entry too.
    if (!Number.isInteger(artifact.version) || artifact.version < 1) continue;
    const title = artifact.title?.trim();
    // contentType is chip decoration; over-bound drops this key, not the entry.
    const contentType =
      artifact.contentType !== undefined &&
      artifact.contentType.length <= WORKFLOW_ARTIFACT_CONTENT_TYPE_MAX_CHARS
        ? artifact.contentType
        : undefined;
    const description = artifact.primary === true ? artifact.description?.trim() : undefined;
    entries.push({
      id: artifact.id,
      kind,
      ...(title === undefined || title.length === 0
        ? {}
        : { title: title.slice(0, WORKFLOW_ARTIFACT_TITLE_MAX_CHARS) }),
      version: artifact.version,
      ...(contentType === undefined ? {} : { contentType }),
      ...(artifact.primary === true ? { primary: true as const } : {}),
      ...(description === undefined || description.length === 0
        ? {}
        : { description: description.slice(0, WORKFLOW_ARTIFACT_DESCRIPTION_MAX_CHARS) }),
    });
  }
  if (entries.length === 0) return undefined;
  // Honest truncation: cap-cut and kind-filtered items both mean "more exists than drawn" -- so the criterion
  // is "drawn < total", never "the cap was hit".
  const truncated = entries.length < artifacts.length;
  return { artifacts: entries, ...(truncated ? { artifactsTruncated: true as const } : {}) };
}

const MANIFEST_ARTIFACT_KINDS: readonly WorkflowArtifactManifestEntry["kind"][] = [
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
];

function manifestArtifactKind(kind: string): WorkflowArtifactManifestEntry["kind"] | undefined {
  return MANIFEST_ARTIFACT_KINDS.find((known) => known === kind);
}

/**
 * Snapshot/port-detail artifact -> this module's input shape. `bytes` exists only per version (the port's
 top level deliberately omits it), so take it from the **latest version** -- the one the list describes.
 *
 * Shape is still checked defensively: input crosses packages (port impls, or a cold-recovered row); one bad
 * entry must not vanish the whole section. Malformed entries are skipped whole.
 */
export function toPublishedArtifactSummaries(
  value: unknown,
): PublishedArtifactSummary[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const summaries: PublishedArtifactSummary[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    const kind = typeof record.kind === "string" ? record.kind : undefined;
    const version = typeof record.version === "number" ? record.version : undefined;
    if (id === undefined || kind === undefined || version === undefined) continue;
    const versions = Array.isArray(record.versions) ? record.versions : undefined;
    const latest = versions?.[versions.length - 1];
    const bytes =
      latest !== null &&
      typeof latest === "object" &&
      typeof (latest as Record<string, unknown>).bytes === "number"
        ? ((latest as Record<string, unknown>).bytes as number)
        : undefined;
    summaries.push({
      id,
      kind,
      version,
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      ...(typeof record.contentType === "string" ? { contentType: record.contentType } : {}),
      ...(bytes === undefined ? {} : { bytes }),
      ...(typeof record.itemCount === "number" ? { itemCount: record.itemCount } : {}),
      ...(record.primary === true ? { primary: true as const } : {}),
      ...(typeof record.description === "string" ? { description: record.description } : {}),
    });
  }
  return summaries.length === 0 ? undefined : summaries;
}
