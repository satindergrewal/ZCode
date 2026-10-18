import { PuzzleIcon } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenPluginUiSideTabRequest } from "@/plugin-ui/contract.js";
import {
  resolvePluginUiSurfaceTitle,
  usePluginUiSurfaces,
} from "@/plugin-ui/adapters/usePluginUiSurfaces.js";

export interface PluginUiLauncherItemsProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** Real session id; null while drafting, which hides the entry (panes are session-scoped, v1 no drafts). */
  sessionId: string | null;
  onOpenPluginUi: (request: OpenPluginUiSideTabRequest) => void;
  /** The menu reuses standard items; the empty page keeps the entry-button look. */
  variant?: "launcher" | "menu";
  itemClassName?: string;
}

export function buildPluginUiLauncherItemId(pluginId: string, surfaceId: string): string {
  return `plugin-ui:${pluginId}/${surfaceId}`;
}

/**
 * Plugin pane entries inside Open tabs, sharing list/grid with built-ins.
 * The old group wrapper ate a grid cell, cramming plugins into one column; a Fragment lets buttons join the parent layout.
 */
export function PluginUiLauncherItems(props: PluginUiLauncherItemsProps) {
  const { locale } = useZCodeIntl();
  const surfaces = usePluginUiSurfaces({
    workspacePath: props.workspacePath,
    ...(props.workspaceIdentity ? { workspaceIdentity: props.workspaceIdentity } : {}),
    enabled: props.sessionId !== null,
  });
  if (props.sessionId === null || surfaces.length === 0) return null;
  const sessionId = props.sessionId;
  return (
    <>
      {surfaces.map((surface) => {
        const title = resolvePluginUiSurfaceTitle(surface.title, locale) || surface.id;
        const itemId = buildPluginUiLauncherItemId(surface.pluginId, surface.id);
        const open = () =>
          props.onOpenPluginUi({
            parentSessionId: sessionId,
            surfaceId: surface.id,
            serverName: surface.server,
            pluginId: surface.pluginId,
            resourceUri: surface.resourceUri,
            title,
            workspacePath: props.workspacePath,
            ...(props.workspaceIdentity ? { workspaceIdentity: props.workspaceIdentity } : {}),
            remoteSessionId: props.remoteSessionId ?? null,
          });
        if (props.variant === "menu") {
          return (
            <DropdownMenuItem key={itemId} data-side-pane-add-item={itemId} onSelect={open}>
              <PuzzleIcon className="size-4 text-foreground-subtle" />
              <span className="min-w-0 truncate">{title}</span>
            </DropdownMenuItem>
          );
        }
        return (
          <button
            key={itemId}
            type="button"
            data-side-pane-open-tab-item={itemId}
            className={props.itemClassName}
            onClick={open}
          >
            <PuzzleIcon className="size-4 text-foreground-subtle" />
            <span className="side-pane-open-tab-button-label min-w-0 flex-1 truncate text-left">
              {title}
            </span>
            <span className="truncate text-ui-sm text-foreground-subtlest">
              {surface.pluginName}
            </span>
          </button>
        );
      })}
    </>
  );
}
