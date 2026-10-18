// Shared status dot: tone maps color, spinning uses the rotating loader. Reused across settings
// (McpServerList connection state, Computer Use permission/helper state) for one dot style and palette.
import { CircleIcon, Loader2Icon } from "lucide-react";

export type StatusDotTone = "green" | "amber" | "red" | "muted" | "subtle";

const TONE_CLASS: Record<StatusDotTone, string> = {
  green: "text-green-500",
  amber: "text-yellow-500",
  red: "text-red-500",
  muted: "text-muted-foreground",
  subtle: "text-foreground-subtle",
};

export function StatusDot({ tone, spinning }: { tone: StatusDotTone; spinning?: boolean }) {
  const color = TONE_CLASS[tone];
  if (spinning) {
    return <Loader2Icon className={`size-3 animate-spin ${color}`} />;
  }
  return <CircleIcon className={`size-2 fill-current ${color}`} />;
}
