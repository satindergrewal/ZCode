/* oxlint-disable eslint(max-lines) -- The side pane tab trigger centralizes drag, context menu, and per-type icons; this change only adds a Browser residency test attribute, so the existing interactions are not split up for line count. */
import { useRef, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  BotIcon,
  BotMessageSquareIcon,
  BugIcon,
  FileCode2Icon,
  FileDiffIcon,
  MapIcon,
  MessageSquareTextIcon,
  ListTreeIcon,
  NotepadTextIcon,
  PackageIcon,
  PaletteIcon,
  SquareTerminalIcon,
  TerminalIcon,
  WaypointsIcon,
  Workflow as WorkflowIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { TabsTrigger } from "@/components/ui/tabs.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import { Button } from "@/components/ui/button.js";
import { BrowserUseTabIcon } from "@/app-shell/BrowserUseTabIcon.js";
import { BrowserTabFavicon } from "@/app-shell/BrowserTabFavicon.js";
import { SidePaneTabTitleTooltip } from "@/app-shell/SidePaneTabTitleTooltip.js";

// Tabs are equal-width at 156px by default; when space runs short they shrink uniformly to 60px
// under identical grow/shrink, and the outer scroll container takes the overflow so title length
// never changes a tab's width.
// Without a dedicated title cap, long page titles keep widening tabs; both the main tab and the
// drag overlay clamp the title text only, protecting icon, badge, and close button.
export function SortableSidePaneTabTrigger({
  tab,
  title,
  closeTabLabel,
  closeTabMenuLabel,
  closeOtherTabsLabel,
  closeAllTabsLabel,
  diffBadgeLabel,
  isActive,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  canCloseOtherTabs,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  closeTabLabel: string;
  closeTabMenuLabel: string;
  closeOtherTabsLabel: string;
  closeAllTabsLabel: string;
  diffBadgeLabel: string;
  isActive: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  canCloseOtherTabs: boolean;
}) {
  const wasDraggingRef = useRef(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  const normalizedTransform = transform
    ? {
        ...transform,
        // Horizontal tabs are fixed-height controls; dragging allows horizontal movement only.
        // dnd-kit carries scale; clamp it back to 1 so tabs are never squashed or stretched.
        scaleX: 1,
        scaleY: 1,
      }
    : null;
  const style: CSSProperties = {
    transform: CSS.Transform.toString(normalizedTransform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  if (isDragging) {
    wasDraggingRef.current = true;
  }

  const tabTrigger = (
    <TabsTrigger value={tab.id} asChild>
      <div
        ref={setNodeRef}
        data-side-pane-tab-id={tab.id}
        data-browser-tab-residency={"residency" in tab ? tab.residency : undefined}
        data-active={isActive ? "" : undefined}
        data-state={isActive ? "active" : "inactive"}
        style={style}
        {...attributes}
        {...listeners}
        onPointerDown={(event) => {
          listeners?.onPointerDown?.(event);
          // The side pane tab has its own close button, so the outer element must not render as
          // a button -- nested buttons get DOM-corrected in production, misrouting
          // tab/close/drag events. TabsTrigger asChild carries the Radix state while the real
          // DOM stays a div and the close button remains a native button.
          event.preventDefault();
        }}
        onClick={(event) => {
          // Browsers may dispatch both click and auxclick for middle-click; intercept during
          // click so closing never first activates an inactive tab.
          if (event.button === 1) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }

          if (wasDraggingRef.current) {
            wasDraggingRef.current = false;
            event.preventDefault();
            return;
          }

          onActivateTab(tab.id);
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;

          // Side pane tabs previously only had left-click activation and an explicit close
          // button; middle-click triggered the browser's autoscroll and, in some browsers, tab
          // activation too. Cancel the default and close the target tab during auxclick, keeping
          // the active tab unchanged.
          event.preventDefault();
          event.stopPropagation();
          onCloseTab(tab.id);
        }}
        className={cn(
          "group relative inline-flex items-center gap-1",
          "flex-[1_1_9.75rem] !h-7 min-w-15 max-w-39 justify-start overflow-hidden rounded-md border px-1.5 pr-2 text-ui-base font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring",
          "!border-transparent !bg-transparent text-foreground-subtle !rounded-lg",
          "hover:text-foreground",
          !isActive && "hover:!bg-hover",
          // With TabsTrigger asChild wrapped again by ContextMenuTrigger, Radix's active marker
          // does not reliably land on the real tab div. Sync data-active / data-state from the
          // controlled isActive so Tailwind active variants still match.
          "data-active:!bg-selected data-active:text-foreground",
          "cursor-default",
          isDragging && "cursor-grabbing shadow-md",
        )}
      >
        <SidePaneTabItemContent
          tab={tab}
          title={title}
          diffBadgeLabel={diffBadgeLabel}
          closeVisible={isActive}
          revealCloseOnHover
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={closeTabLabel}
          className={cn(
            "absolute right-1 top-1/2 -translate-y-1/2 rounded-md",
            !isActive &&
              "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          )}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCloseTab(tab.id);
          }}
        >
          <XIcon className="size-3" />
        </Button>
      </div>
    </TabsTrigger>
  );

  return (
    <ContextMenu>
      <SidePaneTabTitleTooltip isDragging={isDragging} title={title}>
        <ContextMenuTrigger asChild>{tabTrigger}</ContextMenuTrigger>
      </SidePaneTabTitleTooltip>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={() => onCloseTab(tab.id)}>{closeTabMenuLabel}</ContextMenuItem>
        <ContextMenuItem disabled={!canCloseOtherTabs} onSelect={() => onCloseOtherTabs(tab.id)}>
          {closeOtherTabsLabel}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCloseAllTabs}>{closeAllTabsLabel}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function SidePaneTabDragOverlay({
  tab,
  title,
  diffBadgeLabel,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  diffBadgeLabel: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex !h-7 w-39 min-w-15 max-w-39 items-center justify-start gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-selected px-1.5 pr-1 text-ui-base font-medium text-foreground shadow-md",
        "cursor-grabbing",
      )}
    >
      <SidePaneTabItemContent tab={tab} title={title} diffBadgeLabel={diffBadgeLabel} />
    </div>
  );
}

function SidePaneTabItemContent({
  tab,
  title,
  diffBadgeLabel,
  closeVisible = false,
  revealCloseOnHover = false,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  diffBadgeLabel: string;
  closeVisible?: boolean;
  revealCloseOnHover?: boolean;
}) {
  return (
    <span
      data-side-pane-tab-content=""
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-var(--tab-fade-offset)-0.5rem),transparent_calc(100%-var(--tab-fade-offset)))]",
        closeVisible ? "[--tab-fade-offset:1.25rem]" : "[--tab-fade-offset:0px]",
        revealCloseOnHover &&
          "group-hover:[--tab-fade-offset:1.25rem] group-focus-within:[--tab-fade-offset:1.25rem]",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <SidePaneTabIcon tab={tab} />
      </span>
      <span data-side-pane-tab-title="" className="shrink-0 whitespace-nowrap">
        {title}
      </span>
      {isDiffPreviewTab(tab) ? (
        <span className="ml-0.5 shrink-0 rounded-full border border-border bg-surface px-1 py-0 text-ui-xs leading-3 text-foreground-subtle">
          {diffBadgeLabel}
        </span>
      ) : null}
    </span>
  );
}

