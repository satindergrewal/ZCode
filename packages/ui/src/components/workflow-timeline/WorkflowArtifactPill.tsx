import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import type { WorkflowRunArtifactKind } from "@zcode/shared/zcode-protocol-v4";
import {
  ArtifactKindIcon,
  artifactDisplayTitle,
  artifactKindMessageId,
  truncateArtifactChipTitle,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Artifact pill: the same grammar as the subagent pill —
 * same height, radius, surface, hover lift, ↗ replacing the tail content — with two changes: a **square** ink-gray tile instead of a **round**
 * tinted avatar (color says who, shape says what), and the version number in the tail instead of a status mark.
 *
 * ⚠ Terminology: artifact here means output the script published to the user via `artifact.*`, not the engine's "script top-level return value" homonym.
 *
 * Two sizes: `md` (32px) where pills already live — the artifact strip under the timeline, the hub's "recent artifacts";
 * `sm` (24px) inline — the folded header of the completion notice, the hub's run-history rows. Where an artifact **has room** (completion card,
 * run side panel gallery) it is a tile (`WorkflowArtifactTile`); this row is the pill grammar of the same thing.
 *
 * Always a `<button>`: an artifact is "something openable"; without a host callback it is a **disabled** button, as quiet as
 * a session-less subagent pill — "what was delivered" is fact, "can it open" is capability. The version number appears from v2
 * on (v1 is the norm; writing it is noise); on re-publish under the same id the tail remounts by version, playing the mark's pop-in.
 */
export interface ArtifactPillData {
  id: string;
  kind: WorkflowRunArtifactKind;
  title?: string;
  version?: number;
}

export type ArtifactPillSize = "md" | "sm";

export function WorkflowArtifactPill({
  artifact,
  className,
  detail,
  enterDelayMs,
  fill = false,
  onOpen,
  size = "md",
  testId = "workflow-artifact-pill",
  title,
  truncateTitle = false,
  variant = "pill",
}: {
  variant?: "pill" | "link";
  artifact: ArtifactPillData;
  size?: ArtifactPillSize;
  //** Monospace aux info between name and tail (the sidebar row's `PDF · 1.2 MB` / `12 items`). */
  detail?: ReactNode;
  //** Present = openable; absent = disabled (the callback's existence is the gate). */
  onOpen?: (artifactId: string) => void;
  //** Name fills the remaining width (sidebar row); absent, the pill hugs content (artifact strip under the timeline). */
  fill?: boolean;
  //** Strip titles clamp to 24 chars (full title in the tooltip); sidebar rows rely on CSS truncate, no clamping. */
  truncateTitle?: boolean;
  //** Tooltip override; defaults to "kind word · title". */
  title?: string;
  //** Entrance delay (staggered in the strip, 30 ms apart). */
  enterDelayMs?: number;
  testId?: string;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const fullTitle = artifactDisplayTitle(artifact);
  const label = truncateTitle ? truncateArtifactChipTitle(fullTitle) : fullTitle;
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;
  const versionLabel = intl.formatMessage(
    { id: "chat.toolCall.workflow.run.artifacts.version" },
    { version: String(version) },
  );
  const md = size === "md";
  // Delayed entrances need backwards fill: hold the first frame while waiting (same reason as the subagent pill).
  const style: CSSProperties | undefined =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? undefined
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };

  // Notice summaries reuse the Read link grammar, keeping heavy artifact pills out of the tool row.
  if (variant === "link")
    return (
      <button
        type="button"
        disabled={!openable}
        onClick={openable ? () => onOpen(artifact.id) : undefined}
        data-testid={testId}
        data-artifact-id={artifact.id}
        data-artifact-kind={artifact.kind}
        data-artifact-version={String(version)}
        title={title ?? `${kindLabel} · ${fullTitle}`}
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-ui-base font-normal text-foreground-subtle enabled:cursor-pointer enabled:hover:underline"
      >
        <ArtifactKindIcon className="size-4 shrink-0" kind={artifact.kind} />
        <span className="min-w-0 truncate">{label}</span>
        {showVersion ? (
          <span data-testid="workflow-run-artifact-version">{versionLabel}</span>
        ) : null}
      </button>
    );
  return (
    <button
      aria-label={
        openable
          ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${fullTitle}`
          : undefined
      }
      className={cn(
        "wf-pill wf-arrive flex min-w-0 max-w-full items-center bg-surface text-left",
        md
          ? "h-8 gap-2 rounded-[9px] pl-2 pr-2.5 text-ui-sm"
          : "h-6 gap-1.5 rounded-md pl-1.5 pr-2 text-ui-xs",
        openable
          ? "wf-pill-open cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          : "cursor-default",
        fill && "w-full",
        className,
      )}
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
      data-artifact-open={openable ? "true" : undefined}
      data-artifact-version={String(version)}
      data-pill-size={size}
      data-testid={testId}
      disabled={!openable}
      onClick={openable ? () => onOpen(artifact.id) : undefined}
      style={style}
      title={title ?? `${kindLabel} · ${fullTitle}`}
      type="button"
    >
      <ArtifactKindIcon className="size-4 shrink-0 text-foreground-subtle" kind={artifact.kind} />
      <span className={cn("wf-pill-name min-w-0 truncate text-foreground", fill && "flex-1")}>
        {label}
      </span>
      {detail === undefined || detail === null ? null : (
        <span className="flex shrink-0 items-center gap-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          {detail}
        </span>
      )}
      {showVersion || openable ? (
        <span
          className={cn(
            "wf-pill-tail grid shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1",
            md ? "size-3.5" : "size-3",
          )}
          data-testid="workflow-pill-tail"
        >
          {showVersion ? (
            // Remount by version: on re-publish under the same id the tail pops in once (wf-mark's entrance); on hover it yields to ↗.
            <span
              className="wf-mark font-mono text-ui-xs leading-none tabular-nums text-foreground-subtlest"
              data-testid="workflow-run-artifact-version"
              key={version}
              title={versionLabel}
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
              data-testid="workflow-artifact-pill-open"
            >
              <ArrowUpRightIcon className={md ? "size-3.5" : "size-3"} />
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
