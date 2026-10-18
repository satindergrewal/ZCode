import { useMemo } from "react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import {
  artifactFileBadge,
  buildPresetLabels,
  isArtifactPresetKind,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { ArtifactPresetBody } from "@/app-shell/workflow-artifacts/ArtifactPresetBody.js";
import { artifactPresetFieldPaths } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";
import {
  ArtifactSheetGlyph,
  type WorkflowCompletionArtifact,
} from "@/components/workflow-timeline/WorkflowArtifactTile.js";
import { useWorkflowRunArtifactBytes } from "@/hooks/useWorkflowRunArtifactBytes.js";
import { useWorkflowRunArtifactData } from "@/hooks/useWorkflowRunArtifactData.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { Theme } from "@/useTheme.js";

/**
 * The artifact tile's preview area (shared with the side pane gallery): a thumbnail of the artifact ITSELF.
 *
 * - markdown / plain text: the document head laid out at 2x width then scale(0.5), a thumbnail of the content,
 *   not a smaller UI font;
 * - CSV: a mini table of the first rows;
 * - image: the render itself;
 * - chart / table / metrics / board: ArtifactPresetBody compact, centered at natural size, growing live with the report entry;
 * - everything else (PDF / binary / huge files): page glyph plus extension badge.
 *
 * Both frames share one size class and one rendering: the deliverable-row frame (160x100) and the gallery
 * tile (130-180px column). No smaller class, a preview is either legible or not drawn.
 *
 * Until bytes arrive the block stays blank (no skeleton flash, no glyph swapped out later). Bytes ride the
 * same chunked read as the artifact tab (journal-backed, cold restore included); beyond the cap they are not
 * fetched, a transcript card must not pull the whole chain for a 20 MiB artifact.
 */
const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
const IMAGE_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
/** Document thumbnails decode only this many leading bytes: one screen of thumbnail is the budget, decoding all is waste. */
const TEXT_DECODE_BYTES = 8 * 1024;
const TEXT_PREVIEW_CHARS = 1_600;
const CSV_PREVIEW_ROWS = 6;
const CSV_PREVIEW_COLUMNS = 5;
const CSV_CELL_MAX_CHARS = 28;

type PreviewMode = "markdown" | "csv" | "text" | "image";

export function previewModeFor(artifact: {
  kind: WorkflowCompletionArtifact["kind"];
  contentType?: string;
  bytes?: number;
}): PreviewMode | undefined {
  const contentType = artifact.contentType?.split(";")[0]?.trim() ?? "";
  const bytes = artifact.bytes;
  if (artifact.kind === "markdown" || contentType === "text/markdown") {
    return bytes !== undefined && bytes > TEXT_PREVIEW_MAX_BYTES ? undefined : "markdown";
  }
  if (contentType.startsWith("image/")) {
    return bytes !== undefined && bytes > IMAGE_PREVIEW_MAX_BYTES ? undefined : "image";
  }
  if (bytes !== undefined && bytes > TEXT_PREVIEW_MAX_BYTES) return undefined;
  if (contentType === "text/csv") return "csv";
  if (contentType === "text/plain" || contentType === "application/json") return "text";
  return undefined;
}

/** Minimal CSV reading: commas and paired quotes only, enough for a thumbnail; not a parser. */
export function csvPreviewRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) {
        cells.push(cell);
        cell = "";
      } else cell += char;
    }
    cells.push(cell);
    rows.push(
      cells.slice(0, CSV_PREVIEW_COLUMNS).map((value) => {
        const trimmed = value.trim();
        return trimmed.length > CSV_CELL_MAX_CHARS
          ? `${trimmed.slice(0, CSV_CELL_MAX_CHARS)}…`
          : trimmed;
      }),
    );
    if (rows.length >= CSV_PREVIEW_ROWS) break;
  }
  return rows;
}

function decodeHead(bytes: Uint8Array): string {
  return new TextDecoder()
    .decode(bytes.subarray(0, TEXT_DECODE_BYTES))
    .slice(0, TEXT_PREVIEW_CHARS);
}

/** Blank placeholder: bytes in flight. Tests and callers distinguish not-yet from cannot-render by it. */
function Pending() {
  return <span className="absolute inset-0" data-testid="workflow-artifact-preview-pending" />;
}

/** Document thumbnails fade into the panel color at the bottom: truncated reads as more below, not cut off. Boards and images skip it. */
function Fade() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[28%]"
      style={{ background: "linear-gradient(to bottom, transparent, var(--color-panel))" }}
    />
  );
}

