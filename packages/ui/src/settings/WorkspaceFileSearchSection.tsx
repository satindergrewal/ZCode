import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, RotateCcw, Save, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { logger } from "@/logger.js";

interface WorkspaceFileSearchSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
}

type IgnoreFileState = {
  content: string;
  source: "file" | "template";
};

/**
 * Editor for workspace file-search ignore rules (.zcodeignore).
 * The rule file is the single source of truth for directory exclusion: saving takes effect
 * immediately (the next scan reads the new content). "Sync from .gitignore" and "Restore defaults"
 * are section-scoped operations: each rewrites only its own marked section (gitignore sync block /
 * default exclusions), leaving user rules untouched; the result fills the editor and still needs
 * an explicit save to persist.
 */
export function WorkspaceFileSearchSection({
  workspacePath,
  workspaceIdentity,
}: WorkspaceFileSearchSectionProps) {
  // Without a workspace, hint immediately and skip the workspace service-resolution hook chain
  // (same layering precedent as SessionPluginReferenceIconBoundary), avoiding needless
  // services/tabStore context dependencies.
  if (!workspacePath) {
    return <NoWorkspaceFileSearchHint />;
  }
  return (
    <ActiveWorkspaceFileSearchEditor
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
    />
  );
}

function NoWorkspaceFileSearchHint() {
  const { intl } = useZCodeIntl();
  return (
    <p className="text-ui-base leading-6 text-foreground-subtle">
      {intl.formatMessage({ id: "settings.workspaceFileSearch.noWorkspace" })}
    </p>
  );
}

