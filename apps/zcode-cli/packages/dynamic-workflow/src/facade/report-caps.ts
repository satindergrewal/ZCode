/**
 * Caps for `report`.
 *
 * This is a separate module from `world-read-caps.ts` because the two are **enforced on
 * different sides**: the world-read caps are enforced by the driver (only it can "not produce"
 * — stop ripgrep at 2000 matches), while the report caps are enforced by the **engine core**
 * (report never touches the driver; it lands in the journal inside the core and is done). One
 * module for both would suggest a single enforcing side; what the two share is that the numbers
 * are contracts.
 *
 * On overflow the **whole run fails** (`ReportCapExceeded`) instead of rejecting the node the
 * way world-read does. That is not a severity judgement but a fact of the **rejection channel**:
 * `report` returns `void`, so the script has nowhere to `catch`. And precisely because script
 * authors cannot write a recovery path, both numbers must be wide enough that a reasonable
 * script never hits them.
 */

/**
 * Per-run item count, per-item serialized bytes, and per-run byte total. The numbers are the
 * contract (see the module header).
 *
 * The truly bounded resource is **bytes** (each item is stored twice on disk: once in the node
 * row, once in the event); count and per-item size are its two proxies. Together the three
 * bound the worst case: at most 1 GiB of items per run, about 2 GiB on disk.
 */
export const REPORT_CAPS = {
  /**
   * Maximum `report` items per run. Was 256: sized "same width" while the node cap (100)
   * existed; once that cap went away, one report-per-item fan-out could legitimately hit it,
   * and hitting it fails the whole run. The count itself is cheap: no reader pulls items beyond
   * the display horizon into memory (docs/execution-engine.md "Reading the journal"); disk
   * totals are governed by {@link REPORT_CAPS.maxBytesPerRun}.
   */
  maxItemsPerRun: 65_536,
  /**
   * Maximum serialized bytes per item. Was 32 KiB; the 1 MiB bound comes from an item having
   * to fit one protocol message (16 MiB per frame; a board or event-log page is 4 MiB and
   * carries at least one item) plus headroom for readers that take whole items — cold replay
   * and GetWorkflowRun read up to 64 at once, i.e. at most 64 MiB transient memory. Larger
   * deliverables belong in `artifact.file` (20 MiB cap, read in chunks).
   */
  maxItemSerializedBytes: 1024 * 1024,
  /**
   * Total serialized bytes across all items of one run. Without it, 65,536 items x 1 MiB is
   * 64 GiB of items (128 GiB on disk). On resume `sumResultBytes` restores it from the
   * journal, carrying across resumes.
   */
  maxBytesPerRun: 1024 * 1024 * 1024,
} as const;
