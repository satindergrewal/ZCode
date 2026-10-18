import { useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/components/lib/utils.js";
import { Command, CommandEmpty, CommandItem, CommandList } from "@/components/ui/command.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { shouldIgnoreRemoteConnectionHistoryPopoverInteractOutside } from "@/remote-connection/remoteConnectionHistoryPopover.js";

function matchesSuggestion(value: string, query: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return true;
  }

  return normalizedValue.includes(normalizedQuery);
}

export function RemoteConnectionHistoryInput({
  containerClassName,
  suggestionWidth,
  label,
  placeholder,
  value,
  suggestions,
  emptyText,
  onChange,
  ...inputProps
}: {
  containerClassName?: string;
  suggestionWidth?: string;
  label?: string;
  placeholder: string;
  value: string;
  suggestions: string[];
  emptyText: string;
  onChange: (value: string) => void;
} & Omit<
  ComponentProps<typeof Input>,
  "children" | "onChange" | "placeholder" | "size" | "value"
>) {
  const [open, setOpen] = useState(false);
  const [filterWithCurrentValue, setFilterWithCurrentValue] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const keepInputFocusOnOpenRef = useRef(false);
  const suppressOpenUntilRef = useRef(0);
  const skipNextBlurRef = useRef(false);

  const filteredSuggestions = useMemo(() => {
    if (!filterWithCurrentValue) {
      return suggestions;
    }

    return suggestions.filter((item) => matchesSuggestion(item, value));
  }, [filterWithCurrentValue, suggestions, value]);

  const requestOpenFromInput = useCallback(
    (options?: { resetFilter?: boolean }) => {
      if (Date.now() < suppressOpenUntilRef.current || suggestions.length === 0) {
        return;
      }

      if (options?.resetFilter !== false) {
        setFilterWithCurrentValue(false);
      }

      keepInputFocusOnOpenRef.current = true;
      setOpen(true);
    },
    [suggestions.length],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      return;
    }

    keepInputFocusOnOpenRef.current = false;
    setFilterWithCurrentValue(false);
    if (skipNextBlurRef.current) {
      skipNextBlurRef.current = false;
    }
  }, []);

  return (
    <div ref={containerRef} className={cn("w-full", containerClassName)}>
      {label ? (
        <label className="mb-1 block text-ui-base text-foreground-subtle">{label}</label>
      ) : null}
      <Popover open={open && suggestions.length > 0} onOpenChange={handleOpenChange}>
        <PopoverAnchor asChild>
          <Input
            ref={inputRef}
            size="lg"
            placeholder={placeholder}
            value={value}
            onFocus={() => requestOpenFromInput()}
            onClick={() => requestOpenFromInput()}
            onChange={(event) => {
              onChange(event.target.value);
              setFilterWithCurrentValue(true);
              requestOpenFromInput({ resetFilter: false });
            }}
            autoComplete="off"
            {...inputProps}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-menu p-1 shadow-lg"
          style={{
            width: suggestionWidth ?? "var(--radix-popover-trigger-width)",
          }}
          onInteractOutside={(event) => {
            const targetNode = event.target;
            if (
              shouldIgnoreRemoteConnectionHistoryPopoverInteractOutside({
                isTargetInsideContainer:
                  targetNode instanceof Node && containerRef.current?.contains(targetNode) === true,
              })
            ) {
              // The first click focuses the input, which opens the suggestions; the same click then
              // reads as an outside click to the Popover and instantly closes it. Exclude
              // interactions originating in this input container to avoid the double-flash on
              // first focus.
              event.preventDefault();
            }
          }}
          onOpenAutoFocus={(event) => {
            // Popover steals focus into the layer by default; once the input blurs, users cannot
            // keep typing the filter while reading history. When opened from the input, suppress
            // the autofocus and keep focus in the input so both browsing and typing work.
            if (!keepInputFocusOnOpenRef.current) {
              return;
            }

            event.preventDefault();
            inputRef.current?.focus();
            keepInputFocusOnOpenRef.current = false;
          }}
        >
          <Command className="rounded-lg bg-transparent p-0 text-foreground">
            <CommandList className="max-h-56 scroll-py-1">
              {filteredSuggestions.length === 0 ? (
                <CommandEmpty className="px-3 py-5 text-ui-base text-foreground-subtle">
                  {emptyText}
                </CommandEmpty>
              ) : (
                filteredSuggestions.map((item) => (
                  <CommandItem
                    key={item}
                    value={item}
                    className="min-h-8 rounded-lg px-3 py-1.5 text-ui-base text-foreground data-selected:bg-menu-hover data-selected:text-foreground"
                    onPointerDown={() => {
                      skipNextBlurRef.current = true;
                    }}
                    onSelect={(selected) => {
                      onChange(selected);
                      setFilterWithCurrentValue(false);
                      // After selecting a history item, the input's click/focus replays and the
                      // layer reopens instantly. A short suppression window masks that echo.
                      suppressOpenUntilRef.current = Date.now() + 120;
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">{item}</span>
                  </CommandItem>
                ))
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
