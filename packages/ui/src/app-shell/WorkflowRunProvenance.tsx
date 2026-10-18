// ============================================================
// Run-detail provenance block.
// ============================================================
// Split out of WorkflowRunSidePaneSections.tsx (max-lines gate). Two run kinds get this block:
// hub-launched runs and "settings-amended" runs. Runs started via the tool path do not -- their
// provenance is the CreateWorkflow line in the transcript. Read-only, no actions.

import { Fragment, memo } from "react";
import type { WorkflowLaunchMeta } from "@zcode/shared/zcode-protocol-v4";
import { workflowSettingsProvenanceRows } from "@/components/workflow-timeline/workflowSettingsChange.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Argument value: strings verbatim, everything else `JSON.stringify` (same normalization as the args popover / notification). */
function formatArgValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Hub launch: "started by you from the workflow hub - time" plus scope badge, description and
 * argument key-value table below.
 * Settings amend: "settings changed by you - time", no scope badge, one "{from} -> {to}" row per
 * change below.
 */
export const WorkflowRunProvenance = memo(function WorkflowRunProvenance({
  meta,
  providerName,
  startedAt,
}: {
  meta: WorkflowLaunchMeta;
  /** providerId -> provider name (same lookup as the summary row's model segment); falls back to the bare modelId. */
  providerName?: (providerId: string) => string | undefined;
  /** startedAt of the launch / settings round; omitted means no timestamp. */
  startedAt?: number;
}) {
  const { intl } = useZCodeIntl();
  const amend = meta.amend;
  const caption = intl.formatMessage({
    id:
      amend === undefined
        ? "chat.workflowLaunch.startedByYou"
        : "chat.workflowLaunch.settingsChangedByYou",
  });
  const time =
    startedAt === undefined
      ? undefined
      : new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(startedAt);
  const rows =
    amend === undefined
      ? Object.entries(meta.args ?? {}).map(([key, value]) => ({
          key,
          label: key,
          value: formatArgValue(value),
        }))
      : workflowSettingsProvenanceRows(amend, {
          formatMessage: intl.formatMessage.bind(intl),
          ...(providerName === undefined ? {} : { providerName }),
        });

  return (
    <div
      className="shrink-0 border-b border-border px-4 py-3"
      data-testid="workflow-run-provenance"
      data-workflow-launch-kind={amend === undefined ? "launch" : "settings"}
      {...(meta.scope === undefined ? {} : { "data-workflow-launch-scope": meta.scope })}
    >
      <div className="flex min-w-0 items-center gap-2 text-ui-xs text-foreground-subtle">
        <span className="min-w-0 truncate">
          {time === undefined ? caption : `${caption} · ${time}`}
        </span>
        {/* Scope badge: reuses the hub's small badge classes (rounded-sm border, small text). A settings round has no saved file, hence no scope. */}
        {amend !== undefined || meta.scope === undefined ? null : (
          <span
            className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 leading-none text-foreground-subtlest"
            data-testid="workflow-run-provenance-scope"
          >
            {intl.formatMessage({ id: `chat.workflowLaunch.scope.${meta.scope}` })}
          </span>
        )}
      </div>
      {amend === undefined && meta.description ? (
        <p className="mt-1 min-w-0 text-ui-sm leading-5 text-foreground-subtle">
          {meta.description}
        </p>
      ) : null}
      {/* Key-value table: args are mono keys with mono values truncated to one line (title holds the full
          text); settings changes use human labels with values likewise single-line. The side pane has
          vertical room to spare; no collapsing. */}
      {rows.length > 0 ? (
        <dl
          className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1"
          data-testid={
            amend === undefined
              ? "workflow-run-provenance-args"
              : "workflow-run-provenance-settings"
          }
        >
          {rows.map((row) => (
            <Fragment key={row.key}>
              <dt
                className={
                  amend === undefined
                    ? "truncate font-mono text-ui-xs text-foreground-subtle"
                    : "truncate text-ui-xs text-foreground-subtle"
                }
              >
                {row.label}
              </dt>
              <dd
                className={
                  amend === undefined
                    ? "truncate font-mono text-ui-xs text-foreground"
                    : "truncate text-ui-xs text-foreground tabular-nums"
                }
                title={row.value}
              >
                {row.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </div>
  );
});
