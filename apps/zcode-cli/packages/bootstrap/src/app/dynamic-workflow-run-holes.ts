// ============================================================
// Dynamic Workflow Run holes (docs/execution-engine.md, "Holes"): compile artifacts, snapshot projection, diagnostics mapping.
// ============================================================
// Holes have three host-side read surfaces: run-launched.holes (which phase stops are open holes), holes[] on snapshot/detail
// (who waits, who filled), and fill-rejection diagnostics (in-body vs in-draft). All three depend only on
// compile artifacts (site table) and journal events, never the engine -- its stall table is read by the caller via the control surface.
// Pure synthesis rules hence (no IO, no state), same discipline as dynamic-workflow-run-observation.ts.

import type {
  DynamicWorkflowRunFillHoleDiagnostic,
  DynamicWorkflowRunHole,
} from "@zcode/contracts";
import {
  collectSites,
  createWorkflowProgram,
  MODEL_UNRESOLVED_CODE,
  type CompileDiagnostic,
  type JournalStorePort,
  type ModelReference,
  type OpenHole,
  type RunEvent,
  type SiteTable,
  type StoredEvent,
} from "@zcode/dynamic-workflow";
import type { RunRegistryEntry } from "./dynamic-workflow-run-observation.js";

/**
 // * Snapshot cap on hole entries (contracts DynamicWorkflowRunHole docs: <=32). A site reached in a loop
 // * appears per arrival; beyond are repeat arrivals of the same site -- the first 32 already tell the reader it waits.
 */
const SNAPSHOT_MAX_HOLES = 32;

/** Placeholder when the type argument is absent (9012 demands explicit type args; only analyzer-bypassing scripts land here). */
const UNKNOWN_HOLE_TYPE = "unknown";

/**
 // * One hole's compile-time facts: site id, literal name, type-argument source, the call's script line, and whether currently open.
 // * Copied from the site table, not holding it: SiteTable carries the whole AST and the entry lives until run settlement.
 */
export interface CompiledHole {
  siteId: string;
  name: string;
  type: string;
  /** The hole(...) call's line in the script (1-based). */
  line: number;
  /** No body = open hole; false after fill, with nested in-body holes appearing in the table. */
  open: boolean;
}

/** Site table -> per-hole compile facts (source order, open and filled both). */
export function compiledHolesOf(table: SiteTable): CompiledHole[] {
  return table.holes.map((site) => ({
    siteId: site.id,
    name: site.name ?? site.id,
    type: site.typeText ?? UNKNOWN_HOLE_TYPE,
    line: site.loc.line,
    open: site.body === undefined,
  }));
}

/**
 // * run-launched.holes: which phase-table indices are OPEN HOLES (docs/execution-engine.md, "Holes").
 // * Holes stand by name in the phase table (9012 keeps hole names and phase markers distinct), so a name match IS it.
 // * No phase table or no open holes -> undefined, whole field absent, same rule as phaseAlongside.
 */
export function openHoleIndexes(
  phaseNames: readonly string[] | undefined,
  holes: readonly CompiledHole[],
): number[] | undefined {
  if (phaseNames === undefined) return undefined;
  const open = new Set(holes.filter((hole) => hole.open).map((hole) => hole.name));
  const indexes: number[] = [];
  phaseNames.forEach((name, index) => {
    if (open.has(name)) indexes.push(index);
  });
  return indexes.length === 0 ? undefined : indexes;
}

/** The two event kinds the snapshot projection reads; reportItems {limit:0} is this surface's fixed shape (no report rows). */
const HOLE_EVENT_TYPES: RunEvent["type"][] = ["hole-reached", "hole-filled", "run-launched"];

type HoleReachedEvent = Extract<RunEvent, { type: "hole-reached" }>;
type HoleFilledEvent = Extract<RunEvent, { type: "hole-filled" }>;

/** The snapshot's event read: hole events plus the first run-launched (the phase table's cold source), one typed narrow read. */
export function readRunHoleEvents(journal: JournalStorePort, runId: string): StoredEvent[] {
  return journal.listEvents(runId, { types: HOLE_EVENT_TYPES, reportItems: { limit: 0 } });
}

/**
 // * From these events read the CURRENTLY EFFECTIVE phase table: the last hole-filled carries the effective script's table; never filled
 // * means run-launched's declaration table. Snapshot and cold-replay before/after neighbors both key off it.
 */
export function phaseNamesFromEvents(events: readonly StoredEvent[]): string[] | undefined {
  let names: string[] | undefined;
  for (const { event } of events) {
    if (event.type === "run-launched" && names === undefined) names = event.phaseNames;
    if (event.type === "hole-filled") names = event.phaseNames;
  }
  return names;
}

