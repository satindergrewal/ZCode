/**
 * Split out because journal-contract.ts hit the oxlint max-lines cap (400 lines): the fixtures
 * shared by the topic modules (CAPS / baseRun / logs) live here. The public surface is still
 * exported from journal-contract.ts.
 */

import type { RunRecord, StoredEvent } from "../engine/index.js";

const CAPS = { maxConcurrency: 4 };

export function baseRun(runId: string): RunRecord {
  return { runId, caps: CAPS, spentTokens: 0, status: "running" };
}

/** The message of one page of log events, for page-by-page comparison (reads plainer in the type-agnostic paging assertions). */
export function logs(events: StoredEvent[]): string[] {
  return events.map((e) => (e.event.type === "log" ? e.event.message : `<${e.event.type}>`));
}
