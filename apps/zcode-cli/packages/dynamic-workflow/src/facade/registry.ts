import ts from "typescript";
import { FACADE_FILE_NAME } from "./dts.js";

/**
 * The world-read registry:
 * the single source of truth for **(facade container, member) -> op**. One table, three
 * consumers - site collection in `analysis/sites.ts`, the facade-siting diagnostic in
 * `analysis/facade-misuse.ts`, and the rewrite in `lowering/lower.ts` - so adding a world-read
 * primitive is **one line**, touching no consumer.
 *
 * ————————————————————————————————————————————————————————————————
 * Why the key must carry the **declaring container**, not the bare member name
 * ————————————————————————————————————————————————————————————————
 * `git.log` collides with top-level `log()`. A bare-name set has only two fates: mint a
 * world-read site for every progress message, or drop `git.log`'s site entirely - and a
 * siteless facade call has no journal key, exactly the unreliability the facade-siting rule
 * exists to prevent. Facade identity is already **declaration-based** elsewhere (the misuse pass
 * resolves the callee's symbol, not its spelling); this only applies the same rule consistently,
 * adding no new rule.
 *
 * The op union is **derived** from the table (see {@link WorldReadOp}): one more row widens
 * Boundary A's op vocabulary with no type declaration to touch - the classic seed of a second
 * source of truth.
 */

/** One registry row: a member on a facade container, mapping to one Boundary A op. */
interface WorldReadRow {
  /** Facade container name declaring the member (the `files` of `declare const files: {...}`). */
  readonly container: string;
  /** Member name on the container (the `glob` of `files.glob`). */
  readonly member: string;
  /** Boundary A op name. Need not equal the member name: `git.log` -> "git-log". */
  readonly op: string;
}

/**
 * The world-read registry. A new primitive = one line.
 *
 * The `git.log` row is why this table exists: its member name collides with top-level
 * `log()`, and this key carries the container, so the two never meet (see the module header).
 */
export const WORLD_READ_REGISTRY = [
  { container: "files", member: "glob", op: "glob" },
  { container: "files", member: "read", op: "read" },
  { container: "files", member: "grep", op: "grep" },
  { container: "git", member: "changedFiles", op: "git-changed-files" },
  { container: "git", member: "diff", op: "git-diff" },
  { container: "git", member: "status", op: "git-status" },
  { container: "git", member: "log", op: "git-log" },
  // world.run: journaled command execution. Same table, same mechanism - "read" vs "effect"
  // differs in the authorization surface (compile-time literal cmd + confirm dialog) and the
  // journal node kind (world-run), not in site identity.
  { container: "world", member: "run", op: "run" },
] as const satisfies readonly WorldReadRow[];

/**
 * World-read ops (read-only, journalable). Derived from the registry: one more row widens the op
 * vocabulary. Used by Boundary A's `worldRead(siteId, op, args)` and the journal's
 * `inputHash({op, args})` alike.
 */
export type WorldReadOp = (typeof WORLD_READ_REGISTRY)[number]["op"];

/**
 * The artifact registry: the six members of container `artifact`
 * -> six Boundary A ops. Same shape as the world-read registry but a separate table, on purpose:
 *
 * every world-read row ends in `driver.executeWorldRead` (a read), while the two artifact
 * families are a store-writing effect (`publishArtifact`) and a driver-less declaration
 * (`declareArtifact`). Merging the tables would burden the world-read branches in misuse /
 * lowering / engine with an "unless it is really an artifact" fork - exactly the places that
 * must stay zero-touch when adding primitives.
 *
 * ⚠ Terminology: artifact here is the **user-facing artifact**, not the engine's internal
 * top-level return value.
 */
export interface ArtifactRow {
  /** Facade container declaring the member (always `artifact`). */
  readonly container: "artifact";
  /** Member name on the container. */
  readonly member: string;
  /** Boundary A op name (equals the member name; artifact members have no `git.log`-style collision history). */
  readonly op: string;
  /**
   * Member family. `content` is an effect (async, via driver, rejectable); `preset` a
   * declaration (sync void, no driver). The family decides whether lowering emits
   * `publishArtifact` or `declareArtifact` and whether over-cap is a node rejection or failRun -
   * hence it lives on the same row as op, not re-tested in three places.
   */
  readonly family: "content" | "preset";
}

/** The artifact registry. A new artifact kind = one more row. */
export const ARTIFACT_REGISTRY = [
  { container: "artifact", member: "file", op: "file", family: "content" },
  { container: "artifact", member: "markdown", op: "markdown", family: "content" },
  { container: "artifact", member: "chart", op: "chart", family: "preset" },
  { container: "artifact", member: "table", op: "table", family: "preset" },
  { container: "artifact", member: "metrics", op: "metrics", family: "preset" },
  { container: "artifact", member: "board", op: "board", family: "preset" },
] as const satisfies readonly ArtifactRow[];