function isDiffPreviewTab(tab: WorkspaceSidePaneTab): boolean {
  return (
    tab.type === "code-viewer" &&
    (tab.source.type === "patch" || tab.source.type === "multi-file-diff")
  );
}

export function SidePaneTabIcon({ tab }: { tab: WorkspaceSidePaneTab }) {
  // The plan-detail tab opens from the switch-mode (ExitPlanMode) tool-call card, whose icon is
  // NotepadTextIcon; the tab must match its source so the icon does not jump on click. Not
  // ListChecksIcon: it collides with the status panel's Todo section and reads as todo rather
  // than a plan document.
  if (tab.type === "plan-detail") {
    return <NotepadTextIcon className="size-3.5" />;
  }
  // Same covenant: the source card (CreateWorkflow) uses lucide Workflow, so must the tab.
  if (tab.type === "workflow-run") {
    return <WorkflowIcon className="size-3.5" />;
  }
  // The run directory and a single run's detail must be told apart at a glance (one roster page
  // vs one run), so borrow the subagent directory's "directory" icon -- the two directory pages
  // deliberately look alike on the tab strip; that is their shared nature.
  if (tab.type === "workflow-directory") {
    return <ListTreeIcon className="size-3.5" />;
  }
  // An actor transcript is "one actor's conversation log": neither the whole run (Workflow) nor a
  // subagent session (Bot). All three must be distinguishable at a glance -- their visibility and
  // eviction semantics differ.
  if (tab.type === "workflow-actor-session") {
    return <BotMessageSquareIcon className="size-3.5" />;
  }
  // The script transcript shares the script pill's glyph (terminal): source and tab agree, no
  // jump on open.
  if (tab.type === "workflow-workspace") {
    return <TerminalIcon className="size-3.5" />;
  }
  // A per-kind artifact icon is wrong: the tab-strip icon must be stable before the tab opens
  // (metadata is not read back yet when a tab restores from memory). Use one fixed
  // "deliverable" icon and let the tab's internal header/cards distinguish kind.
  if (tab.type === "workflow-artifact") {
    return <PackageIcon className="size-3.5" />;
  }
  if (tab.type === "selection-side-chat") {
    return <MessageSquareTextIcon className="size-3.5" />;
  }
  if (tab.type === "subagent-session") {
    return <BotIcon className="size-3.5" />;
  }

  if (tab.type === "subagent-directory") {
    return <ListTreeIcon className="size-3.5" />;
  }

  if (tab.type === "browser") {
    return <BrowserTabFavicon faviconUrl={tab.faviconUrl} />;
  }

  if (tab.type === "git") {
    return <FileDiffIcon className="size-3.5" />;
  }

  if (tab.type === "treemapping") {
    return <MapIcon className="size-3.5" />;
  }

  if (tab.type === "whiteboard") {
    return <PaletteIcon className="size-3.5" />;
  }

  if (tab.type === "model-trajectory") {
    return <WaypointsIcon className="size-3.5" />;
  }

  if (tab.type === "developer-tools") {
    return <BugIcon className="size-3.5" />;
  }

  if (tab.type === "terminal" || tab.type === "bash-output") {
    return <SquareTerminalIcon className="size-3.5" />;
  }

  // Same as getSidePaneTabTitle -- a browser-use tab has no source; without this branch control
  // falls through to `tab.source.type` below and crashes reading undefined.type.
  // After agent navigation the <webview> favicon event backfills faviconUrl, showing the real
  // icon exactly like a human browser tab; fall back to the globe icon otherwise
  // (about:blank / not yet resolved).
  if (tab.type === "browser-use") {
    return <BrowserUseTabIcon tab={tab} />;
  }

  if (tab.source.type === "patch") {
    const fileDisplayTarget = getPatchFileDisplayTarget(tab.source);
    if (fileDisplayTarget) {
      const descriptor = resolveFileDisplayDescriptor(fileDisplayTarget);
      return <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />;
    }

    return <FileDiffIcon className="size-3.5" />;
  }

  if (tab.source.type === "multi-file-diff") {
    if (tab.source.path) {
      const descriptor = resolveFileDisplayDescriptor(tab.source.path);
      return <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />;
    }

    return <FileDiffIcon className="size-3.5" />;
  }

  if (tab.source.path) {
    const descriptor = resolveFileDisplayDescriptor(tab.source.path);
    return <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />;
  }

  return <FileCode2Icon className="size-3.5" />;
}

