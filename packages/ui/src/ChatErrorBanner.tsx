import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
/**
 * ChatErrorBanner — error banner
 *
 * Surfaces ZCode Agent errors, with traceId for debugging.
 */
import { useState } from "react";
import {
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
  TID_CHAT_ERROR_DETAILS_BUTTON,
  TID_CHAT_ERROR_BANNER,
  TID_CHAT_ERROR_HOOK_ICON,
} from "@zcode/shared";
import { AnchorIcon, CopyIcon, InfoIcon, RocketIcon, SettingsIcon, X } from "lucide-react";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import type { IntlInstance } from "./i18n/IntlProvider.js";
import { Button } from "./components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.js";
import { cn } from "./components/lib/utils.js";
import { toast } from "./components/ui/toast.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { getProviderBusinessErrorMessageId } from "@/lib/providerBusinessError.js";
import { buildErrorFeedbackDescription } from "@/lib/errorFeedbackDraft.js";
import {
  isSuspiciousEmptyModelResultMessage,
  resolveOffPeakTicketExpiredBusinessCode,
} from "@/lib/providerBusinessError.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";

// The historical-task banner matches localized agent copies of this message; one canonical
// English form suffices now that ui copy is English-only.
const HISTORICAL_MODEL_UNAVAILABLE_MESSAGES = [
  "The model used by this historical task is no longer available",
];

const LOCALIZED_ERROR_CODES = new Set([
  "TASK_OWNED_BY_OTHER_HOST",
  "STALE_TASK_OWNER_COMMAND",
  "NO_ACTIVE_TASK_OWNER",
  "OWNER_COMMAND_FAILED",
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
  // Service error messages cross process boundaries and cannot be the UI language source.
  // The unavailable-model case localizes by stable code so an English UI never shows Chinese.
  "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
  "ZCODE_BIGMODEL_TEAM_PLAN_MEMBER_REQUIRED",
]);

const MODEL_CONFIG_MISSING_CODES = new Set([
  "model_config_missing",
  "MODEL_CONFIG_MISSING",
  "ModelConfigMissing",
]);

function isModelConfigMissingError(error: Pick<ZCodeUiError, "code" | "message">): boolean {
  // With an empty pre-send registry the agent falls back to CLI config and throws
  // Model config is missing; the real cause is no available model, and the CLI config path
  // must not reach desktop users. Match on the structured code only — readable messages of
  // UNKNOWN/SEND_FAILED wrappers may contain the same text, and a false positive would also
  // hide the copy/feedback diagnostics.
  return Boolean(error.code && MODEL_CONFIG_MISSING_CODES.has(error.code));
}

export function resolveChatErrorBannerDisplayMessage(
  error: ZCodeUiError,
  intl: IntlInstance,
): string {
  if (isModelConfigMissingError(error)) {
    return intl.formatMessage({ id: "chat.error.noAvailableModel" });
  }

  const providerBusinessCode =
    resolveOffPeakTicketExpiredBusinessCode(error.code, error.message) ?? error.code;
  const providerBusinessMessageId = getProviderBusinessErrorMessageId(providerBusinessCode);
  if (providerBusinessMessageId) {
    return intl.formatMessage({ id: providerBusinessMessageId });
  }

  if (isSuspiciousEmptyModelResultMessage(error.message)) {
    return intl.formatMessage({ id: "zcode.error.modelSuspiciousEmpty" });
  }

  return error.code && LOCALIZED_ERROR_CODES.has(error.code)
    ? intl.formatMessage({ id: `zcode.error.${error.code}` })
    : error.message;
}

export function shouldSuppressChatErrorBanner(
  error: Pick<ZCodeUiError, "code" | "message">,
): boolean {
  // Only hide the stale unavailable-model banner left by history restore; live send/draft
  // errors must show, or after a model is removed the user sees a silent no-reply.
  return Boolean(
    error.code === "ZCODE_RUNTIME_MODEL_UNAVAILABLE" &&
    HISTORICAL_MODEL_UNAVAILABLE_MESSAGES.some((message) => error.message.includes(message)),
  );
}

