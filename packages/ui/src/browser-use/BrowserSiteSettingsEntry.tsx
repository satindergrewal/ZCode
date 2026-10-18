import { useState } from "react";
import { Settings, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Site settings entry left of the omnibox (docs/browser-use/2026-10-08-embedded-browser-permission-governance-spec.md
 * site permissions tab). Always the sliders icon; click opens the site bubble whose
 * only action, Permissions, opens that tab. Hidden while the URL is edited;
 * never settles pending prompts.
 */
export function BrowserSiteSettingsEntry({
  origin,
  onOpenSettings,
}: {
  origin: string;
  onOpenSettings?: (origin: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id: `browser.permission.${id}` });
  // Bug: dialog content portals to body while the trigger lives in the browser tab's TabsContent.
  // Opening settings activates that tab and display:none's the browser tab (forceMount),
  // so during the 100ms exit window the floating anchor collapses to the corner.
  // Controlled open + unmount on close (no exit animation) keeps
  // dialog-gone and tab-switch in the same frame.
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className="rounded-full"
          aria-label={t("siteInfo")}
          title={t("siteInfo")}
          data-testid="browser-permission-trigger"
        >
          <SlidersHorizontal />
        </Button>
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          align="start"
          collisionPadding={12}
          className="w-80 max-w-[calc(100vw-24px)] gap-4 p-4"
          data-testid="browser-permission-popover"
        >
          <div
            className="min-w-0 flex-1 text-ui-lg font-medium break-words"
            data-testid="browser-permission-origin"
          >
            {origin}
          </div>
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            disabled={!onOpenSettings}
            data-testid="browser-permission-open-settings"
            onClick={() => {
              setOpen(false);
              onOpenSettings?.(origin);
            }}
          >
            <Settings className="size-4" />
            {t("settings")}
          </Button>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