function isUsablePatchFileTarget(target: string | null | undefined): target is string {
  const trimmedTarget = target?.trim();
  return Boolean(trimmedTarget && trimmedTarget !== "/dev/null");
}

function unquoteDiffPath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length >= 2 && trimmedPath.startsWith('"') && trimmedPath.endsWith('"')) {
    return trimmedPath.slice(1, -1);
  }

  return trimmedPath;
}

function stripDiffPathPrefix(path: string): string {
  const unquotedPath = unquoteDiffPath(path);
  if (unquotedPath.startsWith("a/") || unquotedPath.startsWith("b/")) {
    return unquotedPath.slice(2);
  }

  return unquotedPath;
}

function parseDiffHeaderPath(headerValue: string): string | null {
  const trimmedValue = headerValue.trim();
  if (!trimmedValue) {
    return null;
  }

  if (trimmedValue.startsWith('"')) {
    const quotedPathMatch = trimmedValue.match(/^"((?:\\.|[^"\\])+)"/);
    return quotedPathMatch?.[1] ? stripDiffPathPrefix(quotedPathMatch[1]) : null;
  }

  const pathWithoutTimestamp = trimmedValue.split("\t", 1)[0]?.trim();
  return pathWithoutTimestamp ? stripDiffPathPrefix(pathWithoutTimestamp) : null;
}

function parseDiffGitLinePath(line: string): string | null {
  const gitPathMatch = line.match(
    /^diff --git (?:"((?:\\.|[^"\\])*)"|(\S+)) (?:"((?:\\.|[^"\\])*)"|(\S+))$/,
  );
  const nextPath = gitPathMatch?.[3] ?? gitPathMatch?.[4];
  const previousPath = gitPathMatch?.[1] ?? gitPathMatch?.[2];
  const normalizedNextPath = nextPath ? stripDiffPathPrefix(nextPath) : null;
  if (isUsablePatchFileTarget(normalizedNextPath)) {
    return normalizedNextPath;
  }

  const normalizedPreviousPath = previousPath ? stripDiffPathPrefix(previousPath) : null;
  return isUsablePatchFileTarget(normalizedPreviousPath) ? normalizedPreviousPath : null;
}