export function ChatErrorBanner({
  error,
  onRetry,
  retryLabel,
  retryDisabled,
  onDismiss,
  onOpenModelSettings,
  onOpenUpgrade,
}: {
  error: ZCodeUiError;
  onRetry?: () => void;
  retryLabel?: string;
  retryDisabled?: boolean;
  onDismiss?: () => void;
  onOpenModelSettings?: () => void;
  onOpenUpgrade?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const actionButtonClassName = "shrink-0";
  const iconButtonClassName = "shrink-0";
  const localizedErrorMessage = resolveChatErrorBannerDisplayMessage(error, intl);
  const modelConfigMissing = isModelConfigMissingError(error);
  const hookBlocked = error.code === "fault.runtime.hookBlocked";
  if (shouldSuppressChatErrorBanner(error)) {
    return null;
  }

  const handleOpenFeedback = async () => {
    openFeedbackSubmit({
      title: localizedErrorMessage.slice(0, 80),
      type: "bug",
      module: "模型调用报错",
      severity: "P2-中",
      includeLogs: false,
      description: buildErrorFeedbackDescription({
        message: localizedErrorMessage,
        detail: error.detail,
        traceId: error.traceId,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "chat.error.feedbackOpened" }));
  };

  const handleCopyError = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(
        intl.formatMessage({ id: "chat.error.copyFailed" }, { error: "clipboard-unavailable" }),
      );
      return;
    }

    try {
      // The banner used to copy only the TraceID. Copy summary + TraceID + details so the whole
      // failure forwards in one click.
      await navigator.clipboard.writeText(
        buildErrorCopyText({
          message: localizedErrorMessage,
          detail: error.detail,
          traceId: error.traceId,
          formatMessage: (id: string, values?: Record<string, string>) =>
            intl.formatMessage({ id }, values),
        }),
      );
      toast(intl.formatMessage({ id: "chat.error.copyFull.copied" }));
    } catch (copyError) {
      toast(
        intl.formatMessage(
          { id: "chat.error.copyFailed" },
          {
            error: copyError instanceof Error ? copyError.message : String(copyError),
          },
        ),
      );
    }
  };

  return (
    <div className="flex w-full justify-center">
      <div
        data-testid={TID_CHAT_ERROR_BANNER}
        data-error-code={error.code}
        className={cn(
          "w-full flex flex-wrap items-center gap-2 rounded-xl bg-surface backdrop-blur-md border border-border px-3 py-2",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 text-ui-base text-foreground">
          {hookBlocked ? (
            <AnchorIcon
              aria-hidden="true"
              className="size-4 shrink-0"
              data-testid={TID_CHAT_ERROR_HOOK_ICON}
            />
          ) : (
            <InfoIcon aria-hidden="true" className="size-4 shrink-0" />
          )}
          <div className="min-w-0 truncate font-medium">{localizedErrorMessage}</div>
        </div>

        {modelConfigMissing ? (
          <>
            <CodingPlanEntryButton
              type="button"
              variant="default"
              size="sm"
              onClick={onOpenUpgrade}
              className={cn(
                actionButtonClassName,
                "button-gradient gap-1.5 text-white hover:bg-transparent hover:opacity-90 dark:bg-[#484A58] dark:hover:bg-[#484A58]",
              )}
              aria-label={intl.formatMessage({
                id: "chat.quota.action.upgrade",
              })}
            >
              <RocketIcon className="size-3.5" />
              {intl.formatMessage({ id: "chat.quota.action.upgrade" })}
            </CodingPlanEntryButton>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenModelSettings}
              className={cn(actionButtonClassName, "gap-1.5")}
              aria-label={intl.formatMessage({ id: "chat.error.setModels" })}
            >
              <SettingsIcon className="size-3.5" />
              {intl.formatMessage({ id: "chat.error.setModels" })}
            </Button>
          </>
        ) : null}

        {!modelConfigMissing && error.detail ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={actionButtonClassName}
              data-testid={TID_CHAT_ERROR_DETAILS_BUTTON}
              onClick={() => {
                // Details used to expand inline, letting long errors inflate the message area and
                // jolt scrolling. A dialog keeps the banner to one line; the rest lives in its own layer.
                setDetailsDialogOpen(true);
              }}
            >
              {intl.formatMessage({ id: "chat.error.expandDetails" })}
            </Button>
            <Dialog open={detailsDialogOpen} onOpenChange={setDetailsDialogOpen}>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle className="whitespace-pre-wrap">{localizedErrorMessage}</DialogTitle>
                  <DialogDescription>
                    {intl.formatMessage({ id: "chat.error.expandDetails" })}
                  </DialogDescription>
                </DialogHeader>
                <pre className="max-h-[60vh] overflow-auto rounded-xl border border-border bg-surface px-3 py-2 text-ui-base whitespace-pre-wrap text-foreground-subtle">
                  {error.detail}
                </pre>
              </DialogContent>
            </Dialog>
          </>
        ) : null}

        {!modelConfigMissing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void handleCopyError();
            }}
            className={cn(actionButtonClassName, "gap-1.5")}
            aria-label={intl.formatMessage({ id: "chat.error.copyFull" })}
          >
            <CopyIcon className="size-3.5" />
            {intl.formatMessage({ id: "chat.error.copyFull" })}
          </Button>
        ) : null}

        {/* The error banner is already an exceptional state; routing it through Radix Tooltip's
            Popper/Slot chain again risks a Maximum update depth loop when e.g. no model is
            available. Plain Button instead. */}
        {!modelConfigMissing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void handleOpenFeedback();
            }}
            // Raw button elements bypassed the design system's focus/disabled handling. Routing
            // every banner action through Button keeps one interaction and theme story.
            className={cn(actionButtonClassName)}
            aria-label={intl.formatMessage({ id: "chat.error.feedback" })}
            title={error.traceId}
          >
            {intl.formatMessage({ id: "chat.error.feedback" })}
          </Button>
        ) : null}

        {!modelConfigMissing && onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retryDisabled}>
            {retryLabel ?? intl.formatMessage({ id: "chat.error.retry" })}
          </Button>
        ) : null}

        {onDismiss ? (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={onDismiss}
            className={cn(iconButtonClassName)}
            title={intl.formatMessage({ id: "chat.error.dismiss" })}
            aria-label={intl.formatMessage({ id: "chat.error.dismiss" })}
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function buildErrorCopyText({
  message,
  detail,
  traceId,
  formatMessage,
}: {
  message: string;
  detail?: string;
  traceId?: string;
  formatMessage: (id: string, values?: Record<string, string>) => string;
}) {
  return [
    formatMessage("feedback.submit.template.section.copyErrorHeading"),
    "",
    formatMessage("feedback.submit.template.section.errorSummary"),
    message,
    "",
    traceId ? formatMessage("feedback.submit.template.section.errorTraceId", { traceId }) : null,
    detail
      ? ["", formatMessage("feedback.submit.template.section.errorDetail"), detail].join("\n")
      : null,
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}
