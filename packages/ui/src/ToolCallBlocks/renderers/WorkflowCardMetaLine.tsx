import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * One metadata line at the top of a tool-card body: muted label + mono value (source
 * filename, run id, ...) plus an optional muted note. `marker` becomes
 * `data-workflow-card-<marker>="true"` for tests/styles to find the row; `flag` becomes
 * `data-workflow-card-<marker>-<flag>="true"`, asserting an additional fact about the row.
 */
export function WorkflowCardMetaLine({
  marker,
  label,
  value,
  title,
  note,
  flag,
}: {
  marker: string;
  label: string;
  value: string;
  title?: string;
  note?: string;
  flag?: string;
}) {
  return (
    <p
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-ui-sm"
      {...{ [`data-workflow-card-${marker}`]: "true" }}
      {...(flag === undefined ? {} : { [`data-workflow-card-${marker}-${flag}`]: "true" })}
    >
      <span className="shrink-0 text-foreground-subtlest">{label}</span>
      <span className="min-w-0 truncate font-mono text-foreground-subtle" title={title ?? value}>
        {value}
      </span>
      {note === undefined ? null : (
        <span className="shrink-0 text-foreground-subtlest">· {note}</span>
      )}
    </p>
  );
}

/**
 * Lineage for the amend card body:
 * "amends run X" — which run this card modifies. `runId` is read from the AmendWorkflow
 * input (`run_id`) under the same rule as the confirm dialog; CreateWorkflow rows lack it
 * and the body omits the line.
 *
 * `scriptInherited`: this revision omitted the script and keeps the predecessor's
 * ("Keeping the predecessor's script"); the line notes "script unchanged" — there is no
 * script to collapse on the card, because omitting it is the point of this call.
 */
export function WorkflowAmendsLine({
  runId,
  scriptInherited = false,
}: {
  runId: string;
  scriptInherited?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <WorkflowCardMetaLine
      marker="amends"
      label={intl.formatMessage({ id: "chat.toolCall.workflow.amend.amends" })}
      value={runId}
      {...(scriptInherited
        ? {
            note: intl.formatMessage({ id: "chat.toolCall.workflow.amend.scriptUnchanged" }),
            flag: "script-inherited",
          }
        : {})}
    />
  );
}
