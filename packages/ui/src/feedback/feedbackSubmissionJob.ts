/* eslint-disable max-lines -- the background submission state machine owns create/screenshots/log upload/cancel/fallback in one place; this pass fixes the 413/fetch regression without widening the surface. */
import type { CreateFeedbackTicketInput, FeedbackAttachmentKind } from "@zcode/shared";
import type { FeedbackUploadProgress, IFeedbackService } from "@zcode/services";
import type { FeedbackSubmitDraft } from "@/feedback/feedbackStore.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

export interface FeedbackSubmissionAttachmentDraft {
  filename: string;
  contentType: string;
  dataBase64: string;
  size: number;
}

export interface FeedbackSubmissionProgressState {
  kind?: "working" | "uploading-log" | "paused-log" | "success";
  label: string;
  detail?: string;
  progress?: number;
  uploadedBytes?: number;
  totalBytes?: number;
  indeterminate?: boolean;
}

export interface FeedbackSubmissionCopy {
  connectingLabel: string;
  connectingDetail: string;
  cancelingCreateLabel: string;
  cancelingCreateDetail: string;
  canceledLabel: string;
  canceledDetail: string;
  uploadingScreenshotLabel: string;
  submittedLabel: string;
  submittedDetail: string;
  failedLabel: string;
  networkErrorDetail: string;
  postCreateNetworkErrorDetail: string;
  pausingLogLabel: string;
  pausingLogDetail: string;
  exportingLogLabel: string;
  exportingLogDetail: string;
  uploadingLogLabel: string;
  logUploadSuccessLabel: string;
  logUploadPausedLabel: string;
  logUploadPausedDetail: string;
  preparingUploadDetail: string;
}

export type FeedbackSubmissionJobStatus = "running" | "paused-log" | "success" | "error";

export interface FeedbackSubmissionJobState {
  id: string;
  status: FeedbackSubmissionJobStatus;
  progress: FeedbackSubmissionProgressState;
  ticketId?: string;
  error?: string;
}

export interface FeedbackSubmissionJob {
  readonly id: string;
  /** User form snapshot taken at submit time, used to reopen the matching feedback by jobId. */
  readonly formDraft: FeedbackSubmitDraft;
  readonly done: Promise<{ ticketId: string }>;
  getState: () => FeedbackSubmissionJobState;
  subscribe: (listener: (state: FeedbackSubmissionJobState) => void) => { dispose: () => void };
  cancelSubmission: () => Promise<void>;
  cancelActiveUpload: () => Promise<void>;
  continueLogUpload: () => void;
}

export interface FeedbackSubmissionJobSnapshot extends FeedbackSubmissionJobState {
  job: FeedbackSubmissionJob;
}

export interface StartFeedbackSubmissionJobOptions {
  feedbackService: IFeedbackService;
  ticketInput: CreateFeedbackTicketInput;
  screenshots: FeedbackSubmissionAttachmentDraft[];
  includeLogs: boolean;
  formDraft: FeedbackSubmitDraft;
  copy?: FeedbackSubmissionCopy;
  onTicketCreated?: (ticketId: string) => void;
  onCompleted?: (ticketId: string) => void;
  onError?: (message: string) => void;
}

type LogUploadAction = "continue";

const DEFAULT_SUBMISSION_COPY: FeedbackSubmissionCopy = {
  connectingLabel: "Connecting to the feedback service",
  connectingDetail: "Screenshots and logs upload after the ticket is created",
  cancelingCreateLabel: "Cancelling submission",
  cancelingCreateDetail: "Cancel received; stopping the ticket creation.",
  canceledLabel: "Feedback submission cancelled",
  canceledDetail: "Feedback submission cancelled",
  uploadingScreenshotLabel: "Uploading screenshot",
  submittedLabel: "Feedback submitted",
  submittedDetail: "We will get to it soon.",
  failedLabel: "Feedback submission failed",
  networkErrorDetail:
    "Cannot reach the feedback service. Check network, VPN, or proxy settings and retry.",
  postCreateNetworkErrorDetail:
    "Feedback created, but follow-up uploads failed. Open the created ticket to attach materials; do not submit again.",
  pausingLogLabel: "Pausing log upload",
  pausingLogDetail: "Cancel received; one moment.",
  exportingLogLabel: "Exporting full logs",
  exportingLogDetail: "May take seconds depending on local log size",
  uploadingLogLabel: "Uploading full logs",
  logUploadSuccessLabel: "Logs uploaded",
  logUploadPausedLabel: "Log upload paused",
  logUploadPausedDetail: "Logs are required to diagnose the issue; please continue the upload.",
  preparingUploadDetail: "Preparing upload",
};

