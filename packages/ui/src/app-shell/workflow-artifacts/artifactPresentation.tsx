import type { ReactNode } from "react";
import { ChartLineIcon, FileIcon, GaugeIcon, SquareKanbanIcon, TableIcon } from "lucide-react";
import type { WorkflowRunArtifactKind } from "@zcode/shared/zcode-protocol-v4";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import type {
  ArtifactPresetKind,
  PresetLabels,
} from "@/app-shell/workflow-artifacts/presets/index.js";

/**
 * Presentation rules shared by user-facing artifacts across **several surfaces** (run side-panel
 * tile, completion-card tile, the `workflow-artifact` tab, notification-row pill, hub).
 *
 * Terminology: artifact here is what the script publishes to the user via `artifact.*`, not a
 * synonym for the engine-internal script top-level return value.
 *
 * One reason this module exists: **the same artifact must look identical in all four places**.
 * With icons or kind words written per surface, the notification chip and the tab it opens would
 * eventually point at the same thing with two different icons.
 */

/** The four preset-board members. Content members (file / markdown) carry bytes and versions; these do not. */
const PRESET_KINDS = new Set<WorkflowRunArtifactKind>(["chart", "table", "metrics", "board"]);

export function isArtifactPresetKind(kind: WorkflowRunArtifactKind): kind is ArtifactPresetKind {
  return PRESET_KINDS.has(kind);
}

/** Message id per kind word. One word for each of the six members (file / document / chart / table / metrics / board). */
export function artifactKindMessageId(kind: WorkflowRunArtifactKind): string {
  return `chat.toolCall.workflow.run.artifacts.kind.${kind}`;
}

const MARKDOWN_ICON = resolveFileDisplayDescriptor("artifact.md").fileIconSrc;
const KIND_ICON: Record<Exclude<WorkflowRunArtifactKind, "markdown">, typeof FileIcon> = {
  file: FileIcon,
  chart: ChartLineIcon,
  table: TableIcon,
  metrics: GaugeIcon,
  board: SquareKanbanIcon,
};

/**
 * Kind icon. The caller sets size via `className` (card size-4, chip size-3.5, tab header size-4) -
 * size belongs to each surface's density, the glyph does not.
 */
export function ArtifactKindIcon({
  kind,
  className,
}: {
  kind: WorkflowRunArtifactKind;
  className?: string;
}): ReactNode {
  if (kind === "markdown") {
    return <FileDisplayIcon src={MARKDOWN_ICON} className={className} />;
  }
  const Icon = KIND_ICON[kind];
  return <Icon aria-hidden="true" className={className} />;
}

/**
 * Byte-size formatting.
 *
 * Deliberately a local copy instead of importing the same-named helper from
 * `feedback/feedbackSubmissionJob.ts`: that is the feedback-upload job module, and dragging the
 * whole upload chain into app-shell's dependency graph for five lines of arithmetic is poor
 * economics. Should the two drift, nobody is harmed (one states file size, the other uploaded
 * volume).
 */
export function formatArtifactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Whether this contentType's body is **human-readable text** - the gate for the copy action.
 *
 * `application/json` is listed separately: IANA files it under application/, but what the script
 * hands over via `artifact.file("summary", "out/report.json")` is something the user wants to copy.
 * Distinct from the body dispatcher `textLanguageFor`: that picks the code viewer, this only
 * decides whether the whole body is copyable.
 */
export function isTextArtifactContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return contentType.startsWith("text/") || contentType === "application/json";
}

/** File type badge: the workspace path's extension wins (`out/book.pdf` -> PDF); without a path, fall back to the MIME subtype. */
export function artifactFileBadge(artifact: {
  sourcePath?: string;
  contentType?: string;
}): string | undefined {
  const extension = artifact.sourcePath?.match(/\.([a-z0-9]{1,5})$/iu)?.[1];
  if (extension !== undefined) return extension.toUpperCase();
  const subtype = artifact.contentType?.split("/")[1]?.split(";")[0]?.trim();
  if (subtype === undefined || subtype.length === 0) return undefined;
  const KNOWN: Record<string, string> = {
    "x-markdown": "MD",
    markdown: "MD",
    plain: "TXT",
    json: "JSON",
    csv: "CSV",
    html: "HTML",
    pdf: "PDF",
  };
  return KNOWN[subtype] ?? (subtype.length <= 5 ? subtype.toUpperCase() : undefined);
}

/**
 * The mono detail in pill / tile captions: file `PDF - 4.0 KB`, document size only, preset boards
 * the fed-in entry count (their size is data volume; absent when the count is unknown). Shared by
 * side-panel tile and completion card - written twice, one would state the badge and the other not.
 * null means the caller draws no detail slot.
 */
export function ArtifactDetail({
  artifact,
  labels,
}: {
  artifact: {
    kind: WorkflowRunArtifactKind;
    bytes?: number;
    itemCount?: number;
    sourcePath?: string;
    contentType?: string;
  };
  labels: PresetLabels;
}): ReactNode {
  if (isArtifactPresetKind(artifact.kind)) {
    return artifact.itemCount === undefined ? null : (
      <span data-testid="workflow-run-artifact-items">{labels.itemsCount(artifact.itemCount)}</span>
    );
  }
  if (artifact.bytes === undefined) return null;
  const badge = artifact.kind === "file" ? artifactFileBadge(artifact) : undefined;
  return (
    <>
      {badge === undefined ? null : (
        <>
          <span data-testid="workflow-run-artifact-badge">{badge}</span>
          <span aria-hidden>·</span>
        </>
      )}
      <span data-testid="workflow-run-artifact-bytes">{formatArtifactBytes(artifact.bytes)}</span>
    </>
  );
}