/** All artifact ops (six members). Registry-derived; one more row widens the vocabulary. */
export type ArtifactOp = (typeof ARTIFACT_REGISTRY)[number]["op"];

/** Content-member ops (effects: async, via driver, returning an `ArtifactRef`). */
export type ArtifactContentOp = Extract<
  (typeof ARTIFACT_REGISTRY)[number],
  { family: "content" }
>["op"];

/** Preset-member ops (declarations: sync void, no driver). */
export type ArtifactPresetOp = Extract<
  (typeof ARTIFACT_REGISTRY)[number],
  { family: "preset" }
>["op"];

/**
 * Registry lookup: (container, member) -> artifact row; undefined for non-artifact members.
 *
 * Returns the **literal type of the table element** (not the widened {@link ArtifactRow}): the
 * `op` and `family` unions derive wholly from this table; widening once would collapse them to
 * `string` and strip the site table and lowering of their dispatch basis.
 */
function artifactRow(
  container: string | undefined,
  member: string,
): (typeof ARTIFACT_REGISTRY)[number] | undefined {
  if (container === undefined) return undefined;
  return ARTIFACT_REGISTRY.find((row) => row.container === container && row.member === member);
}

/** The artifact row a facade symbol resolves to (declaration-container based); undefined for non-artifact members. */
export function artifactRowOfSymbol(
  symbol: ts.Symbol | undefined,
): (typeof ARTIFACT_REGISTRY)[number] | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined) return undefined;
  return artifactRow(member.container, member.member);
}

/** Which family an artifact op belongs to. Ops are registry-derived, so this always hits. */
export function artifactFamilyOf(op: ArtifactOp): "content" | "preset" {
  const row = ARTIFACT_REGISTRY.find((candidate) => candidate.op === op);
  if (row === undefined) throw new Error(`unknown artifact op: ${op}`);
  return row.family;
}

/** Whether the op is a preset member (declaration family). Engine and analyzer dispatch two wholly different paths on it. */
export function isArtifactPresetOp(op: string): op is ArtifactPresetOp {
  return ARTIFACT_REGISTRY.some((row) => row.op === op && row.family === "preset");
}

/**
 * The container of `ask`: not world-read, but also a **site-producing** facade member, so the
 * facade-siting rule binds it too (direct calls only). Living here keeps one list of
 * "which members produce sites".(
 */
const ASK_MEMBER = { container: "Agent", member: "ask" } as const;

/**
 * Site-producing top-level facade functions (no container). `log` produces no site, hence
 * absent; `hole` is here: holes have a site id (name key `hole#<hash>`) and a host call
 * (docs/dynamic-workflow/authoring.md "Holes"); identity is again **declaration-file** based -
 * the script's own `hole` function is a different function.
 */
const SITE_PRODUCING_FUNCTIONS = ["agent", "report", "hole"] as const;

/**
 * Site-producing top-level facade function names. The bare-callee branch of `sites.ts`
 * dispatches on it, so "which top-level functions produce sites" has this one list.
 *
 * `report` is here, `log` is not; the difference is not severity but **having a journal key**:
 * a report owns a `dwf_node` row (replay-deduped by site x ordinal), so the facade-siting rule
 * (direct calls only) must bind it - a siteless report call is a keyless journal record. `log`
 * has no site, thus nothing aliasing can break.
 */
type SiteProducingFunction = (typeof SITE_PRODUCING_FUNCTIONS)[number];

/**
 * The site-producing **top-level function** a facade symbol resolves to
 * (declaration-based: container must be absent). Non-facade symbols, facade container members,
 * and siteless top-level functions like `log` return undefined.
 */
export function siteProducingFunctionOfSymbol(
  symbol: ts.Symbol | undefined,
): SiteProducingFunction | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined || member.container !== undefined) return undefined;
  return SITE_PRODUCING_FUNCTIONS.find((name) => name === member.member);
}

/**
 * Display markers among top-level facade functions: facade identity, no site. Currently only `phase`.
 *
 * Why a separate list instead of {@link SITE_PRODUCING_FUNCTIONS}: that list answers "which
 * top-level functions produce sites", while `phase` has no site id, journal row, or host call -
 * lowering erases it to `void 0`. Folding it into the site-producing list would make
 * facade-misuse pass 2 ("site-producing direct calls never site-ified") refuse every legal
 * `phase("gate")`.
 *
 * It is still a facade declaration, so alias escapes (`const p = phase`) are refused by
 * facade-misuse pass 1 - lowering may thus erase by node identity safely.
 */
const MARKER_FUNCTIONS = ["phase"] as const;

/** Display-marker top-level facade names. Derived from {@link MARKER_FUNCTIONS}; a new marker is one more row. */
type MarkerFunction = (typeof MARKER_FUNCTIONS)[number];

/**
 * The **display-marker** top-level function a facade symbol resolves to
 * (declaration-based: container absent); undefined for non-markers. Same shape as
 * {@link siteProducingFunctionOfSymbol}, deliberately a different table.
 */