export interface ProjectRunHolesInput {
  /** readRunHoleEvents' return (sequence ascending). */
  events: readonly StoredEvent[];
  /**
   //   * The engine's current stall table; undefined = no live engine in this process (cold row, settled, not yet attached).
   //   * waiting is TRUE only when present here: after a process death no promise waits; events alone would report an un-asked
   * hole as waiting (docs/execution-engine.md, The run snapshot).
   */
  openHoles: readonly OpenHole[] | undefined;
  /** The effective script's hole-facts table (source of type/line); absent = both withheld. */
  holes: readonly CompiledHole[] | undefined;
  /** The currently effective phase table (source of before/after); absent = both withheld. */
  phaseNames: readonly string[] | undefined;
}

/**
 // * holes[] on snapshot/detail (docs/execution-engine.md, "The run snapshot"): one entry per arrival, arrival order; waiting from the
 // * engine stall table, filled from hole-filled events. Arrivals neither waiting nor filled
 // * (previous life stalled at the hole, process died) do NOT appear -- a resume re-reaches and records a fresh hole-reached,
 // * only then is it waiting again. Zero rows -> empty array; the caller then withholds the whole field.
 */
export function projectRunHoles(input: ProjectRunHolesInput): DynamicWorkflowRunHole[] {
  const waiting = new Set((input.openHoles ?? []).map((hole) => instanceKey(hole)));
  const filledBySite = new Map<string, HoleFilledEvent>();
  const reached: { event: HoleReachedEvent; at: number | undefined }[] = [];
  for (const stored of input.events) {
    if (stored.event.type === "hole-reached") {
      reached.push({ event: stored.event, at: stored.timeCreated });
    } else if (stored.event.type === "hole-filled") {
      filledBySite.set(stored.event.siteId, stored.event);
    }
  }
  const byId = new Map((input.holes ?? []).map((hole) => [hole.siteId, hole]));
  const out: DynamicWorkflowRunHole[] = [];
  for (const { event, at } of reached) {
    if (out.length >= SNAPSHOT_MAX_HOLES) break;
    const { siteId, ordinal } = event.instance;
    const compiled = byId.get(siteId);
    const filled = filledBySite.get(siteId);
    const isWaiting = waiting.has(instanceKey(event.instance));
    if (!isWaiting && filled === undefined) continue;
    out.push({
      siteId,
      ordinal,
      name: event.name,
      type: compiled?.type ?? UNKNOWN_HOLE_TYPE,
      ...(isWaiting
        ? { state: "waiting" as const, ...(at === undefined ? {} : { since: at }) }
        : {
            state: "filled" as const,
            filledAt: filled!.filledAt,
            ...(filled!.filledBy === undefined ? {} : { filledBy: filled!.filledBy }),
          }),
      ...(compiled === undefined ? {} : { line: compiled.line }),
      ...neighbourPhases(event.name, input.phaseNames),
    });
  }
  return out;
}

/**
 // * Cold row (no entry here) hole facts: when events show real arrivals and the row has a script, build the site table once over the row's (effective) script;
 // * else undefined. Most runs have no holes, so this compile is pay-on-need. Uncompilable rows
 // * (older facade) also undefined -- a read surface must not throw over a derived field.
 */
export function coldCompiledHoles(
  scriptText: string | undefined,
  events: readonly StoredEvent[],
): CompiledHole[] | undefined {
  if (scriptText === undefined) return undefined;
  if (!events.some((entry) => entry.event.type === "hole-reached")) return undefined;
  try {
    return compiledHolesOf(collectSites(createWorkflowProgram(scriptText)));
  } catch {
    return undefined;
  }
}

/**
 // * The hole projection entry shared by snapshot/detail: live entries read own facts/phase tables and the engine stall table via the control surface;
 // * cold rows rebuild from events plus the row's script. An entry with ZERO holes (per compile artifacts) reads NOTHING -- that is most
 // * runs, and getTask is polled every second by the tracker; never pay an event read for an empty field.
 */
export function runHolesOf(
  runId: string,
  entry: RunRegistryEntry | undefined,
  journal: JournalStorePort,
  scriptText?: string,
): DynamicWorkflowRunHole[] {
  if (entry !== undefined && (entry.holes?.length ?? 0) === 0) return [];
  const events = readRunHoleEvents(journal, runId);
  if (events.length === 0) return [];
  const live = entry !== undefined && entry.terminal === undefined;
  return projectRunHoles({
    events,
    openHoles: live ? entry.control?.openHoles() : undefined,
    holes:
      entry?.holes ?? coldCompiledHoles(scriptText ?? journal.getRun(runId)?.scriptText, events),
    phaseNames: entry?.phaseNames ?? phaseNamesFromEvents(events),
  });
}

