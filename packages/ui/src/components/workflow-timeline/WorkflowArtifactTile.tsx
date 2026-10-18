import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import {
  ArtifactKindIcon,
  artifactDisplayTitle,
  artifactKindMessageId,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ArtifactPillData } from "./WorkflowArtifactPill.js";

/**
 * Artifact tile: one artifact = preview area + caption row.
 * The caption keeps the artifact-pill grammar (square kind tile, title, mono meta,
 * version tail slot, hover-to-↗ swap); the preview is the artifact **itself**, miniature —
 * a scaled doc rendering, the CSV's first rows, the board itself — handed in by the caller
 * per kind, or a quiet page glyph when it cannot (PDF/binary/bytes not yet here).
 *
 * The pill is the artifact in a row; the tile is the artifact with room. One remaining
 * caller: the run side panel's gallery when there is **no deliverable** (130-180px
 * column, legible). With a deliverable, everything else goes to index rows
 * (`WorkflowArtifactIndex`) — a preview renders only if legible; the old "mini tiles"
 * (six-across thumbnails) died for illegibility.
 *
 * Terminology: artifact = an output the script published to the user via `artifact.*`.
 *
 * The whole tile is always one `<button>`: without a callback it is a **disabled** one
 * (what was delivered is fact; openability is capability) — the pill's same gate.
 *
 * The preview used to be a child of the button, but markdown thumbnails carry their own
 * controls (a table's Copy Markdown, file links) nesting button in button — a React DOM
 * nesting error. Now the preview is a **sibling** marked `inert` (a thumbnail: no
 * interaction, no a11y tree); the button wraps only the caption, and a tile-filling
 * `::after` (`.wf-tile-hit`) takes the click/hover/focus. The hover lift is driven by
 * `.wf-tile:has(.wf-tile-hit:hover)`.
 */
export interface WorkflowCompletionArtifact extends ArtifactPillData {
  contentType?: string;
  bytes?: number;
  sourcePath?: string;
  /** Item count the hydrated board fed in; absent from the notification payload until the live projection/journal backfills. */
  itemCount?: number;
  /** The hydrated board's spec (only the journal carries it); the preview renders from it. */
  spec?: unknown;
  /** The author's one-liner; only the deliverable row speaks it (no room on the tile). */
  description?: string;
  /** The run's deliverable. */
  primary?: true;
}

/** Page glyph for unavailable content: a small sheet + corner extension badge. Honest, not decorative. */
export function ArtifactSheetGlyph({ badge }: { badge?: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center" data-testid="workflow-artifact-sheet">
      <div className="flex aspect-[3/4] w-[38%] max-w-[72px] flex-col gap-1.5 rounded-[4px] border border-border bg-card p-2.5 shadow-[0_1px_0_var(--color-workflow-rule)]">
        <i className="block h-[5px] w-[55%] rounded-sm bg-surface-hover" />
        <i className="block h-[3px] rounded-sm bg-surface-hover" />
        <i className="block h-[3px] rounded-sm bg-surface-hover" />
        <i className="block h-[3px] w-[70%] rounded-sm bg-surface-hover" />
      </div>
      {badge === undefined ? null : (
        <span
          className="absolute bottom-2 right-2 rounded-[4px] bg-surface-hover px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle"
          data-testid="workflow-artifact-sheet-badge"
        >
          {badge}
        </span>
      )}
    </div>
  );
}

export function WorkflowArtifactTile({
  artifact,
  detail,
  enterDelayMs,
  onOpen,
  preview,
  testId = "workflow-artifact-tile",
  title: tooltip,
}: {
  artifact: WorkflowCompletionArtifact;
  /** Preview content; absent means the page glyph. */
  preview?: ReactNode;
  /** Mono meta between name and tail slot (`CSV - 6 KB` / `4 items`). */
  detail?: ReactNode;
  onOpen?: (artifactId: string) => void;
  enterDelayMs?: number;
  testId?: string;
  /** Tooltip override (the side panel adds workspace provenance); default is "kind - title". */
  title?: string;
}) {
  const { intl } = useZCodeIntl();
  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;
  const style: CSSProperties | undefined =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? undefined
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };

  return (
    <div className="wf-tile relative flex min-w-0 flex-col gap-1.5" data-variant="tile">
      {/* Preview frame: the bottom fade is the content's call (doc thumbnails hint more-below; boards and images do not). */}
      <div
        aria-hidden
        className="wf-tile-frame wf-arrive relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-border bg-panel"
        data-testid="workflow-artifact-tile-frame"
        inert
        style={style}
      >
        {preview ?? <ArtifactSheetGlyph />}
      </div>
      <button
        aria-label={
          openable
            ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${title}`
            : undefined
        }
        className={cn(
          "wf-tile-hit wf-arrive flex min-w-0 items-center gap-1.5 rounded-lg bg-transparent p-0 px-0.5 text-left text-ui-sm outline-none",
          openable ? "wf-tile-open cursor-pointer" : "cursor-default",
        )}
        data-artifact-id={artifact.id}
        data-artifact-kind={artifact.kind}
        data-artifact-open={openable ? "true" : undefined}
        data-artifact-version={String(version)}
        data-testid={testId}
        data-variant="tile"
        disabled={!openable}
        onClick={openable ? () => onOpen(artifact.id) : undefined}
        style={style}
        title={tooltip ?? `${kindLabel} · ${title}`}
        type="button"
      >
        <ArtifactKindIcon className="size-4 shrink-0 text-foreground-subtle" kind={artifact.kind} />
        <span className="wf-pill-name min-w-0 flex-1 truncate text-foreground">{title}</span>
        {detail === undefined || detail === null ? null : (
          <span
            className="flex shrink-0 items-center gap-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
            data-testid="workflow-artifact-tile-detail"
          >
            {detail}
          </span>
        )}
        {showVersion || openable ? (
          <span className="grid size-3 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
            {showVersion ? (
              // Remount by version: a re-publish under the same id plays the tail-slot pop once (wf-mark enter), ceding to the arrow on hover.
              <span
                className="wf-mark font-mono text-ui-xs leading-none tabular-nums text-foreground-subtlest"
                data-testid="workflow-artifact-tile-version"
                key={version}
                title={intl.formatMessage(
                  { id: "chat.toolCall.workflow.run.artifacts.version" },
                  { version: String(version) },
                )}
              >
                {intl.formatMessage(
                  { id: "chat.toolCall.workflow.run.artifacts.versionTail" },
                  { version: String(version) },
                )}
              </span>
            ) : null}
            {openable ? (
              <span
                aria-hidden
                className="wf-pill-go flex items-center justify-center text-foreground-subtlest"
                data-testid="workflow-artifact-tile-open"
              >
                <ArrowUpRightIcon className="size-3" />
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
    </div>
  );
}
