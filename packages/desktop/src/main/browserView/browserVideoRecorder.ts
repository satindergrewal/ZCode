import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserRecordingArtifact, BrowserViewportSize } from "@zcode/shared";

export interface BrowserWebmRecorderFactoryInput {
  outputPath: string;
  targetFrame: unknown;
  viewport: BrowserViewportSize;
  fps: number;
  signal: AbortSignal;
}

export interface BrowserWebmRecorderSession {
  /** Stop the Chromium MediaRecorder and wait for the final WebM chunk to be safely written. */
  stop(): Promise<void>;
  /** Abort the recording and close renderer/stream/file handles; must be idempotent. */
  cancel(): Promise<void>;
}

export type BrowserWebmRecorderFactory = (
  input: BrowserWebmRecorderFactoryInput,
) => Promise<BrowserWebmRecorderSession>;

function abortError(message = "Browser recording cancelled"): DOMException {
  return new DOMException(message, "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

/**
 * Orchestrate one IAB WebM recording. Media capabilities are injected by Desktop main;
 * this pure orchestration layer avoids depending on Electron so failure cleanup and the
 * artifact contract stay testable, and Service/Host never reference Runtime implementations.
 */
export async function recordBrowserVideo(input: {
  targetFrame: unknown;
  tempRoot: string;
  recordingId: string;
  viewport: BrowserViewportSize;
  fps: number;
  signal: AbortSignal;
  executeScenario(): Promise<void>;
  onPhase?(phase: "capturing" | "finalizing"): void;
  onCaptureComplete?(): void;
  createRecorder: BrowserWebmRecorderFactory;
  now?: () => number;
}): Promise<BrowserRecordingArtifact> {
  const outputPath = join(input.tempRoot, `${input.recordingId}.webm`);
  const now = input.now ?? Date.now;
  let recorder: BrowserWebmRecorderSession | undefined;
  let completed = false;

  try {
    throwIfAborted(input.signal);
    recorder = await input.createRecorder({
      outputPath,
      targetFrame: input.targetFrame,
      viewport: input.viewport,
      fps: input.fps,
      signal: input.signal,
    });
    throwIfAborted(input.signal);

    const captureStartedAt = now();
    input.onPhase?.("capturing");
    await input.executeScenario();
    throwIfAborted(input.signal);
    const durationMs = Math.max(0, Math.round(now() - captureStartedAt));

    // Framing is done: release the background surface watchdog first, then wait for the recorder to flush its tail chunk.
    input.onCaptureComplete?.();
    input.onPhase?.("finalizing");
    await recorder.stop();
    throwIfAborted(input.signal);

    const artifactStat = await stat(outputPath);
    if (!artifactStat.isFile() || artifactStat.size === 0) {
      throw new Error("Browser recording produced an empty WebM artifact");
    }
    completed = true;
    return {
      path: outputPath,
      mimeType: "video/webm",
      width: input.viewport.width,
      height: input.viewport.height,
      fps: input.fps,
      durationMs,
      frameCount: Math.max(1, Math.round((durationMs / 1_000) * input.fps)),
    };
  } finally {
    if (!completed) {
      // If MediaRecorder failed or a scenario action threw, the leftover EBML header looks
      // like a video but is unplayable; close the recorder and delete the partial file so
      // status never reports a fake artifact.
      await recorder?.cancel().catch(() => undefined);
      await rm(outputPath, { force: true }).catch(() => undefined);
    }
  }
}
