import type { ZCodeInteractionRequestOrigin } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function InteractionRequestOriginBadge({
  className,
  origin,
}: {
  className?: string;
  origin?: ZCodeInteractionRequestOrigin;
}) {
  const { intl } = useZCodeIntl();
  if (origin?.kind !== "subagent") {
    return null;
  }

  // description names the asking subagent (<name> (<siteId>@<ordinal>),
  // docs/dynamic-workflow/launch.md); badge truncates, tooltip carries the rest.
  const description = origin.description?.trim();
  const label = description
    ? intl.formatMessage({ id: "chat.interactionOrigin.subagent.named" }, { description })
    : intl.formatMessage({ id: "chat.interactionOrigin.subagent" });
  const title = !origin.agentType
    ? label
    : description
      ? intl.formatMessage(
          { id: "chat.interactionOrigin.subagent.titleNamed" },
          { agentType: origin.agentType, description },
        )
      : intl.formatMessage(
          { id: "chat.interactionOrigin.subagent.title" },
          { agentType: origin.agentType },
        );

  return (
    <Badge
      variant="outline"
      title={title}
      data-interaction-origin-badge="subagent"
      className={cn("max-w-40 align-baseline text-ui-base truncate", className)}
    >
      {label}
    </Badge>
  );
}
