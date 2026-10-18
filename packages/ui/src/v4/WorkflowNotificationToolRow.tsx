import { Hourglass, MessageCircleQuestion, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkflowNotificationMeta, WorkflowRunHole } from "@zcode/shared/zcode-protocol-v4";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import { WorkflowNotificationHoleRow } from "@/v4/WorkflowNotificationHoleRow.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { Theme } from "@/useTheme.js";
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";
import { WorkflowNotificationArtifactChips } from "@/v4/WorkflowNotificationArtifactChips.js";

/**
 * Background workflow notification row.
 *
 * The manifest-ledger shape was rejected as too flowery; keep the existing tool-card grammar:
 * the row is visually identical to plain tool rows (ToolLayout: icon + kindLabel + primaryText
 * + expanded body). Data contract, emitting side, hydration, and the pendingQuestions join are
 * untouched - this is presentation only.
 *
 * Purely presentational: join results (onOpenRun / pendingQids) are injected by the host from
 * the projection, the store is never read here, so it stays testable under
 * renderToStaticMarkup (expanded state via forceOpen into ToolLayout).
 */

/** testid base name for the notification row root. */
const TID_CHAT_WORKFLOW_NOTIFICATION_ROW = "chat-workflow-notification-row";

/** Collapsed-header one-line summary cap, per the escalate card: the summary is roughly what was asked; full text lives in the expanded body. */
const INLINE_PREVIEW_MAX_LENGTH = 160;

const TERMINAL_ICON = <Workflow className="size-4 shrink-0 text-foreground-subtle" />;
const ESCALATION_ICON = (
  <MessageCircleQuestion className="size-4 shrink-0 text-foreground-subtle" />
);

/** Panel body (question / result prose): escalate/submit-result border-border bg-panel convention. */
const PANEL_CLASS =
  "whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5";
/** Failure error panel: resolve-question-outcome border-destructive/40 convention (not the row-level failure affordance). */
const ERROR_PANEL_CLASS =
  "whitespace-pre-wrap break-words rounded-lg border border-destructive/40 bg-panel px-4 py-3 text-ui-base leading-5 text-foreground";

