import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type InputEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/lib/utils.js";

const AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX = 116;
const AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX = 156;

interface AutomationInstructionsComposerProps {
  invalid?: boolean;
  children: ReactNode;
}

/**
 // The unified interaction contract for the Instructions footer triggers.
 // Scheduled and idle forms once maintained expanded state via hover, focus-within and differing radii,
 // so the same feature diverged in pill/square corners and open background across the two automation kinds.
 // Row heights use rem-based utilities so fixed pixels never compress the text box after font-size changes.
 */
export const AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME =
  "h-7 rounded-full text-ui-base font-normal leading-5 text-foreground-subtle hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground";

/**
 // Both automation settings pages use the 14px body size for inputs.
 // The pages once sized title, schedule and Instructions separately, and some hourly branches regressed to 12px.
 */
export const AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME = "text-ui-base leading-5";

/**
 // The Instructions composite input shared by Automations.
 // The textarea carries the standard Input border itself; the parent only supplies the toolbar's surface layer.
 // Geometry, surface layering and the global Input border state converge here; callers pass field state and toolbar content only.
 */
export function AutomationInstructionsComposer({
  invalid = false,
  children,
}: AutomationInstructionsComposerProps) {
  return (
    <div
      data-invalid={invalid || undefined}
      className="flex min-h-39 flex-col overflow-hidden rounded-xl border-0 bg-surface @container/composer"
    >
      {children}
    </div>
  );
}

export function AutomationInstructionsTextarea({
  rows = 5,
  onInput,
  value,
  ...props
}: Omit<ComponentProps<"textarea">, "className" | "ref">) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAutomaticHeightRef = useRef<number | null>(null);
  const resizeToContent = useCallback((textarea: HTMLTextAreaElement) => {
    const currentHeight = Number.parseFloat(textarea.style.height);
    const lastAutomaticHeight = lastAutomaticHeightRef.current;
    const hasManualHeight =
      lastAutomaticHeight !== null &&
      Number.isFinite(currentHeight) &&
      Math.abs(currentHeight - lastAutomaticHeight) > 1;
    const contentHeight = textarea.scrollHeight;

    // Auto-grow rewrote height on every keystroke, instantly destroying a desktop user's dragged height.
    // When manual height differs from the last auto height, only the inner scrolls; never overwrite the user's size.
    if (hasManualHeight) {
      textarea.style.overflowY = contentHeight > currentHeight ? "auto" : "hidden";
      return;
    }

    // Without manual dragging keep auto-grow: short content returns to 116px, about 7 lines capped at 156px;
    // longer content scrolls inside the body area only.
    textarea.style.height = `${AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX}px`;
    const automaticHeight = Math.min(
      Math.max(contentHeight, AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX),
      AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX,
    );
    textarea.style.height = `${automaticHeight}px`;
    lastAutomaticHeightRef.current = automaticHeight;
    textarea.style.overflowY =
      contentHeight > AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    if (textareaRef.current) {
      resizeToContent(textareaRef.current);
    }
  }, [resizeToContent, value]);

  const handleInput = (event: InputEvent<HTMLTextAreaElement>) => {
    resizeToContent(event.currentTarget);
    onInput?.(event);
  };

  return (
    <textarea
      {...props}
      ref={textareaRef}
      value={value}
      rows={rows}
      onInput={handleInput}
      className={cn(
        "h-29 min-h-29 max-h-39 shrink-0 resize-none overflow-y-hidden rounded-xl border border-input-border bg-input p-3 text-foreground outline-none transition-colors placeholder:text-ui-base placeholder:text-foreground-subtlest hover:border-input-border-hover focus:border-input-border-focused focus:bg-input-focused focus:outline-none aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
        AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
      )}
    />
  );
}

export function AutomationInstructionsToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-0 p-1.5 sm:h-10 sm:flex-nowrap">
      {children}
    </div>
  );
}
