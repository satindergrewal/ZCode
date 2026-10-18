// ============================================================
// Bounded inputs for world-read / world-run nodes
// ============================================================
// inputHash answers only same-input-or-not; the workspace transcript must answer what-the-input-was. So {op, args}
// is squeezed into 4 KB: the vast majority (a path, a pattern, one argv) sits far below the cap and
// persists verbatim; only world.run(node, [-e, big-code]) style inputs get cut. The cut is a **per-item
// string preview**, never a whole-drop -- on the audit face, ran-node-e-truncated beats a bare NULL.

import { WORLD_READ_INPUT_MAX_BYTES, type WorldReadInput } from "./types.js";

/** Max chars kept per arg in truncated mode: 4 KB split over at most 8 args, minus serialization overhead. */
const TRUNCATED_ARG_MAX_CHARS = 400;
const MAX_ARGS_KEPT = 8;

/** UTF-8 byte length via TextEncoder, not Buffer: this package stays free of node builtins (same discipline as engine.ts). */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** One arg's string preview: strings as-is, else JSON; overlong tails cut with an ellipsis. */
function previewArg(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > TRUNCATED_ARG_MAX_CHARS
    ? `${text.slice(0, TRUNCATED_ARG_MAX_CHARS)}…`
    : text;
}

/**
 * Squeeze {op, args} under {@link WORLD_READ_INPUT_MAX_BYTES}.
 *
 * Fast path: under the cap after serialization, return as-is (args keep their types -- the world.run opts object and
 * git.log's numbers stay themselves). Slow path: each arg becomes a string preview, at most 8 of them, plus a truncated flag.
 * Unserializable args (cycles, BigInt) take the same slow path -- the journal could not represent them anyway.
 */
export function boundWorldReadInput(op: string, args: readonly unknown[]): WorldReadInput {
  const plain: WorldReadInput = { op, args: [...args] };
  try {
    const text = JSON.stringify(plain);
    if (text !== undefined && utf8Length(text) <= WORLD_READ_INPUT_MAX_BYTES) return plain;
  } catch {
    // Fall through to the preview path below.
  }
  return {
    op,
    args: args.slice(0, MAX_ARGS_KEPT).map(previewArg),
    truncated: true,
  };
}