function instanceKey(ref: { siteId: string; ordinal: number }): string {
  return `${ref.siteId}@${ref.ordinal}`;
}

/** The hole's before/after neighbors in the phase table (holes stand by name); absent when unlisted or neighborless. */
function neighbourPhases(
  name: string,
  phaseNames: readonly string[] | undefined,
): { before?: string; after?: string } {
  if (phaseNames === undefined) return {};
  const index = phaseNames.indexOf(name);
  if (index < 0) return {};
  const before = phaseNames[index - 1];
  const after = phaseNames[index + 1];
  return {
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

/**
 // * Diagnostics mapping for rejected fills (docs/dynamic-workflow/launch.md, "The fill file"). The splice inserts the body at
 // * script line insertedAtLine for insertedLines-1 rows (last is the closing brace), each prefixed
 // * with call indent plus two spaces. Diagnostics on body rows tag inFill with body-local coordinates; on the closing-brace row
 // * they map to the call's line; past the insertion point they shift up by insertedLines -- rejection writes nothing, the draft is still
 // * the pre-splice script, and line numbers must point at it.
 */
export function mapFillDiagnostics(input: {
  diagnostics: readonly CompileDiagnostic[];
  effectiveText: string;
  body: string;
  insertedAtLine: number;
  insertedLines: number;
}): DynamicWorkflowRunFillHoleDiagnostic[] {
  const { diagnostics, insertedAtLine, insertedLines } = input;
  const firstBodyLine = insertedAtLine;
  const lastBodyLine = insertedAtLine + insertedLines - 2;
  const closingLine = insertedAtLine + insertedLines - 1;
  const effectiveLines = input.effectiveText.split("\n");
  const bodyLines = input.body.replace(/\r?\n$/u, "").split(/\r?\n/u);
  return diagnostics.map((diagnostic) => {
    const base = { message: diagnostic.message, code: diagnostic.code };
    if (diagnostic.line >= firstBodyLine && diagnostic.line <= lastBodyLine) {
      const bodyLine = diagnostic.line - firstBodyLine + 1;
      const indent =
        leadingWhitespace(effectiveLines[diagnostic.line - 1] ?? "") -
        leadingWhitespace(bodyLines[bodyLine - 1] ?? "");
      return {
        ...base,
        inFill: true,
        line: bodyLine,
        column: Math.max(1, diagnostic.column - Math.max(0, indent)),
      };
    }
    if (diagnostic.line === closingLine) {
      return { ...base, inFill: false, line: insertedAtLine - 1, column: diagnostic.column };
    }
    if (diagnostic.line > closingLine) {
      return {
        ...base,
        inFill: false,
        line: diagnostic.line - insertedLines,
        column: diagnostic.column,
      };
    }
    return { ...base, inFill: false, line: diagnostic.line, column: diagnostic.column };
  });
}

/**
 // * The filled script names models outside this run's binding table -> 9011, one per name, at its first occurrence
 // * (effective-script coordinates; {@link mapFillDiagnostics} translates).
 *
 // * Fix rationale (MR !2837 review CR-01): the binding table resolves against the catalog once, at run creation, recorded on run-launched;
 * subagent session creation looks names up there. Fills used to compile only, so a body's new model("accurate") sailed through and the hole
 * released, failing only at subagent start with WorkflowActorModelUnboundError -- a model absent from the approval dialog the user saw.
 * The fill confirm dialog lists no models, so bodies must reuse table names; model changes go through AmendWorkflow.
 */
export function unboundFillModelDiagnostics(
  references: readonly ModelReference[],
  bindings: Readonly<Record<string, string>> | undefined,
): CompileDiagnostic[] {
  const bound = Object.entries(bindings ?? {});
  const available =
    bound.length === 0
      ? "this run was launched without naming any model"
      : `this run was launched with ${bound.map(([name, canonical]) => `"${name}" = ${canonical}`).join("; ")}`;
  const reported = new Set<string>();
  const diagnostics: CompileDiagnostic[] = [];
  for (const reference of references) {
    if (bindings?.[reference.name] !== undefined || reported.has(reference.name)) continue;
    reported.add(reference.name);
    diagnostics.push({
      code: MODEL_UNRESOLVED_CODE,
      line: reference.line,
      column: reference.column,
      message: `The model "${reference.name}" is not one the run can use: ${available}, and a fill can name only those. Use one of them, or drop \`model\` from the persona; to add a model, revise the run with AmendWorkflow.`,
    });
  }
  return diagnostics;
}

function leadingWhitespace(line: string): number {
  return /^[ \t]*/u.exec(line)?.[0].length ?? 0;
}