/**
 * Plain-text form of the caption detail (`PDF - 4.0 KB` / `4 items`): mini tiles move it into the
 * tooltip, the deliverable row puts it on the kind-size line. Same rules as `ArtifactDetail`, minus
 * the testid.
 */
export function artifactDetailText(
  artifact: {
    kind: WorkflowRunArtifactKind;
    bytes?: number;
    itemCount?: number;
    sourcePath?: string;
    contentType?: string;
  },
  labels: PresetLabels,
): string | undefined {
  if (isArtifactPresetKind(artifact.kind)) {
    return artifact.itemCount === undefined ? undefined : labels.itemsCount(artifact.itemCount);
  }
  if (artifact.bytes === undefined) return undefined;
  const badge = artifact.kind === "file" ? artifactFileBadge(artifact) : undefined;
  const size = formatArtifactBytes(artifact.bytes);
  return badge === undefined ? size : `${badge} · ${size}`;
}

/**
 * The deliverable: the entry flagged `primary`; with no flag and exactly one entry, that entry is
 * it - the **single-item rule is a UI-only convention**; protocol and engine never infer the flag.
 * Otherwise there is no deliverable: a failed primary is not substituted by another artifact, and
 * multiple unflagged entries render as today.
 */
export function resolvePrimaryArtifact<T extends { primary?: true }>(
  artifacts: readonly T[],
): T | undefined {
  const flagged = artifacts.find((artifact) => artifact.primary === true);
  if (flagged !== undefined) return flagged;
  return artifacts.length === 1 ? artifacts[0] : undefined;
}

/**
 * Deliverable first, the rest in original order. The CLI's three projections (journal -> port,
 * notification list, GetWorkflowRun) already order this way; this is the **live-projection path's**
 * (`workflowRuns[].artifacts` upsert in publication order) only sorting point.
 */
export function orderArtifactsPrimaryFirst<T extends { primary?: true }>(
  artifacts: readonly T[],
): T[] {
  const index = artifacts.findIndex((artifact) => artifact.primary === true);
  if (index <= 0) return [...artifacts];
  return [artifacts[index]!, ...artifacts.slice(0, index), ...artifacts.slice(index + 1)];
}

/** Card title: the author's title wins; fall back to the id (the facade's default title is the id anyway). */
export function artifactDisplayTitle(artifact: { id: string; title?: string }): string {
  return artifact.title?.trim() || artifact.id;
}

/** Title truncation length on chips. */
const ARTIFACT_CHIP_TITLE_MAX_LENGTH = 24;

/** Max chips per notification / hub row; the rest collapse into +N. */
export const ARTIFACT_CHIP_MAX_VISIBLE = 3;

export function truncateArtifactChipTitle(title: string): string {
  return title.length > ARTIFACT_CHIP_TITLE_MAX_LENGTH
    ? `${title.slice(0, ARTIFACT_CHIP_TITLE_MAX_LENGTH)}…`
    : title;
}

/**
 * The three strings fed to the preset renderers. Renderers never touch i18n themselves (they must
 * stay reusable across side panel / tab / hub), so each surface builds them in its own intl context.
 */
export function buildPresetLabels(
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
): PresetLabels {
  return {
    otherColumn: formatMessage({
      id: "chat.toolCall.workflow.run.artifacts.preset.otherColumn",
    }),
    empty: formatMessage({ id: "chat.toolCall.workflow.run.artifacts.preset.empty" }),
    itemsCount: (count: number) =>
      formatMessage(
        { id: "chat.toolCall.workflow.run.artifacts.preset.items" },
        { count: String(count) },
      ),
  };
}

/**
 * Whether the artifact can be located on the **local filesystem** (gates reveal-in-workspace and
 * html's open-in-browser).
 *
 * Same criteria as `shouldOpenAssistantHtmlInBrowser`: remote workspaces (SSH / WSL / Docker) have
 * no local path, and phone remote control has no file tree to jump to. Without `sourcePath` there is
 * no path at all - markdown artifacts and preset boards have no provenance by construction.
 */
export function canRevealArtifactInWorkspace(params: {
  sourcePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}): boolean {
  return (
    Boolean(params.sourcePath?.trim()) &&
    !params.workspaceIdentity?.trim() &&
    !params.remoteSessionId
  );
}

/**
 * File name for the open-as-file copy. `markdown` is always `<id>.md` (id limited to [A-Za-z0-9_.-]);
 * `file` uses this version's `sourcePath` basename, the extension decides which app the OS opens, and
 * different versions of one id may come from different paths. Falls back to the id when provenance is missing.
 */
export function artifactOpenAsFileName(
  artifact: {
    id: string;
    kind: WorkflowRunArtifactKind;
    version: number;
    sourcePath?: string;
    versions?: readonly { version: number; sourcePath?: string }[];
  },
  version: number,
): string {
  if (artifact.kind === "markdown") return `${artifact.id}.md`;
  const sourcePath =
    artifact.versions?.find((entry) => entry.version === version)?.sourcePath ??
    (version === artifact.version ? artifact.sourcePath : undefined);
  const leaf = sourcePath?.split(/[\\/]/u).at(-1)?.trim();
  return leaf ? leaf : artifact.id;
}
