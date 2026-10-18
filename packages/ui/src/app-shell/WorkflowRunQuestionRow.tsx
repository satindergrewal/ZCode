import { MessageCircleQuestionIcon } from "lucide-react";
import type { WorkflowRunPendingQuestion } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";

/**
 * One escalation question, hung under the asker's row.
 *
 * READ-ONLY, v1 has no answer box: the answerer is the primary agent, not the user — when
 * unsure it can already relay via AskUserQuestion. The qid is the token the primary agent
 * answers with; the user cannot answer it, but showing it lets them point at one specific
 * question for the agent to address — the only relayable handle in this read-only surface.
 */
export function WorkflowRunQuestionRow({
  className,
  now,
  question,
  showAsker = false,
}: {
  /** Placement is the caller's job (in the spine: under the asker, indented 26px more; orphan blocks at the end indent themselves). */
  className?: string;
  /** "Now", fed by the list's timer, so wait time advances even without an event stream. */
  now: number;
  question: WorkflowRunPendingQuestion;
  /** Questions that match no asker (hung at phase end) must name themselves; row-hung ones need not repeat it. */
  showAsker?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const waited = workflowRunQuestionWaitedLabel(question.askedAt, now, (descriptor, values) =>
    intl.formatMessage(descriptor, values),
  );

  return (
    <div
      className={cn(
        "mt-1 flex min-w-0 items-start gap-2 rounded-lg bg-[var(--color-interaction-confirmation-surface)] px-2 py-1.5 text-ui-sm text-[var(--color-interaction-confirmation-foreground)]",
        className,
      )}
      data-qid={question.qid}
      data-testid="workflow-run-question"
    >
      <MessageCircleQuestionIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {showAsker ? (
          <span className="mr-2 font-mono text-ui-xs font-medium">
            {question.actorName ??
              (question.actorSiteId === undefined
                ? intl.formatMessage({ id: "chat.toolCall.workflow.graph.lane.anonymous" })
                : `${question.actorSiteId}@${question.actorOrdinal}`)}
          </span>
        ) : null}
        {/* Question text is prose, not a technical value: body typography; pre-wrap keeps the model's newlines. */}
        <span className="whitespace-pre-wrap break-words">{question.question}</span>
        {question.context === undefined ? null : (
          <p
            className="mt-0.5 whitespace-pre-wrap break-words text-ui-xs opacity-80"
            data-testid="workflow-run-question-context"
          >
            {question.context}
          </p>
        )}
      </div>
      <span className="flex shrink-0 items-baseline gap-2 font-mono text-ui-xs">
        {/* Wait time. Deliberately NOT warning-colored: a long wait is normal by design, not an alarm. When askedAt
            is absent (old journal replay) the whole span is skipped — never fabricate "just now". */}
        {waited === undefined ? null : (
          <span data-testid="workflow-run-question-waited">{waited}</span>
        )}
        <span className="opacity-70">{question.qid}</span>
      </span>
    </div>
  );
}
