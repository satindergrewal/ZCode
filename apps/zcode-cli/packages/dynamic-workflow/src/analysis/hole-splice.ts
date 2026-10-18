import { SCRIPT_PRELUDE_LENGTH, type ScriptLoc } from "../compiler/compile.js";
import { holePrefixOf } from "./hole-id.js";
import type { SiteTable } from "./sites.js";

/**
 * The fill service's two plain-text tools (execution-engine.md "The fill service's checks"):
 * splicing a body into a hole call, and the pre/post-fill stability re-check of the site table.
 * Neither touches the engine or the journal; the run service calls them in order.
 */

/** The splice result: the new text, the script line (1-based) of the first inserted line, and the number of inserted lines. */
export interface SplicedHoleBody {
  text: string;
  insertedAtLine: number;
  insertedLines: number;
}

/** Extra spaces the body is indented beyond the call's indentation. */
const BODY_EXTRA_INDENT = 2;

/**
 * Splice `body` into the hole call as its last argument: insert `, async () => {\n<body>\n}`
 * right after the **end of the last argument**, each body line indented to the call's line plus
 * two spaces, the closing brace at the call's indentation. Returns `undefined` when the hole is
 * not in the table or already has a body — filling an already-filled hole is not something a
 * splice can express.
 *
 * The insertion point is the end of the last argument, not before the closing paren: in the
 * first live trial (2026-09-28) the main agent wrote, prettier-style,
 * `hole<T>(\n  "name",\n  \`prompt\`,\n);` — a trailing comma after the prompt — and inserting
 * before the closing paren yields `, , async`, four syntax errors all anchored on a draft that
 * was not wrong. Attached after the last argument, the original trailing comma and newline stay
 * behind the body (`}, \n)`), still a legal call; comments between the last argument and the
 * closing paren are preserved as is.
 *
 * `insertedAtLine` is the line number of the first body line in the new script (`,
 * async () => {` stays on the line where the last argument ends), `insertedLines` the number of
 * added newlines (body lines + the closing-brace line): diagnostics use the two to split
 * findings between "in the fill file" and "in the draft".
 */
export function spliceHoleBody(
  scriptText: string,
  table: SiteTable,
  holeSiteId: string,
  body: string,
): SplicedHoleBody | undefined {
  const site = table.holes.find((hole) => hole.id === holeSiteId);
  if (site === undefined || site.body !== undefined) return undefined;
  const lastArg = site.call.arguments[site.call.arguments.length - 1];
  if (lastArg === undefined) return undefined;
  const insertAt = lastArg.getEnd() - SCRIPT_PRELUDE_LENGTH;
  const lineStart = scriptText.lastIndexOf("\n", site.call.getStart() - SCRIPT_PRELUDE_LENGTH) + 1;
  const indent = /^[ \t]*/.exec(scriptText.slice(lineStart))?.[0] ?? "";
  const bodyIndent = `${indent}${" ".repeat(BODY_EXTRA_INDENT)}`;
  const bodyLines = body.replace(/\r?\n$/, "").split(/\r?\n/);
  const inserted = [
    ", async () => {",
    ...bodyLines.map((line) => (line.trim() === "" ? "" : `${bodyIndent}${line}`)),
    `${indent}}`,
  ];
  const before = scriptText.slice(0, insertAt);
  const text = `${before}${inserted.join("\n")}${scriptText.slice(insertAt)}`;
  const callLine = before.split("\n").length; // the line where the last argument ends (1-based)
  return { insertedAtLine: callLine + 1, insertedLines: inserted.length - 1, text };
}

/** The stability verdict: pass, or one sentence on which id moved where. */
export type SiteStability = { ok: true } | { ok: false; detail: string };

interface LocatedSite {
  id: string;
  loc: ScriptLoc;
}

function everySite(table: SiteTable): LocatedSite[] {
  return [
    ...table.asks,
    ...table.actors,
    ...table.worldReads,
    ...table.joins,
    ...table.reports,
    ...table.artifacts,
    ...table.holes,
  ].map((site) => ({ id: site.id, loc: site.loc }));
}

/**
 * Site-table stability across a fill (docs/analysis.md "Sites", the site id stability rule,
 * extended to "adding a body"): every id in `before` (all kinds) is in `after`, at the same
 * position or — when at or after the insertion point — shifted by `insertedLines`; every id in
 * `after` absent from `before` was written by this fill: carrying the `<holeSiteId>/` prefix, or
 * being a hole left inside the body (a `fill` chain reaching `holeSiteId`) plus the sites inside
 * it. Any violation is the host's fault (the analyzer's numbering rules were broken); the run
 * must not receive an id it cannot join.
 *
 * A site on the insertion line after the insertion point (`await hole(...); agent("a")` on one
 * line) shifts lines but changes column: that line compares line numbers only.
 */
export function checkSiteStability(
  before: SiteTable,
  after: SiteTable,
  holeSiteId: string,
  insertedAtLine: number,
  insertedLines: number,
): SiteStability {
  const afterById = new Map(everySite(after).map((site) => [site.id, site.loc]));
  const parenLine = insertedAtLine - 1;
  for (const site of everySite(before)) {
    const moved = afterById.get(site.id);
    if (moved === undefined)
      return { detail: `site ${site.id} vanished after the fill`, ok: false };
    const shifted = site.loc.line >= parenLine;
    const expectedLine = shifted ? site.loc.line + insertedLines : site.loc.line;
    const sameLine =
      moved.line === expectedLine || (site.loc.line === parenLine && moved.line === site.loc.line);
    const sameColumn = site.loc.line === parenLine || moved.column === site.loc.column;
    if (!sameLine || !sameColumn) {
      return {
        detail:
          `site ${site.id} moved from ${site.loc.line}:${site.loc.column} to ${moved.line}:${moved.column}` +
          ` (expected line ${expectedLine})`,
        ok: false,
      };
    }
  }
  const known = new Set(everySite(before).map((site) => site.id));
  // The holes this fill wrote down: the `fill` chain reaches the filled hole all the way
  // (holes left inside the body, and ones filled inline within it).
  const fillOf = new Map(after.holes.map((hole) => [hole.id, hole.fill]));
  const writtenByFill = (holeId: string): boolean => {
    for (let cur: string | undefined = holeId; cur !== undefined; cur = fillOf.get(cur)) {
      if (cur === holeSiteId) return true;
    }
    return false;
  };
  for (const site of everySite(after)) {
    if (known.has(site.id)) continue;
    const owner = holePrefixOf(site.id) ?? site.id;
    if (!writtenByFill(owner)) {
      return { detail: `site ${site.id} appeared outside the fill of ${holeSiteId}`, ok: false };
    }
  }
  return { ok: true };
}
