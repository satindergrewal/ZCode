import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export function ExecuteCommand({ command }: { command: string | undefined }) {
  const { intl } = useZCodeIntl();
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = content.current;
    if (!element || expanded) return;
    // The raw command area only clamps height and truncates; there is no way to read the full text. Measure real line wraps to survive narrow panes and font changes.
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [command, expanded]);

  return (
    <div className="min-w-0 flex-1 grid grid-cols-[1ch_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono">
      <div
        id={id}
        ref={content}
        data-testid="execute-command"
        tabIndex={expanded ? 0 : undefined}
        // The stock scrollbar is limited by the card's 16px right padding; extend 12px right and restore the body gutter so the scrollbar sits 4px from the inner edge.
        className={`col-span-2 -mr-3 pr-3 min-w-0 leading-5 ${expanded ? "max-h-[10lh] overflow-y-auto" : "max-h-[3lh] overflow-hidden"}`}
      >
        {/* The start marker used to live outside the scroll container and stayed visible mid-scroll; share the viewport with the body to keep first-line semantics. */}
        <div className="flex items-start gap-2">
          <span data-testid="execute-command-prompt" className="shrink-0 text-foreground-subtle">
            $
          </span>
          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words">{command}</pre>
        </div>
      </div>
      {overflowing || expanded ? (
        <Button
          data-command-preview-toggle
          type="button"
          variant="link"
          size="default"
          // Drop the base button's horizontal padding and border slot so the text aligns with the command body.
          className="col-start-2 justify-self-start border-0 px-0 font-sans text-ui-sm font-normal text-foreground-subtle focus-visible:underline"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => {
            if (content.current) content.current.scrollTop = 0;
            setExpanded(!expanded);
            logger.debug("Execute command preview toggled", { expanded: !expanded });
          }}
        >
          {intl.formatMessage({
            id: expanded
              ? "chat.toolCall.execute.collapseCommand"
              : "chat.toolCall.execute.expandCommand",
          })}
          <ChevronDownIcon
            aria-hidden="true"
            className={`size-3 ${expanded ? "rotate-180" : ""}`}
          />
        </Button>
      ) : null}
    </div>
  );
}
