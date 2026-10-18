import { z } from "zod";

export const browserElementRectSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();
export type BrowserElementRect = z.infer<typeof browserElementRectSchema>;

/**
 * Snapshot entry of one interactable element; role/name/ref provide location without dumping the whole DOM.
 * ref is a stable DOM-order reference (e1, e2, ...); later actions locate by ref.
 */
export const browserSnapshotElementSchema = z
  .object({
    ref: z.string().min(1),
    tag: z.string(),
    role: z.string().optional(),
    /** accessibleName */
    name: z.string().optional(),
    text: z.string().optional(),
    value: z.string().optional(),
    disabled: z.boolean().optional(),
    checked: z.boolean().optional(),
    selector: z.string(),
    xpath: z.string(),
    rect: browserElementRectSchema,
    inViewport: z.boolean(),
    /// ref of the parent interactable (hierarchy hint; omitted at top level or with no interactable parent).
    parentRef: z.string().optional(),
    /// Frame path the element came from (annotated on same-origin iframe penetration, e.g. "0>2"; omitted on the main document).
    framePath: z.string().optional(),
    /// Bounded stable attributes for building a locator from DOM facts; no noisy class/style/src fields.
    attributes: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type BrowserSnapshotElement = z.infer<typeof browserSnapshotElementSchema>;

/**
 * Visible semantic DOM nodes. Read-the-page only; actionable handles stay in elements/ref so body nodes
 * never exhaust the action ref budget. ref exists only when the node is also in elements.
 */
export const browserSnapshotDomNodeSchema = z
  .object({
    tag: z.string(),
    depth: z.number().int().nonnegative(),
    inViewport: z.boolean(),
    ref: z.string().min(1).optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type BrowserSnapshotDomNode = z.infer<typeof browserSnapshotDomNodeSchema>;

export const browserSnapshotSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    /**
     * Bounded visible semantic DOM; optional keeps legacy backend/result protocol compat.
     * Must be declared before elements: Zod rebuilds objects in schema order, so when a large tool result is truncated
     * the model should see page semantics first, not selector/xpath/rect action details.
     */
    dom: z.array(browserSnapshotDomNodeSchema).optional(),
    /// True when semantic DOM exceeded the internal budget.
    domTruncated: z.boolean().optional(),
    elements: z.array(browserSnapshotElementSchema),
    /// Truncated when elements exceed maxElements.
    truncated: z.boolean(),
  })
  .strict();
export type BrowserSnapshot = z.infer<typeof browserSnapshotSchema>;
