import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitBranchMutationResult,
  GitLocalBranchListResult,
  GitRepositorySummary,
} from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  buildGitBranchAutoCommitMessage,
  getPrimaryGitBranchIssue,
  resolveGitBranchIssueMessageId,
  resolveGitBranchSuccessMessageId,
  summarizeGitBranchIssuePaths,
} from "@/git-branch-switcher/display.js";
import {
  buildGitBranchSwitchAssistState,
  formatGitBranchIssuePathList,
  hasGitCommitIdentity,
  type GitBranchSwitchAssistDialogStep,
  type GitBranchSwitchAssistState,
} from "@/git-branch-switcher/switchAssist.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

interface UseGitBranchSwitcherOptions {
  workspacePath: string;
  // gitSummary is the source of truth for HEAD (fed back live by the file watcher). Its
  // current branch/HEAD type is passed in to discard possibly stale local branch snapshots
  // whenever the underlying HEAD changes.
  currentBranchName: string | null;
  headRefType: GitRepositorySummary["headRefType"];
  onRefreshGit: () => void;
}

export function useGitBranchSwitcher({
  workspacePath,
  currentBranchName,
  headRefType,
  onRefreshGit,
}: UseGitBranchSwitcherOptions) {
  const { gitService } = useServices();
  const { intl, locale } = useZCodeIntl();
  const numberFormatter = new Intl.NumberFormat(locale);
  const [open, setOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [switchAssistStep, setSwitchAssistStep] = useState<GitBranchSwitchAssistDialogStep | null>(
    null,
  );
  const [switchAssistState, setSwitchAssistState] = useState<GitBranchSwitchAssistState | null>(
    null,
  );
  const [branchesResult, setBranchesResult] = useState<GitLocalBranchListResult | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);

  const resetSwitchAssistState = useCallback(() => {
    setSwitchAssistStep(null);
    setSwitchAssistState(null);
    setCommitMessage("");
    setCommitError(null);
  }, []);

  const loadBranches = useCallback(async () => {
    setLoadingBranches(true);

    try {
      const nextResult = await gitService.getLocalBranches({ workspacePath });
      setBranchesResult(nextResult);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] Failed to load local branches", {
        workspacePath,
        error: message,
      });
      toast(
        intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
      );
    } finally {
      setLoadingBranches(false);
    }
  }, [gitService, intl, workspacePath]);

  useEffect(() => {
    setOpen(false);
    setCreateDialogOpen(false);
    setCreateBranchName("");
    setBranchesResult(null);
    resetSwitchAssistState();
  }, [resetSwitchAssistState, workspacePath]);

  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    // Key behavior: as soon as gitSummary's HEAD changes (external branch switch, live
    // watcher feedback), drop the local branch snapshot cached when the dropdown last opened
    // so the footer branch label falls back to gitSummary.branchName. Otherwise a stale
    // branchesResult.currentBranchName masks the real branch and switching "does nothing".
    // Note: this only resets local UI state -- no refresh/RPC -- to avoid re-introducing a
    // refresh<->watcher feedback loop.
    if (openRef.current) {
      // While open, the live list is shown; clearing it would flicker. The next open
      // refetches via loadBranches.
      return;
    }
    setBranchesResult(null);
  }, [currentBranchName, headRefType]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // Key behavior: refetch the branch list on every open so a successful switch never
    // reuses the snapshot from the previous open.
    void loadBranches();
  }, [loadBranches, open]);

  const notifyMutationFailure = useCallback(
    (result: GitBranchMutationResult) => {
      const issue = getPrimaryGitBranchIssue(result.issues);
      const messageId = resolveGitBranchIssueMessageId(issue);
      if (!issue) {
        toast(intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }));
        return;
      }

      if (messageId) {
        const { visiblePaths, remainingCount } = summarizeGitBranchIssuePaths(issue.paths);
        const extraPaths =
          remainingCount > 0
            ? intl.formatMessage(
                { id: "git.branchSwitcher.error.moreFiles" },
                { count: numberFormatter.format(remainingCount) },
              )
            : "";
        toast(
          intl.formatMessage(
            { id: messageId },
            {
              branchName: issue.detail ?? result.branchName ?? "",
              paths: formatGitBranchIssuePathList(locale, visiblePaths),
              extraPaths,
            },
          ),
        );
        return;
      }

      const fallbackMessage = issue.detail?.trim() || issue.message.trim();
      toast(
        fallbackMessage.length > 0
          ? fallbackMessage
          : intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }),
      );
    },
    [intl, locale, numberFormatter],
  );

  const prepareSwitchAssistState = useCallback(
    async (result: GitBranchMutationResult): Promise<boolean> => {
      const nextSwitchAssistState = await buildGitBranchSwitchAssistState({
        gitService,
        workspacePath,
        result,
      });
      if (!nextSwitchAssistState) {
        return false;
      }

      // Key behavior: overwrite-style blocks no longer toast directly; they convert to a
      // "failure card -> commit -> auto-retry switch" flow so the user sees the affected
      // files first and decides whether to commit and continue.
      setOpen(false);
      setCreateDialogOpen(false);
      setCommitError(null);
      setCommitMessage("");
      setSwitchAssistState(nextSwitchAssistState);
      setSwitchAssistStep("blocked");
      return true;
    },
    [gitService, workspacePath],
  );

  const handleMutationResult = useCallback(
    async (result: GitBranchMutationResult, actionLabel: string) => {
      if (!result.ok) {
        logger.warn("[GitBranchSwitcher] Branch mutation blocked", {
          workspacePath,
          action: result.action,
          branchName: result.branchName,
          issues: result.issues.map((issue) => issue.code),
        });
        if (await prepareSwitchAssistState(result)) {
          return;
        }
        notifyMutationFailure(result);
        return;
      }

      const successMessageId = resolveGitBranchSuccessMessageId(result);
      if (successMessageId && result.branchName) {
        toast(intl.formatMessage({ id: successMessageId }, { branchName: result.branchName }));
      }

      logger.info(`[GitBranchSwitcher] ${actionLabel} succeeded`, {
        workspacePath,
        branchName: result.branchName,
        action: result.action,
        didChange: result.didChange,
        created: result.created,
      });

      setOpen(false);
      setCreateDialogOpen(false);
      setCreateBranchName("");
      resetSwitchAssistState();
      setBranchesResult((current) =>
        current
          ? {
              ...current,
              currentBranchName: result.summary.branchName,
              headRefType: result.summary.headRefType,
              branches: current.branches.map((branch) => ({
                ...branch,
                isCurrent:
                  result.summary.branchName !== null && branch.name === result.summary.branchName,
              })),
            }
          : current,
      );
      // Key behavior: refresh global git state only when the branch actually changed.
      // No-op switches to the current branch are success results, but there is no reason to
      // trigger another refetch.
      if (result.didChange || result.created) {
        onRefreshGit();
      }
    },
    [
      intl,
      notifyMutationFailure,
      onRefreshGit,
      prepareSwitchAssistState,
      resetSwitchAssistState,
      workspacePath,
    ],
  );

  const switchBranch = useCallback(
    async (targetBranchName: string) => {
      setOpen(false);
      setMutationPending(true);

      try {
        const result = await gitService.switchBranch({
          workspacePath,
          targetBranchName,
        });
        await handleMutationResult(result, "Switch branch");
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitBranchSwitcher] Switch branch request failed", {
          workspacePath,
          targetBranchName,
          error: message,
        });
        toast(
          intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
        );
      } finally {
        setMutationPending(false);
      }
    },
    [gitService, handleMutationResult, intl, workspacePath],
  );

  const createBranchAndSwitch = useCallback(async () => {
    const branchName = createBranchName.trim();
    if (branchName.length === 0) {
      toast(intl.formatMessage({ id: "git.branchSwitcher.error.invalidBranchName" }));
      return;
    }

    setMutationPending(true);

    try {
      const result = await gitService.createBranchAndSwitch({
        workspacePath,
        branchName,
      });
      await handleMutationResult(result, "Create and switch branch");
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] Create-and-switch request failed", {
        workspacePath,
        branchName,
        error: message,
      });
      toast(
        intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
      );
    } finally {
      setMutationPending(false);
    }
  }, [createBranchName, gitService, handleMutationResult, intl, workspacePath]);

  const openSwitchCommitDialog = useCallback(() => {
    setCommitError(null);
    setSwitchAssistStep("commit");
  }, []);

  const closeSwitchAssistDialog = useCallback(() => {
    resetSwitchAssistState();
  }, [resetSwitchAssistState]);

  const commitAndSwitchBranch = useCallback(async () => {
    if (!switchAssistState) {
      return;
    }

    if (!hasGitCommitIdentity(switchAssistState.identity)) {
      setCommitError(
        intl.formatMessage({
          id: "git.branchSwitcher.commitDialog.identityMissing",
        }),
      );
      return;
    }

    const nextCommitMessage =
      commitMessage.trim() || buildGitBranchAutoCommitMessage(switchAssistState.targetBranchName);

    setCommitError(null);
    setMutationPending(true);

    try {
      logger.info("[GitBranchSwitcher] Committing and retrying branch switch", {
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
        stagedPathCount: switchAssistState.stagePaths.length,
      });

      if (switchAssistState.stagePaths.length > 0) {
        await gitService.stagePaths({
          workspacePath,
          paths: switchAssistState.stagePaths,
        });
      }
      await gitService.commit({
        workspacePath,
        message: nextCommitMessage,
      });
      onRefreshGit();

      const result = await gitService.switchBranch({
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
      });
      await handleMutationResult(result, "Switch branch after commit");
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] Commit-and-switch failed", {
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
        error: message,
      });
      setCommitError(
        intl.formatMessage(
          { id: "git.branchSwitcher.commitDialog.error.requestFailed" },
          { error: message },
        ),
      );
    } finally {
      setMutationPending(false);
    }
  }, [
    commitMessage,
    gitService,
    handleMutationResult,
    intl,
    onRefreshGit,
    switchAssistState,
    workspacePath,
  ]);

  return {
    open,
    setOpen,
    createDialogOpen,
    setCreateDialogOpen,
    createBranchName,
    setCreateBranchName,
    commitMessage,
    setCommitMessage,
    commitError,
    switchAssistStep,
    switchAssistState,
    branchesResult,
    loadingBranches,
    mutationPending,
    switchBranch,
    createBranchAndSwitch,
    openSwitchCommitDialog,
    closeSwitchAssistDialog,
    commitAndSwitchBranch,
  };
}
