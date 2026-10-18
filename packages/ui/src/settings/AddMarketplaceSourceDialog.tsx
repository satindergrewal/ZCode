import { useRef, useState, type DragEvent } from "react";
import { FolderOpen, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";

/**
 // Header New opens the add-marketplace dialog directly, folding in the old AddMarketplacePopover's
 // github/git/URL/local-path (drag-drop and picker) support with zero new backend.
 */
export function AddMarketplaceSourceDialog({
  open,
  onOpenChange,
  onAddMarketplace,
  operationId,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddMarketplace: (source: string) => Promise<boolean>;
  operationId: string | null;
  error?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  // Only desktop can resolve dropped files / pickers into agent-accessible absolute paths; hide those entries on web.
  const canPickPath = platform?.canSelectFilePath ?? false;
  const [source, setSource] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const trimmedSource = source.trim();
  const adding = operationId === `marketplace:add:${trimmedSource}`;
  // IME composition: some platforms flip isComposing false early; the ref backs it up so confirming a candidate cannot misfire submit.
  const compositionActiveRef = useRef(false);
  // Guard double submit: Enter and click share one path across the store-writeback window.
  const pendingRef = useRef(false);

  const handleAdd = async () => {
    if (trimmedSource.length === 0 || pendingRef.current) return;
    pendingRef.current = true;
    try {
      const added = await onAddMarketplace(trimmedSource);
      // On failure keep input and dialog; the user corrects the source per the error above and retries.
      if (added) {
        setSource("");
        onOpenChange(false);
      }
    } finally {
      pendingRef.current = false;
    }
  };

  const handleChooseDirectory = async () => {
    if (!platform) return;
    try {
      const dir = await platform.selectDirectory();
      if (dir) setSource(dir);
    } catch {
      // Stay silent on cancel/dialog error: keep the input, do not break the flow.
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const path = platform?.getPathForFile?.(file)?.trim();
    if (path) setSource(path);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="plugin-store-add-source-dialog"
        className={cn(
          "w-[min(420px,calc(100vw-2rem))] max-w-none transition-colors",
          canPickPath && dragActive ? "border-border-hover bg-surface-hover" : "",
        )}
        onDragOver={
          canPickPath
            ? (event) => {
                event.preventDefault();
                setDragActive(true);
              }
            : undefined
        }
        onDragLeave={
          canPickPath
            ? (event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDragActive(false);
                }
              }
            : undefined
        }
        onDrop={canPickPath ? handleDrop : undefined}
      >
        <DialogTitle className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.plugins.marketplaces.add" })}
        </DialogTitle>
        {error ? (
          <div
            className="max-h-[min(240px,40vh)] min-w-0 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base whitespace-pre-wrap break-words text-destructive"
            data-testid="plugin-store-add-source-error"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        <Input
          type="text"
          data-testid="plugin-store-add-source-input"
          size="lg"
          autoFocus
          aria-label={intl.formatMessage({ id: "settings.plugins.marketplaces.source" })}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          onCompositionStart={() => {
            compositionActiveRef.current = true;
          }}
          onCompositionEnd={() => {
            compositionActiveRef.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            if (
              isImeComposingKeyEvent({
                compositionActive: compositionActiveRef.current,
                nativeEvent: event.nativeEvent,
              })
            ) {
              return;
            }
            event.preventDefault();
            void handleAdd();
          }}
          placeholder={intl.formatMessage({ id: "settings.plugins.marketplaces.source" })}
        />
        {canPickPath ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.plugins.marketplaces.dropHint" })}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          {canPickPath ? (
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => void handleChooseDirectory()}
            >
              <FolderOpen data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.marketplaces.chooseDirectory" })}
            </Button>
          ) : null}
          <Button
            type="button"
            data-testid="plugin-store-add-source-submit"
            variant="default"
            size="lg"
            disabled={trimmedSource.length === 0 || adding}
            onClick={() => void handleAdd()}
          >
            {adding ? (
              <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
            ) : (
              <Plus data-icon="inline-start" aria-hidden="true" />
            )}
            {intl.formatMessage({ id: "settings.plugins.marketplaces.add" })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
