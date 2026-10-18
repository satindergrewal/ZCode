import { useState } from "react";
import { Smartphone } from "lucide-react";
import type { WebRemoteControlStatus } from "@zcode/shared";
import {
  buildWebRemoteControlEntryViewTelemetry,
  parseRemoteWorkspaceIdentity,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useWebRemoteControlStatus } from "@/hooks/useWebRemoteControlStatus.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { WebRemoteControlDialog } from "@/WebRemoteControlDialog.js";
import { useWebRemoteControlFeatureEnabled } from "@/WebRemoteControlFeatureProvider.js";

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

export function getWebRemoteControlTriggerPresentation(
  status: Pick<WebRemoteControlStatus, "status" | "mobileConnected">,
  formatMessage: FormatMessage,
): { iconClassName: string; tooltip: string } {
  if (status.status === "error") {
    return {
      iconClassName: "text-destructive",
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.error" }),
    };
  }

  if (status.status === "active") {
    // Bugfix: on relay reconnect main may drop status to starting/running while
    // mobileConnected keeps the old pairing. The button shows connected only when active,
    // matching the post-open connecting copy.
    return {
      iconClassName: "text-success",
      tooltip: formatMessage({
        id: "webRemoteControl.triggerStatus.connected",
      }),
    };
  }

  if (status.status === "starting") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({
        id: "webRemoteControl.triggerStatus.starting",
      }),
    };
  }

  if (status.status === "connecting") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({
        id: "webRemoteControl.triggerStatus.connecting",
      }),
    };
  }

  if (status.status === "running") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.waiting" }),
    };
  }

  return {
    iconClassName: "text-foreground-subtle",
    tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.idle" }),
  };
}

export function WorkspaceWebRemoteControlTrigger({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  compact?: boolean;
  className?: string;
}) {
  const enabled = useWebRemoteControlFeatureEnabled();

  // Bugfix: hidden-by-default builds still ran session hooks, dragging in TabStoreProvider
  // and throwing during static render. Check the store-free feature provider first.
  if (!enabled) {
    return null;
  }

  return (
    <WorkspaceWebRemoteControlTriggerContent
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId}
      initialTaskId={initialTaskId}
      compact={compact}
      className={className}
    />
  );
}

function WorkspaceWebRemoteControlTriggerContent({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  compact?: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const mappedRemoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  // Fix: a tab's remoteSessionId goes stale across reconnects; the remote path carries
  // identity+session and stale pairs build wrong endpoints. Use only the
  // identity-validated live session; otherwise the dialog stays remote-waiting.
  const currentRemoteSessionId = mappedRemoteSessionId ?? undefined;
  const [webRemoteControlOpen, setWebRemoteControlOpen] = useState(false);
  const remoteControlStatus = useWebRemoteControlStatus();
  const triggerPresentation = getWebRemoteControlTriggerPresentation(
    remoteControlStatus,
    intl.formatMessage,
  );

  return (
    <>
      <ControlHintTooltip
        title={intl.formatMessage({ id: "webRemoteControl.trigger" })}
        description={triggerPresentation.tooltip}
        side="top"
        align="center"
        triggerClassName={compact ? undefined : "w-full"}
      >
        <Button
          variant="ghost"
          onClick={() => {
            if (platform) {
              void reportAppTelemetryEvent(
                platform,
                buildWebRemoteControlEntryViewTelemetry({
                  workspaceKind:
                    workspaceIdentity?.trim() || currentRemoteSessionId ? "remote" : "local",
                  remoteKind: workspaceIdentity
                    ? parseRemoteWorkspaceIdentity(workspaceIdentity)?.kind
                    : undefined,
                }),
                "web-remote-control-entry",
              );
            }
            logger.info("[WorkspaceWebRemoteControlTrigger] web remote dialog opened", {
              workspacePath,
              workspaceIdentity: workspaceIdentity ?? "none",
              remoteSessionId: currentRemoteSessionId ?? "none",
              initialTaskId: initialTaskId ?? "none",
            });
            setWebRemoteControlOpen(true);
          }}
          size={compact ? "icon-lg" : "lg"}
          aria-label={intl.formatMessage({ id: "webRemoteControl.trigger" })}
          className={cn(
            compact
              ? "text-foreground hover:bg-surface-hover hover:text-foreground"
              : "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
            className,
          )}
        >
          {/* Bugfix: a static phone icon said nothing about connectivity.
              Poll results drive semantic colors; name and state share one tooltip
              so footer and button never toast twice. */}
          <Smartphone className={cn("size-4", triggerPresentation.iconClassName)} />
          {compact ? (
            <span className="sr-only">
              {intl.formatMessage({ id: "webRemoteControl.trigger" })}
            </span>
          ) : (
            intl.formatMessage({ id: "webRemoteControl.trigger" })
          )}
        </Button>
      </ControlHintTooltip>
      <WebRemoteControlDialog
        open={webRemoteControlOpen}
        onOpenChange={setWebRemoteControlOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        remoteSessionId={currentRemoteSessionId}
        initialTaskId={initialTaskId}
      />
    </>
  );
}
