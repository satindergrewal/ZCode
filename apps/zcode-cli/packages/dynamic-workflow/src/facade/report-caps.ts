/**
  * Cap constants of report.
 *
  * A separate module from world-read-caps.ts because the **enforcing sides differ**: the world-read caps are
  * enforced by the driver (only it can not-produce -- stop ripgrep at 2000), the report caps by the **engine core**
  * (report bypasses the driver; it ends in the journal inside core). One module would suggest a single enforcing side;
  * that both numbers are contract holds in both places alike.
 *
  * Overflow policy: **fail the whole run** (ReportCapExceeded), not reject-the-node as world-read does.
  * Not a severity judgment but a fact of the rejection channel: report returns void -- the script has nowhere to catch.
  * And precisely because authors cannot write a recovery path, both numbers must be wide enough that a reasonable script never hits them.
 */

/** Per-run report count and per-item serialized byte caps. The numbers are the contract (see the module top). */
export const REPORT_CAPS = {
    /** Max report calls within one run. */
  maxItemsPerRun: 256,
    /** Max serialized bytes per item. */
  maxItemSerializedBytes: 32 * 1024,
} as const;
