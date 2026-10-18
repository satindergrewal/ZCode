import type { PostUpdateReleaseNotesPayload } from "@zcode/shared";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { GlmMonochromeIcon } from "@/components/ui/GlmMonochromeIcon.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";

interface PostUpdateReleaseNotesDialogProps {
  payload: PostUpdateReleaseNotesPayload | null;
  onAcknowledge: () => void;
  onOpenExternalUrl?: (url: string) => void;
}

export function PostUpdateReleaseNotesDialog({
  payload,
  onAcknowledge,
  onOpenExternalUrl,
}: PostUpdateReleaseNotesDialogProps) {
  const { intl } = useZCodeIntl();
  // M5 store decoupling: MessageResponse no longer reads the store; theme/code preview arrive via props.
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  const dialogHeading =
    payload?.title?.trim() || intl.formatMessage({ id: "postUpdateReleaseNotes.title" });

  return (
    <Dialog
      open={Boolean(payload)}
      onOpenChange={(open) => {
        if (!open && payload) {
          onAcknowledge();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex w-full max-w-2xl max-h-[min(90vh,42rem)] flex-col gap-0 overflow-hidden rounded-2xl p-0"
        data-testid="post-update-release-notes-dialog"
      >
        <div className="flex flex-col px-8 py-6">
          <div className="flex min-w-0 shrink-0 items-center gap-2.5">
            <GlmMonochromeIcon className="size-5 shrink-0" alt="ZCode" />
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-lg leading-snug tracking-tight text-foreground">
                {dialogHeading}
              </DialogTitle>
            </div>
          </div>

          <div className="py-4">
            <div className="max-h-[min(52vh,26rem)] overflow-y-auto rounded-xl border border-border bg-surface px-4 py-4">
              {payload ? (
                <MessageResponse
                  className={cn(
                    "prose prose-sm max-w-none text-foreground dark:prose-invert",
                    // Default typography headings run large; step down via prose-h* so # / ## never dominate the changelog.
                    "prose-headings:font-semibold prose-headings:tracking-tight",
                    "prose-h1:text-lg prose-h2:text-ui-lg prose-h3:text-ui-base prose-h4:text-ui-base prose-h5:text-ui-base prose-h6:text-ui-base",
                  )}
                  theme={theme}
                  codePreviewSettings={codePreviewSettings}
                  onOpenExternalUrl={onOpenExternalUrl}
                >
                  {payload.markdown}
                </MessageResponse>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 justify-end pt-2">
            <Button type="button" size="lg" className="h-10 min-w-0 px-5" onClick={onAcknowledge}>
              {intl.formatMessage({ id: "postUpdateReleaseNotes.acknowledge" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