function getPatchHeaderFileDisplayTarget(patch: string): string | null {
  for (const line of patch.split(/\r?\n/)) {
    const diffGitTarget = parseDiffGitLinePath(line);
    if (diffGitTarget) {
      return diffGitTarget;
    }

    if (line.startsWith("+++ ")) {
      const nextFileTarget = parseDiffHeaderPath(line.slice(4));
      if (isUsablePatchFileTarget(nextFileTarget)) {
        // Some file diff sources carry no path and the title may be just "Diff".
        // Parse the real filename from the unified diff headers and let fileDisplay resolve the
        // file-type icon.
        return nextFileTarget;
      }
    }
  }

  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("--- ")) {
      continue;
    }

    const previousFileTarget = parseDiffHeaderPath(line.slice(4));
    if (isUsablePatchFileTarget(previousFileTarget)) {
      return previousFileTarget;
    }
  }

  return null;
}

function getPatchFileDisplayTarget(source: {
  path?: string;
  title: string;
  patch: string;
}): string | null {
  if (isUsablePatchFileTarget(source.path)) {
    return source.path;
  }

  const patchHeaderTarget = getPatchHeaderFileDisplayTarget(source.patch);
  if (patchHeaderTarget) {
    return patchHeaderTarget;
  }

  // Add/delete diffs sometimes pass /dev/null as source.path.
  // /dev/null is not a business filename and would always resolve to the document icon; fall back
  // to the title only when the path is unusable.
  return isUsablePatchFileTarget(source.title) ? source.title : null;
}

export function getSidePaneTabTitle(
  tab: WorkspaceSidePaneTab,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
): string {
  if (tab.type === "plan-detail") {
    return formatMessage({ id: "planTool.panel.planTab" });
  }
  // The display name is the frozen-at-open fallback; run identity is always the runId (its
  // segment of the tab id).
  if (tab.type === "workflow-run") {
    return tab.workflowName?.trim() || formatMessage({ id: "sidePane.workflowRun" });
  }
  if (tab.type === "workflow-directory") {
    return formatMessage({ id: "sidePane.workflowDirectory" });
  }
  // The instance ordinal must stay in the title: instances of the same lane family share the
  // script's one name, and without the ordinal the tab strip shows two indistinguishable
  // "reviewer" tabs. Concatenate rather than localize -- per the selection-side-chat precedent.
  if (tab.type === "workflow-actor-session") {
    const name = tab.actorName?.trim() || formatMessage({ id: "sidePane.workflowActor" });
    return `${name} #${tab.ordinal}`;
  }
  // The title is the run name (one script transcript per run); the type label "Script steps" lives in the tooltip.
  if (tab.type === "workflow-workspace") {
    return tab.workflowName?.trim() || formatMessage({ id: "sidePane.workflowScript" });
  }
  // The display name is the frozen-at-open fallback; artifact identity is always
  // (runId, artifactId) (those two segments of the tab id).
  if (tab.type === "workflow-artifact") {
    return (
      tab.title?.trim() || tab.artifactId || formatMessage({ id: "sidePane.workflowArtifact" })
    );
  }
  if (tab.type === "selection-side-chat") {
    return `${formatMessage({ id: "sidePane.selectionChat" })} ${tab.ordinal}`;
  }
  if (tab.type === "subagent-session") {
    return tab.title?.trim() || formatMessage({ id: "sidePane.subagent" });
  }

  if (tab.type === "subagent-directory") {
    return formatMessage({ id: "sidePane.subagentDirectory" });
  }

  if (tab.type === "browser") {
    const pageTitle = tab.title?.trim();
    return pageTitle || formatMessage({ id: "browser.title" });
  }

  if (tab.type === "git") {
    return formatMessage({ id: "sidePane.review" });
  }

  if (tab.type === "treemapping") {
    return formatMessage({ id: "treemapping.title" });
  }

  if (tab.type === "whiteboard") {
    return tab.title || formatMessage({ id: "whiteboard.title" });
  }

  if (tab.type === "model-trajectory") {
    return tab.title?.trim() || formatMessage({ id: "modelTrajectory.title" });
  }

  if (tab.type === "developer-tools") {
    return formatMessage({ id: "developerTools.title" });
  }

  if (tab.type === "terminal" || tab.type === "bash-output") {
    return tab.title || formatMessage({ id: "terminal.title" });
  }

  // browser-use tabs were not dispatched here and fell through to the bottom
  // `tab.source.title`, but browser-use tabs have no source field -> reading undefined.title
  // crashed React (the whole workspace subtree died). Use the page title (backfilled by getState
  // after agent navigation); fall back to the browser.title copy.
  if (tab.type === "browser-use") {
    return tab.title?.trim() || formatMessage({ id: "browser.title" });
  }

  return tab.source.title || formatMessage({ id: "codeViewer.title" });
}
