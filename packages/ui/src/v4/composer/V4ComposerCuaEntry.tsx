/**
 * Always-present CUA input entry button.
 *
 * Pure presentation: every state decision lives in useCuaComposerEntry /
 * cuaComposerEntryState; this only enforces invisible-means-unrendered and maps view to DOM.
 * Visual weight intentionally matches the other toolbar controls, so an unavailable state
 * never suggests install-and-go.
 */
import { memo } from "react";
import { MonitorCogIcon } from "lucide-react";
import { TID_V4_COMPOSER_CUA_ENTRY } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  supportsLocalMacCuaPermissionOnboarding,
  supportsLocalWindowsCuaEntry,
} from "@/lib/cuaPlatform.js";
import {
  useCuaComposerEntry,
  type UseCuaComposerEntryParams,
} from "@/hooks/useCuaComposerEntry.js";

export type V4ComposerCuaEntryProps = UseCuaComposerEntryParams;

/**
 * Platform gate, outermost: when the platform is unsupported (or the host provides no
 * platform/services context at all) even the inner layer never mounts.
 *
 * Two reasons for the split:
 * 1. Semantics - invisible means zero background cost. Failing the platform gate establishes
 *    no settings subscription, no plugin store read, no permission polling; stricter than
 *    check-then-null inside.
 * 2. Robustness - the composer renders in hosts without PlatformProvider/ServiceProvider
 *    (including existing component tests). The inner usePlatform/useServices throw without
 *    providers and would take the whole composer down; the optional variants here degrade
 *    silently to unrendered.
 */
function V4ComposerCuaEntryImpl(props: V4ComposerCuaEntryProps) {
  const platform = useOptionalPlatform();
  const services = useOptionalServices();
  const platformSupported =
    platform !== null &&
    services !== null &&
    (supportsLocalMacCuaPermissionOnboarding(platform) || supportsLocalWindowsCuaEntry(platform));
  if (!platformSupported) return null;
  return <V4ComposerCuaEntryMounted {...props} />;
}

function V4ComposerCuaEntryMounted(props: V4ComposerCuaEntryProps) {
  const { intl } = useZCodeIntl();
  const { view, onActivate } = useCuaComposerEntry(props);
  const label = intl.formatMessage({ id: "chat.toolbar.computerUse.label" });

  // The remaining three visibility gates (hidden in settings / missing mac service / computer-use disabled) -> no DOM.
  if (!view.visible) return null;
  const tooltip = intl.formatMessage({ id: view.tooltipMessageId });

  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="default"
        data-testid={TID_V4_COMPOSER_CUA_ENTRY}
        data-composer-collapse-priority="0"
        // e2e/diagnostic anchor: outward UI state plus disable reason, so tests never infer from color classes.
        data-cua-state={view.uiState}
        data-cua-interaction-disabled={view.interactionDisabled ? "true" : "false"}
        aria-label={label}
        // aria-disabled reflects only temporarily-inoperable (session-busy) - the sole state with
        // no click action. Ready/error/enabling are status indications, not disabled buttons;
        // marking them disabled too would make screen readers call a ready entry unavailable.
        // The busy state uses aria-disabled + click short-circuit instead of native disabled,
        // since native disabled kills hover in most browsers and hides the session-in-progress
        // explanation.
        aria-disabled={view.interactionDisabled || undefined}
        onClick={view.clickAction === "open-settings" ? onActivate : undefined}
        className={
          "group/cua h-7 w-fit justify-center gap-1 rounded-lg px-1.5 py-1.5 text-ui-base data-[composer-compact=true]:size-7 data-[composer-compact=true]:gap-0 data-[composer-compact=true]:p-0 " +
          (view.interactionDisabled ? "opacity-50" : "")
        }
      >
        <MonitorCogIcon className="size-4 shrink-0" aria-hidden />
        <span
          className="inline-flex whitespace-nowrap group-data-[composer-compact=true]/cua:hidden"
          data-cua-label
        >
          {label}
        </span>
        {/* M7: the status dot was removed by product decision - the entry carries no status
            display; readings live in settings (which on-demand starts the Helper and reads
            truth). */}
      </Button>
    </ControlHintTooltip>
  );
}

export const V4ComposerCuaEntry = memo(V4ComposerCuaEntryImpl);