let nextJobSeq = 0;
const submissionJobs = new Map<string, FeedbackSubmissionJob>();
const globalListeners = new Set<(jobs: FeedbackSubmissionJobSnapshot[]) => void>();

function getSubmissionJobSnapshots(): FeedbackSubmissionJobSnapshot[] {
  return Array.from(submissionJobs.values()).map((job) => ({
    ...job.getState(),
    job,
  }));
}

function notifySubmissionJobSnapshots() {
  const snapshot = getSubmissionJobSnapshots();
  for (const listener of globalListeners) {
    listener(snapshot);
  }
}

export function getFeedbackSubmissionJobsSnapshot(): FeedbackSubmissionJobSnapshot[] {
  return getSubmissionJobSnapshots();
}

export function subscribeFeedbackSubmissionJobs(
  listener: (jobs: FeedbackSubmissionJobSnapshot[]) => void,
): { dispose: () => void } {
  globalListeners.add(listener);
  listener(getSubmissionJobSnapshots());
  return {
    dispose: () => {
      globalListeners.delete(listener);
    },
  };
}

export function dismissFeedbackSubmissionJob(jobId: string): void {
  const job = submissionJobs.get(jobId);
  // paused-log waits for the user to continue the upload. Dropping the job from the global map
  // here would hang waitForLogUploadAction forever: archive cleanup and final state never advance.
  if (job?.getState().status === "paused-log") {
    return;
  }
  if (submissionJobs.delete(jobId)) {
    notifySubmissionJobSnapshots();
  }
}

export function getFeedbackSubmissionJob(jobId: string): FeedbackSubmissionJob | null {
  return submissionJobs.get(jobId) ?? null;
}

export async function cancelFeedbackCreateSubmissionJob(
  job: FeedbackSubmissionJob,
  options: { onCancelError?: (message: string) => void } = {},
): Promise<boolean> {
  const state = job.getState();
  if (state.status !== "running" || state.ticketId) {
    return false;
  }
  try {
    await job.cancelSubmission();
    dismissFeedbackSubmissionJob(job.id);
    return true;
  } catch (error) {
    const message = getErrorMessage(error);
    // cancelCreate is a cross-RPC host command. On host disconnect or call failure, neither leak
    // the fire-and-forget rejection globally nor hide the background job as if cancel succeeded.
    logger.warn("[FeedbackSubmissionJob] Failed to cancel feedback creation command", {
      jobId: job.id,
      error: message,
    });
    options.onCancelError?.(message);
    return false;
  }
}

