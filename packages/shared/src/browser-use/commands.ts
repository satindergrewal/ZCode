/* eslint-disable max-lines -- BrowserCommand's zod discriminated union is the single runtime truth; splitting lets protocol methods and schemas drift. */
import { z } from "zod";
import { browserViewportInputSchema } from "./command-metadata.js";

export {
  browserClientModeSchema,
  browserCommandContextSchema,
  browserCommandMethodSchema,
  browserErrorCodeSchema,
  browserPageStateSchema,
} from "./command-metadata.js";
export type {
  BrowserClientMode,
  BrowserCommandContext,
  BrowserCommandMethod,
  BrowserErrorCode,
  BrowserPageState,
} from "./command-metadata.js";

export const browserMouseButtonSchema = z.enum(["left", "right", "middle"]);
export type BrowserMouseButton = z.infer<typeof browserMouseButtonSchema>;

/** Keyboard modifiers; the executor maps them onto CDP dispatchMouse/KeyEvent modifier bits. */
export const browserKeyModifierSchema = z.enum([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);
export type BrowserKeyModifier = z.infer<typeof browserKeyModifierSchema>;

/** Viewport coordinate point (cua path / elementInfo / drag; same space as CDP Input). */
export const browserPointSchema = z.object({ x: z.number(), y: z.number() }).strict();
export type BrowserPoint = z.infer<typeof browserPointSchema>;

const browserRecordingDurationSchema = z.number().int().nonnegative().max(90_000);
const browserRecordingSelectorSchema = z.string().trim().min(1).max(2_000);

/** In-app WebView recording accepts a restricted action DSL only; never arbitrary page scripts via recording. */
export const browserRecordingActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wait"), durationMs: browserRecordingDurationSchema }).strict(),
  z
    .object({
      type: z.literal("click"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      button: browserMouseButtonSchema.optional(),
      doubleClick: z.boolean().optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("type"),
      selector: browserRecordingSelectorSchema,
      text: z.string().max(100_000),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hover"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      x: z.number(),
      y: z.number(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      deltaX: z.number().optional(),
      deltaY: z.number(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scrollTo"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("wheel"),
      deltaX: z.number().optional(),
      deltaY: z.number(),
      times: z.number().int().min(1).max(100).optional(),
      intervalMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      path: z.array(browserPointSchema).min(2).max(200),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("waitFor"),
      selector: browserRecordingSelectorSchema,
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      timeoutMs: z.number().int().positive().max(30_000).optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
]);
export type BrowserRecordingAction = z.infer<typeof browserRecordingActionSchema>;

export const browserRecordingOptionsSchema = z
  .object({
    viewport: browserViewportInputSchema.optional(),
    fps: z.number().int().min(1).max(60).optional(),
    jpegQuality: z.number().int().min(1).max(100).optional(),
    maxDurationMs: z.number().int().min(1_000).max(90_000).optional(),
    settleMs: browserRecordingDurationSchema.optional(),
    showCursor: z.boolean().optional(),
    actions: z.array(browserRecordingActionSchema).max(500).optional(),
  })
  .strict();
export type BrowserRecordingOptions = z.infer<typeof browserRecordingOptionsSchema>;

const browserRecordingOutputPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((value) => !/^[/\\]/u.test(value) && !/^[A-Za-z]:[/\\]/u.test(value), {
    message: "recording outputPath must be relative to the workspace",
  })
  .refine(
    (value) =>
      !value
        .split(/[\\/]+/u)
        .some((segment) => segment === ".." || segment === "." || segment.length === 0),
    { message: "recording outputPath cannot escape the workspace" },
  )
  .refine((value) => value.toLowerCase().endsWith(".webm"), {
    message: "recording outputPath must end with .webm",
  });

/** Cross-process terminal ops of a Playwright locator; the builder composes selectors agent-side only. */
export const browserPlaywrightLocatorOperationSchema = z.enum([
  "allTextContents",
  "click",
  "count",
  "dblclick",
  "downloadMedia",
  "evaluate",
  "fill",
  "getAttribute",
  "innerText",
  "isEnabled",
  "isVisible",
  "press",
  "selectOption",
  "setChecked",
  "textContent",
  "waitFor",
]);
export type BrowserPlaywrightLocatorOperation = z.infer<
  typeof browserPlaywrightLocatorOperationSchema
>;

export const browserPlaywrightModifierSchema = z.enum([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);
export type BrowserPlaywrightModifier = z.infer<typeof browserPlaywrightModifierSchema>;

const browserPlaywrightTimeoutSchema = z.number().int().positive().optional();
const browserPlaywrightSelectOptionSchema = z
  .object({
    value: z.string().optional(),
    label: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (selection) =>
      selection.value !== undefined ||
      selection.label !== undefined ||
      selection.index !== undefined,
    "Select option requires value, label, or index",
  );

/**
 * Playwright common ops use a backend-agnostic message shape, discriminated by `name` and `operation`,
 * so extension/CDP adapters reuse one contract.
 */
export const browserPlaywrightActionSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("domSnapshot") }).strict(),
  z
    .object({
      name: z.literal("elementInfo"),
      x: z.number(),
      y: z.number(),
      includeNonInteractable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal("elementScreenshot"),
      x: z.number(),
      y: z.number(),
      includeNonInteractable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal("evaluate"),
      expression: z.string().min(1),
      expressionKind: z.enum(["string", "function"]),
      arg: z.unknown().optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForLoadState"),
      state: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForURL"),
      url: z.string().min(1),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForEvent"),
      event: z.enum(["download", "filechooser"]),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("downloadPath"),
      downloadId: z.string().min(1),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("fileChooserSetFiles"),
      fileChooserId: z.string().min(1),
      files: z.array(z.string()).min(1),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("locator"),
      selector: z.string().min(1),
      operation: browserPlaywrightLocatorOperationSchema,
      value: z.unknown().optional(),
      arg: z.unknown().optional(),
      expression: z.string().min(1).optional(),
      expressionKind: z.enum(["string", "function"]).optional(),
      attribute: z.string().min(1).optional(),
      checked: z.boolean().optional(),
      replace: z.boolean().optional(),
      force: z.boolean().optional(),
      button: browserMouseButtonSchema.optional(),
      modifiers: z.array(browserPlaywrightModifierSchema).optional(),
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      selections: z.array(browserPlaywrightSelectOptionSchema).min(1).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
]);
export type BrowserPlaywrightAction = z.infer<typeof browserPlaywrightActionSchema>;

/**
 * The unified command surface: backends know this one discriminated union only.
 *
 * tabId (optional): the agent object model's address for a controlled tab (human-opened too). Absent =
 * the session's default view. The manager resolves `command.tabId ?? key` to the controlled view key.
 */
export const browserCommandSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("navigate"),
      url: z.string().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("back"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("forward"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("reload"), tabId: z.string().optional() }).strict(),
  z
    .object({
      method: z.literal("snapshot"),
      maxElements: z.number().int().positive().optional(),
      includeHidden: z.boolean().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("click"),
      // ref (snapshot handle) XOR coordinates (x,y): ref uses dom_cua-style location, (x,y) cua visual coordinates.
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      button: browserMouseButtonSchema.optional(),
      doubleClick: z.boolean().optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("fill"),
      ref: z.string().min(1),
      value: z.string(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("type"),
      ref: z.string().min(1).optional(),
      text: z.string(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("press"),
      key: z.string().min(1),
      ref: z.string().min(1).optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA combo input: keys is one chord; keep per-key down/up order, never collapse to last key + bitmask.
  z
    .object({
      method: z.literal("cuaKeypress"),
      keys: z.array(z.string().min(1)).min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("scroll"),
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA scroll: viewport anchor and scroll delta are two coordinate sets; modifier allowed.
  z
    .object({
      method: z.literal("cuaScroll"),
      x: z.number(),
      y: z.number(),
      scrollX: z.number(),
      scrollY: z.number(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // DOM CUA scroll: without nodeId scroll from viewport center; with it, from that element's center.
  z
    .object({
      method: z.literal("domCuaScroll"),
      nodeId: z.string().min(1).optional(),
      scrollX: z.number(),
      scrollY: z.number(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("screenshot"),
      ref: z.string().min(1).optional(),
      fullPage: z.boolean().optional(),
      // Region screenshot: CDP Page.captureScreenshot clip (viewport CSS px). Mutually exclusive with fullPage.
      clip: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .strict()
        .optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("getState"), tabId: z.string().optional() }).strict(),
  // hover: move to element (ref) or point (x,y), triggering hover state (cua move / dom_cua locate-then-move).
  z
    .object({
      method: z.literal("hover"),
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // select: pick one or more <select> options (by value or visible text).
  z
    .object({
      method: z.literal("select"),
      ref: z.string().min(1),
      values: z.array(z.string()).min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // check: set checkbox/radio state (checked defaults true).
  z
    .object({
      method: z.literal("check"),
      ref: z.string().min(1),
      checked: z.boolean().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // drag: from (fromRef or from{x,y}) to (toRef or to{x,y}) via CDP Input synthesized drag.
  z
    .object({
      method: z.literal("drag"),
      fromRef: z.string().min(1).optional(),
      toRef: z.string().min(1).optional(),
      from: browserPointSchema.optional(),
      to: browserPointSchema.optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA drag: the full path is the contract; backends must send point-by-point, not just endpoints.
  z
    .object({
      method: z.literal("cuaDrag"),
      path: z.array(browserPointSchema).min(1),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // elementInfo: given viewport (x,y), return the hit element's info (role/name/rect/selector), bridging vision<->structure.
  z
    .object({
      method: z.literal("elementInfo"),
      x: z.number(),
      y: z.number(),
      tabId: z.string().optional(),
    })
    .strict(),
  // evaluate: run a JS expression in page scope, returning a JSON-serializable value.
  z
    .object({
      method: z.literal("evaluate"),
      expression: z.string().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // getDialog: read the current JS dialog (alert/confirm/prompt/beforeunload); dialog=null when none.
  z.object({ method: z.literal("getDialog"), tabId: z.string().optional() }).strict(),
  // handleDialog: accept/dismiss the current JS dialog; prompt may carry promptText.
  z
    .object({
      method: z.literal("handleDialog"),
      accept: z.boolean(),
      promptText: z.string().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("waitFor"),
      selector: z.string().min(1).optional(),
      text: z.string().min(1).optional(),
      textGone: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // PlaywrightAPI.waitForTimeout: non-negative integers only; 0 yields one timer tick.
  z
    .object({
      method: z.literal("playwrightWaitForTimeout"),
      timeoutMs: z.number().int().nonnegative(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("playwright"),
      action: browserPlaywrightActionSchema,
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("capabilities"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("browserVisibilityGet") }).strict(),
  z.object({ method: z.literal("browserVisibilitySet"), visible: z.boolean() }).strict(),
  browserViewportInputSchema
    .extend({
      method: z.literal("browserViewportSet"),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("browserViewportReset"), tabId: z.string().optional() }).strict(),
  z
    .object({
      method: z.literal("recordingStart"),
      options: browserRecordingOptionsSchema.optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("recordingStatus"),
      recordingId: z.string().trim().min(1),
      outputPath: browserRecordingOutputPathSchema.optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("recordingCancel"),
      recordingId: z.string().trim().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // tabs.get(id)'s backend activation step: validate and set the scope's selected tab; the renderer decides foreground vs background log.
  z.object({ method: z.literal("activateTab"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("newTab") }).strict(),
  z.object({ method: z.literal("listUserTabs") }).strict(),
  z.object({ method: z.literal("claimTab"), tabId: z.string().min(1) }).strict(),
  z
    .object({
      method: z.literal("finalizeTabs"),
      keep: z.array(
        z.object({ tabId: z.string().min(1), status: z.enum(["handoff", "deliverable"]) }).strict(),
      ),
    })
    .strict(),
  z.object({ method: z.literal("markDeliverable"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("markHandoff"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("nameSession"), name: z.string().trim().min(1) }).strict(),
  z
    .object({
      method: z.literal("finalize"),
      tabId: z.string().optional(),
      deliverable: z.boolean().optional(),
    })
    .strict(),
  z.object({ method: z.literal("turnEnded"), turnId: z.string().min(1).optional() }).strict(),
  // closeTabs：连同该 session 名下的 tab 一起关（含已释放回该 session 的）。只给永不回来认领的
  // session 用——dwf 子代理（docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md §2.3）。
  z.object({ method: z.literal("closeSession"), closeTabs: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("cancelRequest"), requestId: z.string().min(1) }).strict(),
  // close: close the given controlled tab (tabId absent = current). Manager-side: detach + tell the renderer to unload the webview.
  z.object({ method: z.literal("close"), tabId: z.string().optional() }).strict(),
  // list: enumerate controlled-tab summaries in this session's window. Manager-intercepted, returns result.tabs.
  z.object({ method: z.literal("list") }).strict(),
]);
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
