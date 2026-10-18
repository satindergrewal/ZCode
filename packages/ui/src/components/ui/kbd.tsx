import { cn } from "@/components/lib/utils.js";

/**
 * Key cap (mirrors shadcn Kbd): each key is its own chip with fixed height, minimum
 * square width, and flex centering, so symbol keys (cmd/shift) match letter keys
 * optically; font-sans keeps glyphs from the monospace fallback off-balance (labels come
 * from the platform formatter, see shortcuts/label.ts).
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 select-none items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-ui-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** Key-combo container: lays out a combo's keys in a row (gap-1), e.g. cmd + K. */
function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
