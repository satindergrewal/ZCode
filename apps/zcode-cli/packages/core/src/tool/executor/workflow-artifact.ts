/**
 * Serialization rules for workflow run artifacts, shared by two core sites: the completion notification's
 * `<result>` (background-tasks.ts) and the runtime task entry's `resultText` (background-task-registry.ts,
 *
 * The implementation **moved to `@zcode/contracts`** (`interfaces/dynamic-workflow-run.port.ts`, the same
 * seam as `boundDynamicWorkflowRunEventPayload`): it gained a third consumer -- bootstrap's v4 projection
 * computes `workflowRuns.reports[].preview` (detail-page Results section) with the same rule. Bootstrap cannot
 * import core internals, and a copied rule is how "the same value looks different in the notification vs the
 * panel" happens. A re-export stays here so the two core import sites do not move.
 */
import { serializeWorkflowArtifact } from "@zcode/contracts";

export { serializeWorkflowArtifact };

/**
 * Budget for the `<reports>` section of the completion notification: at most this many characters for the section.
 *
 * The notification end already truncates at 120k total, but that is the **last** gate: it cuts fields ordered later. Snapshot-borne
 * incremental artifacts allow 256 entries (`DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS`); left unchecked they crowd out `<result>` and
 * `<error>` — the two the model reads first. So this section carries its own budget.
 */
const WORKFLOW_REPORTS_PREVIEW_MAX_CHARS = 8_000;
/** Per-item bound. One 32KB artifact must not eat the whole section budget, starving the next ten. */
const WORKFLOW_REPORT_ITEM_MAX_CHARS = 2_000;

interface WorkflowReportsNotificationSection {
  /** **True total count** (not the preview's count). */
  count: number;
  /** Items actually in the preview; count > shown means the preview is partial. */
  shown: number;
  preview: string;
}

/**
 * Journal report entries -> the notification's `<reports>` section (common to completed/failed/cancelled).
 *
 * Truncation and count **both matter**: the count is the signal telling the main agent the preview is partial
 * and the full set is reachable via run id. Preview alone reads as "this is everything"; count alone is no artifact at all.
 *
 * `total` is the run's true entry count (the snapshot's `reportCount`); `items` is only its first slice (snapshot caps at
 * 256). Absent falls back to `items.length` — old snapshots lack the field, and back then `items` was everything.
 *
 * Returns `undefined` for zero items so the caller omits the whole section -- never an empty `<reports>`.
 */
export function buildWorkflowReportsNotificationSection(
  items: readonly unknown[] | undefined,
  total?: number,
): WorkflowReportsNotificationSection | undefined {
  if (items === undefined || items.length === 0) return undefined;

  const lines: string[] = [];
  let used = 0;
  for (const [index, item] of items.entries()) {
    const text = clip(serializeWorkflowArtifact(item) ?? "", WORKFLOW_REPORT_ITEM_MAX_CHARS);
    const line = `[${index + 1}] ${text}`;
    // Always grant one: one oversized artifact beats "reported 11, visible none".
    if (lines.length > 0 && used + line.length + 1 > WORKFLOW_REPORTS_PREVIEW_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }

  return {
    count: Math.max(total ?? 0, items.length),
    shown: lines.length,
    preview: lines.join("\n"),
  };
}

/**
 * The `<reports>` section of the manifest payload (`WorkflowNotificationMeta.reports`). Same source and per-item serialization as the
 * **notification text** section above (`serializeWorkflowArtifact`), but emitting **string[]** instead of one joined block —
 * the GUI renders manifest items as numbered previews; a joined blob would make it split again.
 *
 * Bounds deliberately differ from the notification-text section: per item <= 500, at most 8 items (mirrors shared's `workflowNotificationMetaSchema` —
 * exceeding it makes zod reject the turnHeader row on persist).
 *
 * `total` means the same as in the notice section (the snapshot's `reportCount`, falling back to `items.length`).
 *
 * With zero entries return `undefined` so the caller can omit the whole field.
 */
export function buildWorkflowReportsManifestSection(
  items: readonly unknown[] | undefined,
  total?: number,
): { count: number; shown: number; preview: string[] } | undefined {
  if (items === undefined || items.length === 0) return undefined;

  const preview: string[] = [];
  for (const item of items) {
    if (preview.length >= WORKFLOW_NOTIFICATION_REPORTS_MAX_ITEMS) break;
    preview.push(
      clip(serializeWorkflowArtifact(item) ?? "", WORKFLOW_NOTIFICATION_REPORT_ITEM_MAX_CHARS),
    );
  }
  return { count: Math.max(total ?? 0, items.length), shown: preview.length, preview };
}

/** Per-item artifact preview bound in the manifest payload (shared schema: <=500 chars). */
const WORKFLOW_NOTIFICATION_REPORT_ITEM_MAX_CHARS = 500;
/** Max preview items in the manifest payload (shared schema: <=8). */
const WORKFLOW_NOTIFICATION_REPORTS_MAX_ITEMS = 8;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
