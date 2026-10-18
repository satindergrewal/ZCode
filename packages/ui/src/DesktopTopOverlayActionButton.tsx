import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

interface DesktopTopOverlayActionButtonProps {
  title: string;
  ariaLabel: string;
  children: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
  side?: ComponentProps<typeof ControlHintTooltip>["side"];
  buttonClassName?: string;
  testId?: string;
}

export function DesktopTopOverlayActionButton({
  title,
  ariaLabel,
  children,
  shortcut,
  disabled,
  onClick,
  onMouseEnter,
  side = "bottom",
  buttonClassName,
  testId,
}: DesktopTopOverlayActionButtonProps) {
  return (
    <ControlHintTooltip title={title} shortcut={shortcut} side={side}>
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        // The base Button defaults to transition-all, which would animate size/position while the
        // window resizes — on Windows the button appears to reset then catch up. Overlay buttons
        // only need the hover color transition.
        className={cn("[app-region:no-drag] transition-colors", buttonClassName)}
        data-testid={testId}
        aria-label={ariaLabel}
        disabled={disabled}
        // The new-task entry reuses a business function with an optional provider argument.
        // Handing it straight to React onClick passes the MouseEvent as the provider and throws
        // during log IPC cloning. Always drop the DOM event and call the no-arg action.
        onClick={() => onClick()}
        onMouseEnter={onMouseEnter}
      >
        {children}
      </Button>
    </ControlHintTooltip>
  );
}