export function startFeedbackSubmissionJob(
  options: StartFeedbackSubmissionJobOptions,
): FeedbackSubmissionJob {
  const copy = options.copy ?? DEFAULT_SUBMISSION_COPY;
  const jobSeq = nextJobSeq++;
  const now = Date.now();
  const jobId = `feedback-submit-${now}-${jobSeq}`;
  const createOperationId = `feedback-create-${now}-${jobSeq}`;
  // The backend ticket description already mixes in diagnostics and cannot restore the user's
  // original input. Each background job must copy its own form snapshot at start, or concurrent
  // feedback submissions overwrite each other.
  const formDraft = createFeedbackSubmitDraftSnapshot(options.formDraft);
  const listeners = new Set<(state: FeedbackSubmissionJobState) => void>();
  let state: FeedbackSubmissionJobState = {
    id: jobId,
    status: "running",
    progress: {
      kind: "working",
      label: copy.connectingLabel,
      detail: copy.connectingDetail,
      indeterminate: true,
    },
  };
  let activeUploadProgressId: string | null = null;
  let resolveLogUploadAction: ((action: LogUploadAction) => void) | null = null;
  let cancelRequested = false;
  let cancelNotified = false;

  function setState(patch: Partial<FeedbackSubmissionJobState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
    notifySubmissionJobSnapshots();
  }

  function setProgress(progress: FeedbackSubmissionProgressState) {
    setState({ progress });
  }

  function markCreateCanceled() {
    if (cancelNotified) return;
    cancelNotified = true;
    setState({
      status: "error",
      error: copy.canceledDetail,
      progress: {
        kind: "working",
        label: copy.canceledLabel,
        detail: copy.canceledDetail,
        indeterminate: false,
      },
    });
    options.onError?.(copy.canceledDetail);
  }

  async function run(): Promise<{ ticketId: string }> {
    try {
      logger.info("[FeedbackSubmissionJob] Background feedback submission started", { jobId });
      const ticket = await options.feedbackService.create(options.ticketInput, {
        operationId: createOperationId,
      });
      if (cancelRequested) {
        // User clicks win cancellation. Even if the backend returns a ticket later, do not revive
        // the old submission job or keep uploading attachments, or cancel would look ignored.
        throw new FeedbackSubmissionCanceledError(copy.canceledDetail);
      }
      setState({ status: "running", ticketId: ticket.id, error: undefined });
      // Once the ticket is created the foreground dialog can collapse; screenshots and logs keep
      // uploading via the background job.
      options.onTicketCreated?.(ticket.id);

      const failedScreenshots: string[] = [];
      for (const [index, screenshot] of options.screenshots.entries()) {
        try {
          setProgress({
            kind: "working",
            label: copy.uploadingScreenshotLabel,
            detail: `${index + 1}/${options.screenshots.length} · ${formatBytes(screenshot.size)}`,
            indeterminate: true,
          });
          await options.feedbackService.uploadAttachmentData(ticket.id, "image", {
            dataBase64: screenshot.dataBase64,
            filename: screenshot.filename,
            contentType: screenshot.contentType,
          });
        } catch (screenshotError) {
          failedScreenshots.push(`${screenshot.filename}: ${getErrorMessage(screenshotError)}`);
        }
      }

      if (failedScreenshots.length > 0) {
        await options.feedbackService
          .comment(
            ticket.id,
            `System note: some screenshots failed to upload: ${failedScreenshots.join("; ")}`,
          )
          .catch(() => undefined);
      }

      if (options.includeLogs) {
        await uploadLogsUntilComplete(options.feedbackService, ticket.id, copy, {
          setState,
          setProgress,
          getActiveProgressId: () => activeUploadProgressId,
          setActiveProgressId: (id) => {
            activeUploadProgressId = id;
          },
          waitForLogUploadAction: () =>
            new Promise<LogUploadAction>((resolve) => {
              resolveLogUploadAction = resolve;
            }),
        });
      }

      setState({
        status: "success",
        ticketId: ticket.id,
        progress: {
          kind: "success",
          label: copy.submittedLabel,
          detail: copy.submittedDetail,
          progress: 100,
        },
      });
      options.onCompleted?.(ticket.id);
      logger.info("[FeedbackSubmissionJob] Background feedback submission finished", {
        jobId,
        ticketId: ticket.id,
      });
      return { ticketId: ticket.id };
    } catch (error) {
      if (
        !state.ticketId &&
        (cancelRequested || error instanceof FeedbackSubmissionCanceledError)
      ) {
        markCreateCanceled();
        logger.info("[FeedbackSubmissionJob] Feedback submission cancelled", { jobId });
        throw new FeedbackSubmissionCanceledError(copy.canceledDetail);
      }
      const rawMessage = getErrorMessage(error);
      // RPC surfaces only Node fetch's top-level message; connection errors degrade to
      // "fetch failed". Users need actionable network hints; the raw error stays in logs.
      const message = getFeedbackSubmissionErrorMessage(rawMessage, copy, {
        ticketCreated: Boolean(state.ticketId),
      });
      setState({
        status: "error",
        error: message,
        progress: {
          kind: "working",
          label: copy.failedLabel,
          detail: message,
          indeterminate: false,
        },
      });
      options.onError?.(message);
      logger.warn("[FeedbackSubmissionJob] Background feedback submission failed", {
        jobId,
        error: rawMessage,
        displayError: message,
      });
      throw error;
    } finally {
      activeUploadProgressId = null;
      resolveLogUploadAction = null;
    }
  }

  const done = run();
  // Feedback log upload is a long-running host-service task; it must not die with the submit
  // dialog. The job lives in a module closure and keeps running; the foreground component only
  // subscribes to state. Closing the corner dialog removes a subscriber, never cancels the upload.
  const job: FeedbackSubmissionJob = {
    id: jobId,
    formDraft,
    done,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    cancelActiveUpload: async () => {
      const progressId = activeUploadProgressId;
      if (!progressId) return;
      setProgress({
        kind: "working",
        label: copy.pausingLogLabel,
        detail: copy.pausingLogDetail,
        indeterminate: true,
      });
      await options.feedbackService.cancelUpload(progressId);
    },
    cancelSubmission: async () => {
      if (state.status !== "running" && state.status !== "paused-log") return;
      cancelRequested = true;
      if (!state.ticketId) {
        const previousProgress = state.progress;
        setProgress({
          kind: "working",
          label: copy.cancelingCreateLabel,
          detail: copy.cancelingCreateDetail,
          indeterminate: true,
        });
        try {
          await options.feedbackService.cancelCreate(createOperationId);
        } catch (error) {
          if (!cancelNotified && !state.ticketId) {
            setProgress(previousProgress);
          }
          throw error;
        }
        markCreateCanceled();
        return;
      }
      await job.cancelActiveUpload();
    },
    continueLogUpload: () => {
      resolveLogUploadAction?.("continue");
      resolveLogUploadAction = null;
    },
  };
  submissionJobs.set(job.id, job);
  notifySubmissionJobSnapshots();
  return job;
}

