import { Save } from "lucide-react";
import { useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const SAVE_WORKFLOW_TOOL_ICON = <Save className="size-4 shrink-0 text-foreground-subtle" />;

/**
 * Overwrite badge styling: same family as the CreateWorkflow result card's compiled chip
 * (engraved chip - rounded-xs + uppercase mono microlabel) with the semantic color switched to
 * warning. warning over destructive is deliberate: the file is **replaced**, not deleted, and
 * destructive would overstate it; overwrite is a real semantic state, not DESIGN.md's forbidden
 * borrowing of semantic color for louder blocks.
 */
const OVERWRITE_BADGE_CLASSNAME =
  "shrink-0 rounded-xs border border-warning/40 px-1.5 py-0.5 font-mono text-ui-xs uppercase tracking-wf-label leading-none text-warning";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** One args declaration in SaveWorkflow's normalized input. */
export interface WorkflowArgDeclaration {
  name: string;
  type: string | undefined;
  description: string | undefined;
  required: boolean;
  /** Whether `default` is present - a false default and no default must stay distinguishable. */
  hasDefault: boolean;
  defaultValue: unknown;
}

/**
 * SaveWorkflow's normalized input (the reusable-workflow spec's "normalized SaveWorkflow shape"):
 * `{name, description, whenToUse?, args?, script, path, overwrite, scope}`.
 *
 * `path` / `overwrite` / `scope` are facts computed at resolution time, not claims by the model -
 * the dialog shows what will actually happen. This gate has no display payload; the input is the
 * whole story.
 */
interface SaveWorkflowInput {
  name: string | undefined;
  description: string | undefined;
  whenToUse: string | undefined;
  path: string | undefined;
  scope: string | undefined;
  /** Shadowing fact when another scope already holds this name (resolved-time, via the input channel; same rationale as path/overwrite). */
  shadowing: "hides_global" | "hidden_by_project" | undefined;
  overwrite: boolean;
  script: string | undefined;
  args: WorkflowArgDeclaration[];
}

function readArgDeclarations(value: unknown): WorkflowArgDeclaration[] {
  if (!isPlainRecord(value)) {
    return [];
  }

  const declarations: WorkflowArgDeclaration[] = [];
  for (const [name, declaration] of Object.entries(value)) {
    if (!isPlainRecord(declaration)) {
      continue;
    }
    declarations.push({
      name,
      type: readTrimmedString(declaration.type),
      description: readTrimmedString(declaration.description),
      required: declaration.required === true,
      hasDefault: "default" in declaration,
      defaultValue: declaration.default,
    });
  }
  return declarations;
}

export function readSaveWorkflowInput(input: unknown): SaveWorkflowInput {
  const record = isPlainRecord(input) ? input : {};

  return {
    name: readTrimmedString(record.name),
    description: readTrimmedString(record.description),
    whenToUse: readTrimmedString(record.whenToUse),
    path: readTrimmedString(record.path),
    scope: readTrimmedString(record.scope),
    shadowing:
      record.shadowing === "hides_global" || record.shadowing === "hidden_by_project"
        ? record.shadowing
        : undefined,
    // Only explicit true is an overwrite: with the field absent we cannot know a file is already
    // there, so the dialog must not assert it on the user's behalf.
    overwrite: record.overwrite === true,
    script:
      typeof record.script === "string" && record.script.length > 0 ? record.script : undefined,
    args: readArgDeclarations(record.args),
  };
}

export function SaveWorkflowOverwriteBadge({ label }: { label: string }) {
  return (
    <span className={OVERWRITE_BADGE_CLASSNAME} data-workflow-overwrite-badge="true">
      {label}
    </span>
  );
}

/**
 * Collapsed-row chip for global scope: same family as the overwrite badge (engraved chip), semantic
 * color foreground-subtle - a scope note, not a warning; no borrowing warning/destructive.
 */
const SCOPE_BADGE_CLASSNAME =
  "shrink-0 rounded-xs border border-border px-1.5 py-0.5 font-mono text-ui-xs uppercase tracking-wf-label leading-none text-foreground-subtle";

function SaveWorkflowScopeBadge({ label }: { label: string }) {
  return (
    <span className={SCOPE_BADGE_CLASSNAME} data-workflow-scope-badge="global">
      {label}
    </span>
  );
}

/**
 * The SaveWorkflow chat card: deliberately compact - name, overwrite marker, description.
 *
 * Full content (destination, args declaration table, script) belongs to the confirmation dialog:
 * that is where the decision is made; this card is the after-the-fact record.
 */
export function SaveWorkflowToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;

  const saved = useMemo(() => readSaveWorkflowInput(toolCall.input), [toolCall.input]);

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.workflow.save.saving"
      : "chat.toolCall.workflow.save.saved",
  });
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const overwriteLabel = intl.formatMessage({ id: "chat.toolCall.workflow.save.overwrite" });
  const pathLabel = intl.formatMessage({ id: "chat.permission.workflow.save.path" });
  const whenToUseLabel = intl.formatMessage({ id: "chat.permission.workflow.save.whenToUse" });
  const isGlobalScope = saved.scope === "global";
  const isProjectScope = saved.scope === "project";
  const scopeLabel = intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.label" });
  const globalBadgeLabel = intl.formatMessage({ id: "chat.toolCall.workflow.scope.global" });
  const scopeValue = isGlobalScope
    ? intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.global" })
    : isProjectScope
      ? intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.project" })
      : null;
  const shadowingLabel =
    saved.shadowing === "hides_global"
      ? intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.hidesGlobal" })
      : saved.shadowing === "hidden_by_project"
        ? intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.hiddenByProject" })
        : null;

  const primaryText = useMemo(
    () => (
      <span className="truncate font-mono text-foreground-subtlest">
        {saved.name ?? fallbackName}
      </span>
    ),
    [fallbackName, saved.name],
  );

  const kindDetail = useMemo(
    () =>
      // Collapsed row: global scope adds a Global chip beside the overwrite badge (unknown/project add none).
      saved.overwrite || isGlobalScope ? (
        <span className="flex items-center gap-1">
          {saved.overwrite ? <SaveWorkflowOverwriteBadge label={overwriteLabel} /> : null}
          {isGlobalScope ? <SaveWorkflowScopeBadge label={globalBadgeLabel} /> : null}
        </span>
      ) : null,
    [globalBadgeLabel, isGlobalScope, overwriteLabel, saved.overwrite],
  );

  const renderContent = useMemo(
    () => () => (
      <div className="mb-2 space-y-1.5">
        {saved.description === undefined ? null : (
          // The collapsed row keeps only the name + overwrite badge.
          <p className="min-w-0 whitespace-pre-wrap break-words text-ui-base leading-5 text-foreground-subtle">
            {saved.description}
          </p>
        )}
        {scopeValue === null ? null : (
          // The scope line sits above the destination.
          <p className="flex min-w-0 items-baseline gap-2 text-ui-sm">
            <span className="shrink-0 text-foreground-subtlest">{scopeLabel}</span>
            <span className="min-w-0 text-foreground-subtle">{scopeValue}</span>
          </p>
        )}
        {shadowingLabel === null ? null : (
          <p className="min-w-0 whitespace-pre-wrap break-words text-ui-sm text-foreground-subtle">
            {shadowingLabel}
          </p>
        )}
        {saved.path === undefined ? null : (
          <p className="flex min-w-0 items-baseline gap-2 text-ui-sm">
            <span className="shrink-0 text-foreground-subtlest">{pathLabel}</span>
            <span className="min-w-0 truncate font-mono text-foreground-subtle" title={saved.path}>
              {saved.path}
            </span>
          </p>
        )}
        {saved.whenToUse === undefined ? null : (
          <p className="flex min-w-0 items-baseline gap-2 text-ui-sm">
            <span className="shrink-0 text-foreground-subtlest">{whenToUseLabel}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words text-foreground-subtle">
              {saved.whenToUse}
            </span>
          </p>
        )}
      </div>
    ),
    [
      pathLabel,
      saved.description,
      saved.path,
      saved.whenToUse,
      scopeLabel,
      scopeValue,
      shadowingLabel,
      whenToUseLabel,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SAVE_WORKFLOW_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        kindDetail={kindDetail}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        // Deliberately no secondaryText: the collapsed row is name only (+ overwrite badge);
        // description/destination/whenToUse move into the expanded body - the shorter the
        // after-the-fact record, the more readable.
        statusLabel={context.statusLabel}
        statusTooltip={context.errorText}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={saved.description ?? toolCall.title}
        renderContent={renderContent}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
