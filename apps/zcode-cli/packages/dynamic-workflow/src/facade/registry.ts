import ts from "typescript";
import { FACADE_FILE_NAME } from "./dts.js";

/**
 * The world-read registry:
 * the sole source of truth for (facade container, member) -> op. One table, three consumers -- site collection,
 * facade-siting diagnostics, and the lowering rewrite -- so adding a world-read primitive is **one row**,
 * consumers untouched.
 *
 * ————————————————————————————————————————————————————————————————
 * Why the key must carry the **declaring container**, not the member name alone:
 * ————————————————————————————————————————————————————————————————
 * git.log collides with the top-level log. A bare-name set has only two outcomes: mint a world-read site for every
 * progress log, or drop git.log sites entirely -- and a siteless facade call has no journal
 * key, the exact unreliability the facade-siting rules exist to prevent. Facade identity is already
 * declaration-based elsewhere (misuse resolves the callee symbol, not its spelling), so this just
 * applies the same rule consistently; no new rule.
 *
 * The op union is **derived** from the table (see WorldReadOp): one new row extends the Boundary A op vocabulary,
 * no second type declaration to fix -- the classic seed of a second truth.
 */

/** One registry row: a member of a facade container, mapping to one Boundary A op. */
interface WorldReadRow {
  /** The facade container declaring the member (the files of declare const files). */
  readonly container: string;
  /** The member name on the container (glob of files.glob). */
  readonly member: string;
  /** The Boundary A op name. Need equal the member name: git.log maps to git-log. */
  readonly op: string;
}

/**
 * The world-read registry. A new primitive = a new row.
 *
 * The git.log row is why this table exists: its member name collides with the top-level log, and this
 * key carries the container, so the two never meet (see the module top).
 */
export const WORLD_READ_REGISTRY = [
  { container: "files", member: "glob", op: "glob" },
  { container: "files", member: "read", op: "read" },
  { container: "files", member: "grep", op: "grep" },
  { container: "git", member: "changedFiles", op: "git-changed-files" },
  { container: "git", member: "diff", op: "git-diff" },
  { container: "git", member: "status", op: "git-status" },
  { container: "git", member: "log", op: "git-log" },
  // world.run: journaled command execution. Same table, same mechanism -- the read-vs-effect
  // difference lives in the authorization face (compile-time literal cmd + confirmation dialog) and the journal
  // node kind (world-run), not in site identity.
  { container: "world", member: "run", op: "run" },
] as const satisfies readonly WorldReadRow[];

/**
 * World-read ops (read-only, journalable). Derived from the registry: one row extends the op vocabulary.
 * Both the Boundary A worldRead call and the journal inputHash of op+args use it.
 */
export type WorldReadOp = (typeof WORLD_READ_REGISTRY)[number]["op"];

/**
 * The artifact registry: six members of the artifact container
 * to six Boundary A ops. Same shape as the world-read registry but a **separate table**, deliberately:
 *
 * every world-read row ends in the driver execute path -- a read; the artifact families are
 * one store-writing effect (publish) and one driver-bypassing declaration. Merging tables would force the
 * world-read branches in misuse/lowering/engine to carry an unless-it-is-an-artifact fork -- precisely the
 * places that must stay zero-touch when a primitive is added.
 *
 * ⚠ Terminology: artifact here is the **user-facing deliverable**, not the engine-internal top-level return.
 */
export interface ArtifactRow {
  /** The facade container declaring the member (always artifact). */
  readonly container: "artifact";
  /** The member name on the container. */
  readonly member: string;
  /** The Boundary A op (equal to the member name; artifact members have no git.log-style collision history). */
  readonly op: string;
  /**
   * Member family. content is an effect (async, via the driver, rejectable); preset a declaration
   * (synchronous void, no driver). The family decides the publish-vs-declare rewrite and
   * node-rejection-vs-failRun, so it lives on the row, not re-derived in three places.
   */
  readonly family: "content" | "preset";
}

/** The artifact registry. A new artifact kind = a new row. */
export const ARTIFACT_REGISTRY = [
  { container: "artifact", member: "file", op: "file", family: "content" },
  { container: "artifact", member: "markdown", op: "markdown", family: "content" },
  { container: "artifact", member: "chart", op: "chart", family: "preset" },
  { container: "artifact", member: "table", op: "table", family: "preset" },
  { container: "artifact", member: "metrics", op: "metrics", family: "preset" },
  { container: "artifact", member: "board", op: "board", family: "preset" },
] as const satisfies readonly ArtifactRow[];