export function WorkflowArtifactTilePreview({
  artifact,
  runId,
  sessionId,
  theme,
}: {
  artifact: WorkflowCompletionArtifact;
  sessionId: string;
  runId: string;
  theme: Theme;
}) {
  const { intl } = useZCodeIntl();
  const preset = isArtifactPresetKind(artifact.kind);
  const mode = preset ? undefined : previewModeFor(artifact);
  const bytesState = useWorkflowRunArtifactBytes({
    sessionId,
    runId,
    artifactId: artifact.id,
    version: artifact.version ?? 1,
    enabled: mode !== undefined,
  });
  // Boards fetch only the fields the spec names; skip until the spec arrives and renders, the preview has no chart before then.
  const fields = useMemo(
    () =>
      isArtifactPresetKind(artifact.kind)
        ? artifactPresetFieldPaths(artifact.kind, artifact.spec)
        : undefined,
    [artifact.kind, artifact.spec],
  );
  const dataState = useWorkflowRunArtifactData({
    sessionId,
    runId,
    artifactId: artifact.id,
    ...(artifact.itemCount === undefined ? {} : { itemCount: artifact.itemCount }),
    enabled: fields !== undefined,
    ...(fields === undefined ? {} : { fields }),
  });
  const labels = useMemo(
    () => buildPresetLabels((descriptor, values) => intl.formatMessage(descriptor, values)),
    [intl],
  );
  const text = useMemo(
    () =>
      bytesState.bytes !== null && (mode === "markdown" || mode === "csv" || mode === "text")
        ? decodeHead(bytesState.bytes)
        : undefined,
    [bytesState.bytes, mode],
  );
  const rows = useMemo(
    () => (mode === "csv" && text !== undefined ? csvPreviewRows(text) : []),
    [mode, text],
  );

  const badge = artifact.kind === "file" ? artifactFileBadge(artifact) : undefined;
  const glyph = <ArtifactSheetGlyph {...(badge === undefined ? {} : { badge })} />;

  if (preset) {
    // Only the journal carries the spec; stay blank until it lands, no unrenderable flash. Speak up only when it arrived broken.
    if (artifact.spec === undefined) return <Pending />;
    return (
      <div
        className="absolute inset-0 flex flex-col overflow-hidden p-2.5 [justify-content:safe_center]"
        data-preview-mode="preset"
        data-testid="workflow-artifact-preview-body"
      >
        <ArtifactPresetBody
          artifact={{ kind: artifact.kind, spec: artifact.spec }}
          compact
          invalidLabel={intl.formatMessage({
            id: "chat.toolCall.workflow.run.artifacts.presetInvalid",
          })}
          items={dataState.items}
          labels={labels}
        />
      </div>
    );
  }

  if (mode === undefined) return glyph;
  if (bytesState.loading || (bytesState.bytes === null && bytesState.error === null)) {
    return <Pending />;
  }
  if (bytesState.error !== null) return glyph;

  if (mode === "image") {
    return bytesState.objectUrl === null ? (
      glyph
    ) : (
      <img
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        data-preview-mode="image"
        data-testid="workflow-artifact-preview-body"
        src={bytesState.objectUrl}
      />
    );
  }

  if (mode === "csv") {
    return (
      <>
        <div
          className="wf-preview-doc"
          data-preview-mode="csv"
          data-testid="workflow-artifact-preview-body"
        >
          <table className="w-full border-collapse font-mono text-ui-caption tabular-nums">
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td
                      className={cn(
                        "whitespace-nowrap border-b py-1.5 pr-3 text-foreground",
                        rowIndex === 0
                          ? "border-border font-sans text-ui-sm font-medium uppercase tracking-wide text-foreground-subtlest"
                          : "border-[var(--color-workflow-rule)]",
                      )}
                      key={cellIndex}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Fade />
      </>
    );
  }

  return (
    <>
      <div
        className="wf-preview-doc"
        data-preview-mode={mode}
        data-testid="workflow-artifact-preview-body"
      >
        {mode === "markdown" ? (
          // markdown must receive theme (the renderer picks code block colors from it).
          <MessageResponse className="w-full min-w-0 break-words text-foreground" theme={theme}>
            {text ?? ""}
          </MessageResponse>
        ) : (
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-ui-caption text-foreground">
            {text ?? ""}
          </pre>
        )}
      </div>
      <Fade />
    </>
  );
}
