import { z } from "zod";
import { browserErrorCodeSchema, browserPageStateSchema } from "./commands.js";
import { browserViewportSizeSchema } from "./command-metadata.js";
import { browserBackendTypeSchema } from "./backend.js";
import { browserSnapshotSchema, browserSnapshotElementSchema } from "./snapshot.js";

/**
 * Controlled-tab summary (list result): the agent addresses a tab by tabId (human-opened ones included).
 */
export const browserTabSummarySchema = z
  .object({
    tabId: z.string(),
    url: z.string(),
    title: z.string(),
    /// The guest's real CSS viewport; mandatory on both normal and free-size.
    viewport: browserViewportSizeSchema,
    /**
     * The most recently visible/active in-app tab main-side. Lets the agent, after a user edits the URL,
     * bind and read the current page instead of misreading the session default.
     */
    active: z.boolean().optional(),
    lifecycle: z.enum(["active", "deliverable", "handoff"]).optional(),
  })
  .strict();
export type BrowserTabSummary = z.infer<typeof browserTabSummarySchema>;

/** A user IAB tab not yet claimed by this browser session; plain tab commands wait until claimed. */
export const browserUserTabInfoSchema = z
  .object({
    id: z.string().min(1),
    lastOpened: z.string().optional(),
    tabGroup: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();
export type BrowserUserTabInfo = z.infer<typeof browserUserTabInfoSchema>;

/** JS dialog info (getDialog result). */
export const browserDialogSchema = z
  .object({
    type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
    message: z.string(),
    defaultPrompt: z.string().optional(),
  })
  .strict();
export type BrowserDialog = z.infer<typeof browserDialogSchema>;

/** UI/client metadata of a browser command; never auto-converted into a model image block. */
export const browserResponseMetaSchema = z
  .object({
    browserUse: z.literal(true),
    backendType: browserBackendTypeSchema,
    browserId: z.string().min(1),
    browserGeneration: z.number().int().nonnegative(),
    openTabIds: z.array(z.string()),
    tabId: z.string().optional(),
    currentUrl: z.string().optional(),
    lifecycle: z.enum(["active", "deliverable", "handoff", "closed"]).optional(),
  })
  .strict();
export type BrowserResponseMeta = z.infer<typeof browserResponseMetaSchema>;

export const browserRecordingArtifactSchema = z
  .object({
    path: z.string().min(1),
    mimeType: z.literal("video/webm"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    durationMs: z.number().nonnegative(),
    frameCount: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserRecordingArtifact = z.infer<typeof browserRecordingArtifactSchema>;

export const browserRecordingJobSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    phase: z.enum(["preparing", "capturing", "finalizing", "completed", "failed", "cancelled"]),
    progress: z.number().min(0).max(1),
    startedAt: z.number().nonnegative(),
    updatedAt: z.number().nonnegative(),
    artifact: browserRecordingArtifactSchema.optional(),
    error: z.string().optional(),
  })
  .strict();
export type BrowserRecordingJob = z.infer<typeof browserRecordingJobSchema>;

/**
 * The unified browser-command result (one shape across agent BrowserControlPort / protocol result / main executor).
 * Screenshots via image; navigation/getState via state; snapshot via snapshot; list via tabs; failures as structured error.
 */
export const browserCommandResultSchema = z
  .object({
    ok: z.boolean(),
    state: browserPageStateSchema.optional(),
    snapshot: browserSnapshotSchema.optional(),
    image: z
      .object({ base64: z.string(), mimeType: z.literal("image/png") })
      .strict()
      .optional(),
    /// list result: only tabs visible in the current window/workspace/session/generation scope.
    tabs: z.array(browserTabSummarySchema).optional(),
    /// From BrowserUser.openTabs(); strictly separate from this session's own tabs.list().
    userTabs: z.array(browserUserTabInfoSchema).optional(),
    /// The single real tab returned by newTab.
    tab: browserTabSummarySchema.optional(),
    /// evaluate result: the JSON-serializable page expression value.
    value: z.unknown().optional(),
    /// elementInfo result: the hit element's info (snapshot element shape; omitted on miss).
    element: browserSnapshotElementSchema.optional(),
    /// getDialog result: current JS dialog; null when none.
    dialog: browserDialogSchema.nullable().optional(),
    /// WebView async recording job; main's temp path is rewritten to the workspace path once the Host materializes.
    recording: browserRecordingJobSchema.optional(),
    error: z
      .object({
        code: browserErrorCodeSchema,
        message: z.string(),
        sideEffect: z.enum(["none", "uncertain"]).optional(),
      })
      .strict()
      .optional(),
    meta: browserResponseMetaSchema.optional(),
    elapsedMs: z.number().nonnegative(),
  })
  .strict();
export type BrowserCommandResult = z.infer<typeof browserCommandResultSchema>;