export function markerFunctionOfSymbol(symbol: ts.Symbol | undefined): MarkerFunction | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined || member.container !== undefined) return undefined;
  return MARKER_FUNCTIONS.find((name) => name === member.member);
}

/**
 * Pure value constructors among top-level facade functions: facade identity, no site, no host
 * call. Currently only
 * `model`（docs/dynamic-workflow/authoring.md「Choosing a model per subagent」）。
 *
 * `ModelRef` lives only in the type system: at runtime it is the model-name string itself, so
 * lowering erases `model("x")` to the argument `"x"` - no `__host.model`, no journal row.
 * Separated from `phase` for the reason in
 * {@link MARKER_FUNCTIONS}: no site, so folding it into the site-producing list would make
 * facade-misuse pass 2 refuse legal calls; still a facade declaration, so alias escapes
 * (`const m = model`) are refused by pass 1 and lowering erases by node identity.
 */
const VALUE_FUNCTIONS = ["model"] as const;

/** Pure-value top-level facade names. Derived from {@link VALUE_FUNCTIONS}. */
type ValueFunction = (typeof VALUE_FUNCTIONS)[number];

/** The pure-value top-level function a facade symbol resolves to (declaration-based, container absent); else undefined. */
export function valueFunctionOfSymbol(symbol: ts.Symbol | undefined): ValueFunction | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined || member.container !== undefined) return undefined;
  return VALUE_FUNCTIONS.find((name) => name === member.member);
}

/**
 * All site-producing facade member names (world-read members + `ask`). A **bare-name** list,
 * usable only for the two-phase "candidate by name, identity by declaration" test - never as
 * identity alone (see the module header).
 *
 * Once `git.log` lands this set **contains "log"** while top-level `log()` produces no site -
 * not a contradiction but the proof of why this list is candidate-only: identity must come from
 * (container, member) or declaration resolution; a name cannot answer. The one property still
 * relied on: **no two facade containers declare a same-named member** - containerless, a
 * duplicate would make the back-derived name ambiguous (quoted in facade-misuse diagnostics).
 */
export const SITE_MEMBER_NAMES: ReadonlySet<string> = new Set<string>([
  ASK_MEMBER.member,
  ...WORLD_READ_REGISTRY.map((row) => row.member),
  ...ARTIFACT_REGISTRY.map((row) => row.member),
]);

/**
 * Registry lookup: (container, member) -> op. Never hits for undefined containers (top-level
 * functions) - world-reads always hang off facade container objects.
 */
export function worldReadOp(
  container: string | undefined,
  member: string,
): WorldReadOp | undefined {
  if (container === undefined) return undefined;
  return WORLD_READ_REGISTRY.find((row) => row.container === container && row.member === member)
    ?.op;
}

/**
 * Whether (container, member) is a site-producing facade call (world-read, artifact, `Agent.ask`, or a top-level
 * `agent`/`report`）。
 *
 * Artifact members are here for the same reason as `report`: they own journal keys
 * (`artifact#N` x ordinal), and a siteless publish is a keyless journal record - what the
 * facade-siting rule prevents.
 */
export function isSiteProducing(container: string | undefined, member: string): boolean {
  if (container === undefined) return SITE_PRODUCING_FUNCTIONS.some((name) => name === member);
  if (container === ASK_MEMBER.container && member === ASK_MEMBER.member) return true;
  if (artifactRow(container, member) !== undefined) return true;
  return worldReadOp(container, member) !== undefined;
}

/**
 * The **container name** a facade declaration belongs to: `glob` of
 * `declare const files: { glob(...) }` -> "files"; `ask` of
 * `declare interface Agent { ask(...) }` -> "Agent"; top-level `declare function agent()` ->
 * undefined (no container).
 *
 * Impl: the member's declaration is a method/property signature in a type literal/interface
 * body; walk up to the VariableDeclaration (const container) or InterfaceDeclaration /
 * TypeAliasDeclaration (named type container) for its name. Only declarations inside the facade
 * `.d.ts` count - script-local same-name members are undefined.
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
 * The (container, member) identity of a facade symbol. Any declaration landing inside the
 * facade `.d.ts` hits; the container resolves upward from that declaration (top-level facade
 * functions have none). Non-facade symbol -> undefined.
 */
export function facadeMemberOf(
  symbol: ts.Symbol | undefined,
): { container: string | undefined; member: string } | undefined {
  const declaration = symbol?.declarations?.find(
    (decl) => decl.getSourceFile().fileName === FACADE_FILE_NAME,
  );
  if (declaration === undefined || symbol === undefined) return undefined;
  return { container: facadeContainerOf(declaration), member: symbol.name };
}

/** The world-read op a facade symbol resolves to (declaration-container based); undefined for non-world-read. */
export function worldReadOpOfSymbol(symbol: ts.Symbol | undefined): WorldReadOp | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined) return undefined;
  return worldReadOp(member.container, member.member);
}
