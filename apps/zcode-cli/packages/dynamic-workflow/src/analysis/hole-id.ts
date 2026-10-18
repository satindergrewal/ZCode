/**
 * Hole site ids (docs/analysis.md "Sites", the Hole sites section): `hole#<8 hex digits>`, keyed
 * by the hole's **name** (FNV-1a 32-bit, over Unicode code points, name trimmed first), whatever
 * the nesting depth.
 *
 * Why not a position counter: a fill inserts code mid-script, and any position-numbered scheme
 * renumbers the holes after the insertion point — while journal keys, ask specs and the site
 * phase table all need ids to survive a fill. Why no outer-id prefix anymore (the pre-2026-09-28
 * `hole#1/hole#1/ask#1`): each nesting level adds 7 characters, and chained fills (each step
 * leaving one more hole at the end) hit the protocol's 64-character id cap within about eight
 * steps — and that cap is correct; protocol payloads must be bounded. The name is unique across
 * the whole valid script (9012), so the name key is stable across fills and does not grow with
 * depth. Two distinct names colliding on one hash is reported by 9012 (32 bits, a few dozen
 * holes per script at most, about 1e-7); never guess.
 *
 * Sites inside a body still carry the `<holeId>/` prefix (`hole#a91f3c07/ask#1`) — but exactly
 ** one level**: a hole left inside the body is itself `hole#<hash>`, and the sites in its body
 * carry its prefix. Nesting is no longer encoded in the id; it lives in the site table's `fill`
 * field (HoleSite.fill: the hole enclosing this one).
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Hex digits in a hole id; the protocol side's id cap (64) is unrelated — this just keeps the id short and fixed. */
export const HOLE_ID_HEX_LENGTH = 8;

/** The shape of a hole site id. The UI and the stability check use it to recognize "this id is a hole". */
export const HOLE_SITE_ID_PATTERN = /^hole#[0-9a-f]{8}$/u;

/** Mint a hole's site id from its name. The name is trimmed first (uniqueness compares trimmed too). */
export function holeSiteId(name: string): string {
  let hash = FNV_OFFSET;
  for (const char of name.trim()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return `hole#${hash.toString(16).padStart(HOLE_ID_HEX_LENGTH, "0")}`;
}

export function isHoleSiteId(id: string): boolean {
  return HOLE_SITE_ID_PATTERN.test(id);
}

/**
 * The hole a site id belongs to: `hole#x/ask#1` -> `hole#x`; a hole's own id or an id outside any
 * body -> undefined. Only one prefix level is read (an id carries at most one); which hole a hole
 * itself belongs to is the site table's `fill`.
 */
export function holePrefixOf(siteId: string): string | undefined {
  const cut = siteId.indexOf("/");
  return cut < 0 ? undefined : siteId.slice(0, cut);
}