function ActiveWorkspaceFileSearchEditor({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const resolution = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;

  const [loaded, setLoaded] = useState<IgnoreFileState | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const loadVersionRef = useRef(0);

  const load = useCallback(async () => {
    if (!workspacePath || !rpcReady) {
      return;
    }
    const version = loadVersionRef.current + 1;
    loadVersionRef.current = version;
    setLoading(true);
    try {
      const result = await services.fileService.readWorkspaceFileSearchIgnore({
        rootPath: workspacePath,
      });
      if (loadVersionRef.current !== version) {
        return;
      }
      setLoaded({ content: result.content, source: result.source });
      setDraft(result.content);
    } catch (error) {
      if (loadVersionRef.current !== version) {
        return;
      }
      logger.warn("[WorkspaceFileSearchSection] Failed to read .zcodeignore", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.workspaceFileSearch.loadFailed" }));
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [intl, rpcReady, services, workspacePath]);

  // Section-scoped operation: rewrite only the matching marked section (sync-gitignore rewrites the
  // gitignore sync block; reset-defaults resets the default exclusions), leaving user rules
  // untouched; the result fills the editor and persists only on save.
  const applyTransform = useCallback(
    async (transform: "sync-gitignore" | "reset-defaults") => {
      if (!workspacePath || !rpcReady) {
        return;
      }
      const version = loadVersionRef.current + 1;
      loadVersionRef.current = version;
      try {
        const result = await services.fileService.applyWorkspaceFileSearchIgnoreTransform({
          rootPath: workspacePath,
          transform,
        });
        if (loadVersionRef.current !== version) {
          return;
        }
        // Update the editor content only; `loaded` stays untouched, so dirty follows from the content diff.
        setDraft(result.content);
      } catch (error) {
        if (loadVersionRef.current !== version) {
          return;
        }
        logger.warn("[WorkspaceFileSearchSection] Failed to apply .zcodeignore section operation", {
          transform,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.workspaceFileSearch.transformFailed" }));
      }
    },
    [intl, rpcReady, services, workspacePath],
  );

  useEffect(() => {
    if (!workspacePath || !rpcReady) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoaded(null);
    setDraft("");
    void load();
    // `load` depends on workspace/services; reset first, then fetch, when the workspace switches.
  }, [load, rpcReady, workspacePath]);

  const handleSave = useCallback(async () => {
    if (!workspacePath) {
      return;
    }
    setSaving(true);
    try {
      await services.fileService.writeWorkspaceFileSearchIgnore({
        rootPath: workspacePath,
        content: draft,
      });
      setLoaded({ content: draft, source: "file" });
      toast(intl.formatMessage({ id: "settings.workspaceFileSearch.saved" }));
    } catch (error) {
      logger.warn("[WorkspaceFileSearchSection] Failed to save .zcodeignore", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.workspaceFileSearch.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [draft, intl, services, workspacePath]);

  // Save means "persist the editor content": in the template state (.zcodeignore not created yet),
  // saving is allowed even without edits, otherwise a first-time user could never create the file
  // without changing something; only the persisted state is gated on "changed content".
  const canSave = loaded === null || loaded.source === "template" || draft !== loaded.content;
  // The "unsaved changes" hint reflects a real diff only (hidden for an unedited template state).
  const dirty = loaded !== null && loaded.source === "file" && draft !== loaded.content;

  // "Reveal in file manager": .zcodeignore lives at the workspace root, so revealing the root
  // directory is the location (same directory argument precedent as WindowsCaptionMenuButton /
  // ModelTrajectoryPane). Remote workspaces keep the rule file on the remote machine where the
  // local file manager cannot open it, so the button is hidden.
  const isLocalWorkspace = !workspaceIdentity?.trim();
  const revealTargetReady = loaded?.source === "file";
  const handleReveal = useCallback(async () => {
    const result = await platform.openInFileManager(workspacePath);
    if (!result.success) {
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    }
  }, [intl, platform, workspacePath]);

  return (
    // Layout follows the settings-page standard: intro line plus a SettingsGroupCard;
    // text stays text-ui-base, and the textarea keeps a monospace font since its content is rule text.
    <div className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.workspaceFileSearch.description" })}
      </div>
      <SettingsGroupCard>
        <div className="space-y-3 px-4 py-3">
          {loaded?.source === "template" ? (
            <div className="text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({ id: "settings.workspaceFileSearch.templateHint" })}
            </div>
          ) : null}
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Save shortcut: Ctrl/Cmd+S in the editor equals clicking Save (preventDefault
              // suppresses the browser default); gating matches the button (canSave).
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (canSave && !saving && !loading) {
                  void handleSave();
                }
              }
            }}
            spellCheck={false}
            disabled={loading || saving}
            className="min-h-64 w-full font-mono text-ui-base"
            aria-label={intl.formatMessage({ id: "settings.workspaceFileSearch.editorLabel" })}
            data-testid="workspace-file-search-ignore-editor"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              disabled={!canSave || saving || loading}
              onClick={() => void handleSave()}
              data-testid="workspace-file-search-ignore-save"
            >
              <Save className="size-4" />
              {intl.formatMessage({ id: "settings.workspaceFileSearch.save" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || saving}
              onClick={() => void applyTransform("sync-gitignore")}
              data-testid="workspace-file-search-ignore-resync"
            >
              <RotateCcw className="size-4" />
              {intl.formatMessage({ id: "settings.workspaceFileSearch.resync" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || saving}
              onClick={() => void applyTransform("reset-defaults")}
              data-testid="workspace-file-search-ignore-restore-defaults"
            >
              <Undo2 className="size-4" />
              {intl.formatMessage({ id: "settings.workspaceFileSearch.restoreDefaults" })}
            </Button>
            {isLocalWorkspace ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!revealTargetReady || loading || saving}
                title={
                  revealTargetReady
                    ? undefined
                    : intl.formatMessage({ id: "settings.workspaceFileSearch.revealHint" })
                }
                onClick={() => void handleReveal()}
                data-testid="workspace-file-search-ignore-reveal"
              >
                <FolderOpen className="size-4" />
                {intl.formatMessage({ id: "settings.workspaceFileSearch.reveal" })}
              </Button>
            ) : null}
            {dirty ? (
              <span className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.workspaceFileSearch.unsaved" })}
              </span>
            ) : null}
          </div>
        </div>
      </SettingsGroupCard>
    </div>
  );
}