/** Every artifact op (six members). Registry-derived; a row extends the vocabulary. */
export type ArtifactOp = (typeof ARTIFACT_REGISTRY)[number]["op"];

/** Content-member ops (effects: async, via the driver, returning the ref). */
export type ArtifactContentOp = Extract<
  (typeof ARTIFACT_REGISTRY)[number],
  { family: "content" }
>["op"];

/** Preset-member ops (declarations: synchronous void, no driver). */
export type ArtifactPresetOp = Extract<
  (typeof ARTIFACT_REGISTRY)[number],
  { family: "preset" }
>["op"];

/**
 * Registry lookup: (container, member) -> artifact row; undefined for non-artifact members.
 *
 * Returns the **literal type of the table element** (not the widened row): the op and family unions are
 * derived from this table; one widening reverts them to string, and site table/lowering lose their dispatch.
 */
function artifactRow(
  container: string | undefined,
  member: string,
): (typeof ARTIFACT_REGISTRY)[number] | undefined {
  if (container === undefined) return undefined;
  return ARTIFACT_REGISTRY.find((row) => row.container === container && row.member === member);
}

/** The artifact row a facade symbol resolves to (by declaring container); undefined otherwise. */
export function artifactRowOfSymbol(
  symbol: ts.Symbol | undefined,
): (typeof ARTIFACT_REGISTRY)[number] | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined) return undefined;
  return artifactRow(member.container, member.member);
}

/** Which family an artifact op belongs to. Registry-derived, hence always hits. */
export function artifactFamilyOf(op: ArtifactOp): "content" | "preset" {
  const row = ARTIFACT_REGISTRY.find((candidate) => candidate.op === op);
  if (row === undefined) throw new Error(`unknown artifact op: ${op}`);
  return row.family;
}

/** Whether the op is a preset member (the declaration family). Engine and analyzer dispatch two wholly different paths by it. */
export function isArtifactPresetOp(op: string): op is ArtifactPresetOp {
  return ARTIFACT_REGISTRY.some((row) => row.op === op && row.family === "preset");
}

/**
 * The container of ask: not a world-read, but also a **site-producing** facade member, so the facade-siting
 * rules bind it too (direct calls only). Housed here so which-members-produce-sites has one list.
 */
const ASK_MEMBER = { container: "Agent", member: "ask" } as const;

/** Site-producing top-level facade functions (no container). log produces none, hence absent. */
const SITE_PRODUCING_FUNCTIONS = ["agent", "report"] as const;

/**
 * Site-producing top-level facade names. The sites.ts bare-callee branch dispatches on it, so
 * which-top-level-functions-produce-sites has this one list.
 *
 * report is here, log is not; the difference is not severity but **having a journal key**:
 * a report has a node row (replay deduped by site x ordinal), so the facade-siting rule
 * (direct calls only) must bind it -- a siteless report is a keyless journal row.
 * log has no site, hence nothing aliasing can break.
 */
type SiteProducingFunction = (typeof SITE_PRODUCING_FUNCTIONS)[number];

/**
 * The site-producing **top-level function** a facade symbol resolves to (declaration-based: no container).
 * Non-facade symbols, container members, and siteless top-level functions like log return undefined.
 */
export function siteProducingFunctionOfSymbol(
  symbol: ts.Symbol | undefined,
): SiteProducingFunction | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined || member.container !== undefined) return undefined;
  return SITE_PRODUCING_FUNCTIONS.find((name) => name === member.member);
}

/**
 * Display-marker top-level facade functions: facade identity, no sites. Currently only phase.
 *
 * Why not in the site-producing list: that list answers which-top-level-functions-produce-sites, while
 * phase has no site id, no journal row, no host call -- lowering erases it to void.
 * Mixing it in would make misuse pass 2 (site-producing but not sited) reject every legal phase call.
 *
 * It is still a facade function declaration, so alias escapes are rejected by misuse pass 1 --
 * lowering may thus erase by node identity with confidence.
 */
const MARKER_FUNCTIONS = ["phase"] as const;

