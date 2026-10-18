import { useEffect, useRef, useState } from "react";

/**
 * The draft's pen.
 *
 * The model's script arrives in chunks; the scanner sees jumps: a whole `phase("implement")` in one delta, sometimes
 * two phases at once. The pen turns jumps back into handwriting: one station at a time, `PEN_MS` per character, pause `PEN_GAP_MS`
 * after a station before revealing the next — stations the pen has not reached are not on the rail yet, even once the scanner knows them. A name growing mid-write (an unclosed
 * `phase("ver` gaining characters) keeps the pen writing; a shortened or changed prefix (should not happen, but streams must be robust) rewinds to the common prefix.
 *
 * `names` is the scanner's current station-name sequence; undefined means not a draft and the hook idles. The timer keys on **content** changes
 * (keyed by content), so a fresh array per chunk never interrupts a running pen.
 * Under `prefers-reduced-motion: reduce` each station completes instantly (still revealed station by station, just not per character).
 *
 * Revision (root cause of the GUI crash React #185):
 * The pen only reveals **when there is a station to reveal**. "Reveal immediately while there is no station", unchecked, would let an empty draft (the script's leading `meta`
 * not yet written up to the first `phase(`) reveal a non-existent station, get clipped back to 0 next round, reveal again... an infinite setState loop in an effect.
 * The spinning itself only burns CPU, but it keeps one pending update in React's hands at all times; once projection frames pile up into dozens of consecutive
 * synchronous commits, the nested-update count passes 50, React throws #185, and the whole chat area falls to the error boundary.
 */
export const PEN_MS = 24;
export const PEN_GAP_MS = 120;

export interface TypewriterState {
  /** Revealed station count (stations the pen reached); later stations are not on the rail yet. */
  visible: number;
  /** Characters written for each revealed station. */
  shown: readonly number[];
  /** The pen caught up with the stream (nothing to write, nothing to reveal): the cursor blinks. */
  idle: boolean;
}

interface PenState {
  visible: number;
  shown: number[];
}

const SILENT: TypewriterState = { idle: false, shown: [], visible: 0 };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/** When a station name changed (shortened / prefix changed / fewer stations), rewind the pen to the last still-valid position; return unchanged otherwise. */
function reconcile(
  state: PenState,
  names: readonly string[],
  previous: readonly string[],
): PenState {
  const visible = Math.min(state.visible, names.length);
  let changed = visible !== state.visible;
  const shown = state.shown.slice(0, visible).map((count, i) => {
    const next = Math.min(count, commonPrefix(previous[i] ?? "", names[i]!));
    if (next !== count) changed = true;
    return next;
  });
  return changed ? { shown, visible } : state;
}

/**
 * Characters written per revealed station. Under reduced-motion a whole station counts as written — **derive during render** instead of another setState round in an effect:
 * station names lengthen with every delta, and that effect's setState lands inside the projection frame's synchronous commit, charging the nested-update
 * counter on every frame.
 */
function shownOf(state: PenState, names: readonly string[], reduced: boolean): readonly number[] {
  return reduced ? state.shown.map((_, i) => names[i]?.length ?? 0) : state.shown;
}

export function useTypewriter(names: readonly string[] | undefined): TypewriterState {
  const [state, setState] = useState<PenState>({ shown: [], visible: 0 });
  // The separator is NUL (never occurs in a station name) so ["a b"] and ["a", "b"] cannot collide into one key. A bare NUL byte cannot be written
  // literally in source: git treats the whole file as binary; use the escaped form, same content.
  const key = names?.join("\u0000");
  const namesRef = useRef<readonly string[]>([]);
  const lastRef = useRef<readonly string[]>([]);
  if (names !== undefined) namesRef.current = names;

  useEffect(() => {
    if (key === undefined) return undefined;
    const current = namesRef.current;
    const previous = lastRef.current;
    lastRef.current = current;
    const pen = reconcile(state, current, previous);
    if (pen !== state) {
      setState(pen);
      return undefined;
    }
    const reduced = prefersReducedMotion();
    const at = pen.visible - 1;
    const target = at >= 0 ? current[at]! : undefined;
    const written = target === undefined ? 0 : (shownOf(pen, current, reduced)[at] ?? 0);
    if (target !== undefined && written < target.length) {
      // Write the current station character by character (under reduced-motion `written` is already the whole station; never reaches here).
      const timer = setTimeout(() => {
        const shown = pen.shown.slice();
        shown[at] = written + 1;
        setState({ shown, visible: pen.visible });
      }, PEN_MS);
      return () => clearTimeout(timer);
    }
    // Current station finished (or none yet): **reveal only if a next exists** — an empty draft does nothing.
    if (current.length <= pen.visible) return undefined;
    const reveal = () => setState({ shown: [...pen.shown, 0], visible: pen.visible + 1 });
    if (target === undefined) {
      reveal();
      return undefined;
    }
    const timer = setTimeout(reveal, PEN_GAP_MS);
    return () => clearTimeout(timer);
  }, [key, state]);

  if (names === undefined) return SILENT;
  const shown = shownOf(state, names, prefersReducedMotion());
  const at = state.visible - 1;
  const idle = at >= 0 && state.visible === names.length && (shown[at] ?? 0) >= names[at]!.length;
  return { idle, shown, visible: state.visible };
}
