import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ProviderModelDraftCommitResult } from "@/settings/model-provider-section/ProviderModelMetadata.js";

type ErrorField = Extract<ProviderModelDraftCommitResult, { status: "invalid" }>["field"];
const ERROR_TARGETS: Partial<Record<ErrorField, string>> = {
  maxOutputTokens: "[data-model-max-output] input",
  reasoningLevelValues: "[data-model-reasoning-level-editor] :is(input, button)",
  reasoningLevelMap: "[data-model-json-slot] textarea",
  inputFormat: '[data-model-input-modality="image"]',
};

export function ModelEditorAdvanced({
  open,
  errorField,
  validationAttempt,
  children,
}: {
  open: boolean;
  errorField?: ErrorField | null;
  validationAttempt: number;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const ref = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!open) {
      setExpanded(false);
      return;
    }
    // Error anchors move with layout: max output lives in basics; reasoning level and mapping need expanding to fix.
    if (errorField && errorField !== "maxOutputTokens" && ERROR_TARGETS[errorField]) {
      setExpanded(true);
    }
  }, [open, errorField, validationAttempt]);
  useEffect(() => {
    const selector = errorField && ERROR_TARGETS[errorField];
    if (!open || !selector || (errorField !== "maxOutputTokens" && !expanded)) return;
    const target = ref.current
      ?.closest("[data-model-settings-scroll]")
      ?.querySelector<HTMLElement>(selector);
    let cancelled = false;
    // Focus after the expand animation, never scrolling to a still-clipped input; no guessed delays.
    const animations = ref.current?.getAnimations({ subtree: true }) ?? [];
    void Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {
      if (!cancelled) target?.focus();
    });
    return () => {
      cancelled = true;
    };
  }, [open, expanded, errorField, validationAttempt]);
  return (
    <div ref={ref} data-model-advanced="true">
      <button
        type="button"
        data-model-advanced-trigger="true"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-fit cursor-pointer items-center gap-2 rounded-sm bg-transparent px-2 py-1 text-ui-base text-foreground hover:bg-hover focus-visible:outline-2 focus-visible:outline-primary"
      >
        <ChevronRightIcon
          className={`size-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        {intl.formatMessage({ id: "settings.modelProvider.advancedConfig" })}
      </button>
      {/* {/* Keep controls mounted to preserve the reasoning editor's draft; collapsed, exit keyboard and screen-reader flow. */}
      <div
        id={contentId}
        inert={!expanded}
        aria-hidden={!expanded}
        className={`-mx-1 grid transition-[grid-template-rows,opacity,visibility] duration-200 motion-reduce:transition-none ${expanded ? "visible grid-rows-[1fr] opacity-100" : "invisible grid-rows-[0fr] opacity-0"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-4 px-1 pt-4 pb-1">{children}</div>
        </div>
      </div>
    </div>
  );
}