function createFeedbackSubmitDraftSnapshot(draft: FeedbackSubmitDraft): FeedbackSubmitDraft {
  const screenshots = draft.screenshots
    ? Object.freeze(draft.screenshots.map((screenshot) => Object.freeze({ ...screenshot })))
    : undefined;
  // The job is read by both the global card and the dialog; freeze the copied snapshot so no
  // subscriber's edits to description/attachments pollute the same background task's restore data.
  return Object.freeze({
    ...draft,
    ...(screenshots ? { screenshots } : {}),
  });
}

function getFeedbackSubmissionErrorMessage(
  rawMessage: string,
  copy: FeedbackSubmissionCopy,
  options: { ticketCreated: boolean },
): string {
  if (
    /^(?:fetch failed|failed to fetch|network request failed)$/i.test(rawMessage) ||
    /^request timed out after \d+ms$/i.test(rawMessage) ||
    /connect timeout error/i.test(rawMessage)
  ) {
    return options.ticketCreated ? copy.postCreateNetworkErrorDetail : copy.networkErrorDetail;
  }
  return rawMessage;
}

class FeedbackSubmissionCanceledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackSubmissionCanceledError";
  }
}

async function uploadLogsUntilComplete(
  feedbackService: IFeedbackService,
  ticketId: string,
  copy: FeedbackSubmissionCopy,
  callbacks: {
    setState: (patch: Partial<FeedbackSubmissionJobState>) => void;
    setProgress: (progress: FeedbackSubmissionProgressState) => void;
    getActiveProgressId: () => string | null;
    setActiveProgressId: (id: string | null) => void;
    waitForLogUploadAction: () => Promise<LogUploadAction>;
  },
): Promise<void> {
  let archive: { path: string; size: number } | null = null;
  const progressId = `feedback-log-${ticketId}-${Date.now()}`;
  // Full logs zip locally first; an indeterminate progress bar would read as an instant export.
  const progressSubscription = feedbackService.onDynamicUploadProgress(progressId)((progress) => {
    callbacks.setProgress(formatUploadProgress(progress, copy));
  });
  try {
    callbacks.setActiveProgressId(progressId);
    callbacks.setProgress({
      kind: "working",
      label: copy.exportingLogLabel,
      detail: copy.exportingLogDetail,
      indeterminate: true,
    });
    archive = await feedbackService.prepareCompactLogArchive({ full: true, progressId });
    let shouldRetryLogUpload = true;
    while (shouldRetryLogUpload) {
      try {
        callbacks.setActiveProgressId(progressId);
        callbacks.setProgress({
          kind: "uploading-log",
          label: copy.uploadingLogLabel,
          detail: `0 / ${formatBytes(archive.size)}`,
          progress: 0,
          uploadedBytes: 0,
          totalBytes: archive.size,
        });
        await feedbackService.uploadAttachmentWithProgress(
          ticketId,
          "log" satisfies FeedbackAttachmentKind,
          {
            path: archive.path,
            contentType: "application/zip",
          },
          progressId,
        );
        shouldRetryLogUpload = false;
        callbacks.setProgress({
          kind: "success",
          label: copy.logUploadSuccessLabel,
          detail: copy.submittedDetail,
          progress: 100,
          uploadedBytes: archive.size,
          totalBytes: archive.size,
        });
      } catch (logUploadError) {
        if (!isUploadCanceledError(logUploadError)) {
          // Full logs are the required diagnostic attachment; a 413/offline auto-upload failure
          // must not downgrade to the compact log and report success, or the team believes it has
          // the full scene while key logs were skipped client-side.
          throw logUploadError;
        }
        callbacks.setActiveProgressId(null);
        callbacks.setState({
          status: "paused-log",
          progress: {
            kind: "paused-log",
            label: copy.logUploadPausedLabel,
            detail: copy.logUploadPausedDetail,
            progress: 0,
            uploadedBytes: 0,
            totalBytes: archive.size,
          },
        });
        await callbacks.waitForLogUploadAction();
        callbacks.setState({ status: "running" });
        shouldRetryLogUpload = true;
      } finally {
        callbacks.setActiveProgressId(null);
      }
    }
  } catch (logError) {
    const message = getErrorMessage(logError);
    await feedbackService
      .comment(
        ticketId,
        `System note: full-log auto upload failed; ask the user to export logs manually if needed. Error: ${message}`,
      )
      .catch(() => undefined);
    // Log upload is part of the submission flow; a non-user-skipped failure must not be swallowed
    // into "submitted", or users think full logs were delivered while the ticket lacks them.
    throw logError;
  } finally {
    if (archive) {
      await feedbackService.cleanupPreparedLogArchive(archive.path).catch(() => undefined);
    }
    callbacks.setActiveProgressId(null);
    progressSubscription.dispose();
  }
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

export function formatUploadProgress(
  progress: FeedbackUploadProgress,
  copy: FeedbackSubmissionCopy = DEFAULT_SUBMISSION_COPY,
): FeedbackSubmissionProgressState {
  const totalBytes = Math.max(progress.totalBytes, 0);
  const uploadedBytes = Math.min(Math.max(progress.uploadedBytes, 0), totalBytes);
  const percent = totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0;
  if (progress.phase === "preparing") {
    return {
      kind: "working",
      label: copy.exportingLogLabel,
      detail:
        totalBytes > 0
          ? `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`
          : copy.exportingLogDetail,
      progress: percent,
      uploadedBytes,
      totalBytes,
    };
  }
  return {
    kind: progress.phase === "complete" ? "success" : "uploading-log",
    label: progress.phase === "complete" ? copy.logUploadSuccessLabel : copy.uploadingLogLabel,
    detail:
      totalBytes > 0
        ? `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`
        : copy.preparingUploadDetail,
    progress: percent,
    uploadedBytes,
    totalBytes,
  };
}

function isUploadCanceledError(error: unknown): boolean {
  return error instanceof Error && error.name === "FeedbackUploadCanceledError";
}