/** Collapse to a one-line summary: newlines to spaces, overlong truncated (escalate-card toInlinePreview). */
function toInlinePreview(value: string): string | undefined {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

const TERMINAL_KIND_LABEL_ID: Record<"completed" | "errored" | "stopped", string> = {
  completed: "chat.backgroundResult.workflow.completed",
  errored: "chat.backgroundResult.workflow.errored",
  stopped: "chat.backgroundResult.workflow.stopped",
};

/** stall-row kindLabel: the run lives, but 20 minutes passed without one successful model request. */
const STALL_KIND_LABEL_ID = "chat.backgroundResult.workflow.stall";
const STALL_ICON = <Hourglass className="size-4 shrink-0 text-foreground-subtle" />;

/** One `label: value` fact row in the expanded body (stall wait time / reason / concurrency). */
function factLine(label: string, value: string, key: string) {
  return (
    <p key={key} className="text-ui-sm text-foreground-subtle">
      <span className="text-foreground-subtlest">{label}</span> {value}
    </p>
  );
}

/**
 * Escalation-row kindLabel, three states (live-flipped by the pendingQuestions presence join,
 * same logic as the manifest):
 *   pendingQids has qid -> waiting (awaiting an answer);
 *   run present, qid absent -> answered (question answered);
 *   run absent (pendingQids === undefined) -> asked (neutral: question asked).
 * No pulse, no shimmer - shimmer means working; a parked question waits on the main agent.
 */
function escalationState(
  pendingQids: ReadonlySet<string> | undefined,
  qid: string,
): "waiting" | "answered" | "asked" {
  if (pendingQids === undefined) return "asked";
  return pendingQids.has(qid) ? "waiting" : "answered";
}

export interface WorkflowNotificationToolRowProps {
  notification: WorkflowNotificationMeta;
  /** Run name = originMeta.title (CLI-authoritative, never localized). */
  runName: string;
  /** testid suffix and ToolLayout persist key; unit.key. */
  testIdKey: string;
  /** Applied CodeBlock theme (json results). */
  theme: Theme;
  /** Prebound open-run-detail callback; without it the expanded body renders no open-run-detail link. */
  onOpenRun?: () => void;
  /**
   // Prebound open-artifact-tab callback (host-injected from the join, like `onOpenRun`). When
   // absent the chips still render, just inert: what was delivered is fact; openability is
   // capability.
   */
  onOpenArtifact?: (artifactId: string) => void;
  /** Escalation-row presence join: undefined = run not in the live projection; Set containing qid = Waiting; else Answered. */
  pendingQids?: ReadonlySet<string>;
  /** Test/host forced expansion (passed through as ToolLayout.forceOpen); the product defaults collapsed. */
  forceOpen?: boolean;
  /**
   * 留白行的在场性联查（docs/dynamic-workflow/transcript-and-notifications.md「The hole row's live state」）：
   * run 投影里的 `holes`；undefined = run 不在活投影（中性词）。
   */
  holes?: readonly WorkflowRunHole[];
}

export function WorkflowNotificationToolRow(props: WorkflowNotificationToolRowProps) {
  // 留白行整个另起一件（WorkflowNotificationHoleRow.tsx）：它有自己的三态与展开体，塞进下面的
  // 三分支只会让每个分支都多一句「不是 hole」。
  if (props.notification.kind === "hole") {
    return (
      <WorkflowNotificationHoleRow
        forceOpen={props.forceOpen ?? false}
        holes={props.holes}
        notification={props.notification}
        runName={props.runName}
        toolId={`${TID_CHAT_WORKFLOW_NOTIFICATION_ROW}-${props.testIdKey}`}
        {...(props.onOpenRun === undefined ? {} : { onOpenRun: props.onOpenRun })}
      />
    );
  }
  return <WorkflowNotificationBaseRow {...props} notification={props.notification} />;
}

function WorkflowNotificationBaseRow({
  notification,
  runName,
  testIdKey,
  theme,
  onOpenRun,
  onOpenArtifact,
  pendingQids,
  forceOpen = false,
}: WorkflowNotificationToolRowProps & {
  notification: Exclude<WorkflowNotificationMeta, { kind: "hole" }>;
}) {
  const { intl } = useZCodeIntl();

  // The wait clock must tick with no event stream (a stalled run emits none): feed a fresh now at a fixed interval.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const openRunLink = onOpenRun ? (
    <button
      type="button"
      onClick={onOpenRun}
      className="text-ui-sm text-foreground-subtle decoration-dotted underline-offset-2 hover:text-foreground hover:underline"
    >
      {intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
    </button>
  ) : null;

  const isEscalation = notification.kind === "escalation";
  const isStall = notification.kind === "stall";

  // kindLabel + primaryText + expanded body, minted per notification kind.
  const escalationView = isEscalation ? escalationState(pendingQids, notification.qid) : undefined;

  // The stopped reason word trails kindLabel.
  const stopReason =
    notification.kind === "terminal" && notification.status === "stopped"
      ? notification.stopReason
      : undefined;
  const kindLabel = isEscalation
    ? intl.formatMessage({ id: `chat.backgroundResult.workflow.${escalationView!}` })
    : isStall
      ? intl.formatMessage({ id: STALL_KIND_LABEL_ID })
      : stopReason !== undefined
        ? `${intl.formatMessage({ id: TERMINAL_KIND_LABEL_ID[notification.status] })} · ${intl.formatMessage({ id: `chat.toolCall.workflow.run.stopReason.${stopReason}` })}`
        : intl.formatMessage({ id: TERMINAL_KIND_LABEL_ID[notification.status] });

  const primaryText = useMemo(() => {
    if (notification.kind === "terminal" || notification.kind === "stall") {
      return (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">{runName}</span>
        </span>
      );
    }
    const preview = toInlinePreview(notification.question);
    return <span className="min-w-0 truncate">{preview ?? runName}</span>;
  }, [notification, runName]);

  // Artifact chips at the collapsed-header tail, via the ToolLayout `secondaryText` slot with
  // the existing hideSecondaryTextWhenOpen: visible on the collapsed header only - once open,
  // the body already says the result and lingering chips are duplication.
  const artifactChips =
    notification.kind === "terminal" &&
    notification.artifacts !== undefined &&
    notification.artifacts.length > 0 ? (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span aria-hidden>·</span>
        <WorkflowNotificationArtifactChips
          artifacts={notification.artifacts}
          {...(notification.artifactsTruncated === undefined
            ? {}
            : { truncated: notification.artifactsTruncated })}
          {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
        />
      </span>
    ) : undefined;

  // Expand gate: terminal states look at the artifact (errored / a provider-stopped error,
  // else result); escalation always has question body; stall always has wait facts.
  const hasDetails =
    notification.kind === "escalation" || notification.kind === "stall"
      ? true
      : notification.error !== undefined
        ? true
        : Boolean(notification.result);

  const waited =
    escalationView === "waiting" && notification.kind === "escalation"
      ? workflowRunQuestionWaitedLabel(notification.askedAt, now, (descriptor, values) =>
          intl.formatMessage(descriptor, values),
        )
      : undefined;

  const renderContent = useCallback(() => {
    if (notification.kind === "escalation") {
      const contextHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.context" });
      return (
        <div className="space-y-3">
          {/* Full question (never quoting the answer - that lives in the adjacent ResolveWorkflowQuestion card). */}
          <p className={`${PANEL_CLASS} text-foreground`}>{notification.question}</p>
          {notification.context !== undefined ? (
            <section className="space-y-1.5">
              <h4 className="text-ui-sm font-medium text-foreground-subtlest">{contextHeading}</h4>
              <p className={`${PANEL_CLASS} text-foreground-subtle`}>{notification.context}</p>
            </section>
          ) : null}
          {waited ? <p className="text-ui-sm text-foreground-subtle">{waited}</p> : null}
          {openRunLink}
        </div>
      );
    }

    if (notification.kind === "stall") {
      const minutes = Math.max(1, Math.round(notification.sinceMs / 60_000));
      return (
        <div className="space-y-1" data-testid="workflow-notification-stall">
          <p className={`${PANEL_CLASS} text-foreground`}>
            {intl.formatMessage({ id: "chat.backgroundResult.workflow.stall.body" }, { minutes })}
          </p>
          {notification.reason !== undefined
            ? factLine(
                intl.formatMessage({ id: "chat.backgroundResult.workflow.stall.reason" }),
                notification.reason,
                "reason",
              )
            : null}
          {notification.cap !== undefined
            ? factLine(
                intl.formatMessage({ id: "chat.backgroundResult.workflow.stall.cap" }),
                String(notification.cap),
                "cap",
              )
            : null}
          {openRunLink}
        </div>
      );
    }

    // errored, or stopped with error detail (provider/interrupted): error panel.
    if (notification.error !== undefined) {
      return (
        <div className="space-y-3">
          <p className={ERROR_PANEL_CLASS}>{notification.error}</p>
          {openRunLink}
        </div>
      );
    }

    // completed/stopped: result only (prose <p> / json CodeBlock, submit-result convention).
    const { result, resultForm } = notification;
    let resultCode = result ?? "";
    if (resultForm === "json") {
      try {
        resultCode = JSON.stringify(JSON.parse(resultCode), null, 2);
      } catch {
        /* Historically truncated JSON keeps the raw text; never drop the result. */
      }
    }
    return (
      <div className="mb-2 min-w-0 space-y-2" data-testid="workflow-notification-result">
        {resultForm === "json" ? (
          <CodeBlock
            appTheme={theme}
            code={resultCode}
            language="json"
            className="border border-border bg-card"
            contentClassName="max-h-80 overflow-auto"
            wrapLongLines
          >
            <CodeBlockHeader className="pl-3 pr-2 pt-2" language="json" />
          </CodeBlock>
        ) : (
          <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-base leading-relaxed text-foreground">
            {result}
          </p>
        )}
        {openRunLink}
      </div>
    );
  }, [notification, theme, waited, openRunLink, intl]);

  const toolId = `${TID_CHAT_WORKFLOW_NOTIFICATION_ROW}-${testIdKey}`;

  return (
    <div data-testid={toolId}>
      <ToolLayout
        toolId={toolId}
        persistOpenKey={toolId}
        icon={isEscalation ? ESCALATION_ICON : isStall ? STALL_ICON : TERMINAL_ICON}
        // The kind already picks the icon; default showIcon renders it.
        canToggle={hasDetails}
        forceOpen={forceOpen && hasDetails}
        hideSecondaryTextWhenOpen
        kindLabel={kindLabel}
        primaryText={primaryText}
        secondaryText={artifactChips}
        // Key: do NOT use the ToolLayout failure-status affordance (that means this-call-broke).
        // Workflow-failed is said by kindLabel, details in the expanded body. No isRunning either
        // (no shimmer).
        title={runName}
        renderContent={hasDetails ? renderContent : undefined}
      />
    </div>
  );
}