/** Display-marker top-level facade names. Derived from the marker table; a new marker is a row. */
type MarkerFunction = (typeof MARKER_FUNCTIONS)[number];

/**
 * The display-marker top-level function a facade symbol resolves to (declaration-based: no container),
 * undefined otherwise. Same shape as the site-producing lookup, deliberately a different table.
 */
export function markerFunctionOfSymbol(symbol: ts.Symbol | undefined): MarkerFunction | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined || member.container !== undefined) return undefined;
  return MARKER_FUNCTIONS.find((name) => name === member.member);
}

/**
 * Every site-producing facade member name (world-read members + ask). A **bare-name** list, usable only for
 * the two-step candidate-by-name-then-verify-by-declaration check -- never alone as identity (module top).
 *
 * Once git.log lands, this set contains log while the top-level log produces no site. Not a contradiction --
 * it is the proof this list is candidate-only: identity comes from container+member or declaration resolution;
 * a name cannot answer. The one relied-upon property: no two facade containers declare the same member name --
 * containerless, a duplicate would make the reverse lookup ambiguous (misuse diagnostics cite it).
 */
export const SITE_MEMBER_NAMES: ReadonlySet<string> = new Set<string>([
  ASK_MEMBER.member,
  ...WORLD_READ_REGISTRY.map((row) => row.member),
  ...ARTIFACT_REGISTRY.map((row) => row.member),
]);

/**
 * Registry lookup: (container, member) -> op. An undefined container (top-level function) never hits --
 * world-reads always hang off facade container objects.
 */
function worldReadOp(container: string | undefined, member: string): WorldReadOp | undefined {
  if (container === undefined) return undefined;
  return WORLD_READ_REGISTRY.find((row) => row.container === container && row.member === member)
    ?.op;
}

/**
 * Whether (container, member) is a site-producing facade call (world-read, artifact, Agent.ask, or a site-producing
 * `agent`/`report`).
 *
 * Artifact members are here, same reason as report: they have a journal key (id x ordinal),
 * and a siteless publish is a keyless journal row -- what facade-siting prevents.
 */
export function isSiteProducing(container: string | undefined, member: string): boolean {
  if (container === undefined) return SITE_PRODUCING_FUNCTIONS.some((name) => name === member);
  if (container === ASK_MEMBER.container && member === ASK_MEMBER.member) return true;
  if (artifactRow(container, member) !== undefined) return true;
  return worldReadOp(container, member) !== undefined;
}

/**
 * The **container name** of a facade declaration: glob in declare-const-files to files, ask in the Agent interface to
 * Agent, a top-level function to undefined (no container).
 *
 * Implementation: the member declaration is a method/property signature in a type literal/interface; walk up to the
 * variable declaration (const container) or interface/type alias (named type container) and take its name.
 * Only declarations inside the facade d.ts count -- script-local same-name members are undefined.
 */
export function facadeContainerOf(declaration: ts.Node | undefined): string | undefined {
  if (declaration === undefined) return undefined;
  if (declaration.getSourceFile().fileName !== FACADE_FILE_NAME) return undefined;
  for (let node: ts.Node | undefined = declaration.parent; node !== undefined; node = node.parent) {
    if (ts.isVariableDeclaration(node)) {
      return ts.isIdentifier(node.name) ? node.name.text : undefined;
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return node.name.text;
    if (ts.isSourceFile(node)) return undefined;
  }
  return undefined;
}

/**
 * The (container, member) identity of a facade symbol. Any declaration inside the facade d.ts hits;
 * the container resolves upward from that declaration (top-level facade functions have none). Non-facade: undefined.
 */
function facadeMemberOf(
  symbol: ts.Symbol | undefined,
): { container: string | undefined; member: string } | undefined {
  const declaration = symbol?.declarations?.find(
    (decl) => decl.getSourceFile().fileName === FACADE_FILE_NAME,
  );
  if (declaration === undefined || symbol === undefined) return undefined;
  return { container: facadeContainerOf(declaration), member: symbol.name };
}

/** The world-read op a facade symbol resolves to (by declaring container); undefined otherwise. */
export function worldReadOpOfSymbol(symbol: ts.Symbol | undefined): WorldReadOp | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined) return undefined;
  return worldReadOp(member.container, member.member);
}
