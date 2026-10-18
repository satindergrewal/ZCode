import type { BrowserKeyModifier, BrowserMouseButton } from "@zcode/shared";
import { RESOLVE_SCRIPT } from "./browserCommandScripts.js";
import type { BrowserPoint, ControlledView } from "./browserCommandTypes.js";

/**
 * Keyboard modifiers -> CDP modifiers bitmask (Alt=1, Control=2, Meta=4, Shift=8).
 * click/press/drag share this map and pass it to dispatchMouseEvent/dispatchKeyEvent.
 */
const MODIFIER_BITS: Record<BrowserKeyModifier, number> = {
  Alt: 1,
  Control: 2,
  ControlOrMeta: process.platform === "darwin" ? 4 : 2,
  Meta: 4,
  Shift: 8,
};

/**
 * Common key names -> CDP Input.dispatchKeyEvent params.
 * Unknown keys pass through bare (key field only) for best-effort kernel interpretation.
 */
const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
};

const MODIFIER_KEY_MAP: Record<
  BrowserKeyModifier,
  { code: string; windowsVirtualKeyCode: number }
> = {
  Alt: { code: "AltLeft", windowsVirtualKeyCode: 18 },
  Control: { code: "ControlLeft", windowsVirtualKeyCode: 17 },
  ControlOrMeta:
    process.platform === "darwin"
      ? { code: "MetaLeft", windowsVirtualKeyCode: 91 }
      : { code: "ControlLeft", windowsVirtualKeyCode: 17 },
  Meta: { code: "MetaLeft", windowsVirtualKeyCode: 91 },
  Shift: { code: "ShiftLeft", windowsVirtualKeyCode: 16 },
};

function normalizeCuaKey(raw: string): string {
  const key = raw.trim();
  const alias: Record<string, string> = {
    alt: "Alt",
    option: "Alt",
    control: "Control",
    ctrl: "Control",
    controlormeta: process.platform === "darwin" ? "Meta" : "Control",
    cmd: "Meta",
    meta: "Meta",
    super: "Meta",
    win: "Meta",
    shift: "Shift",
    esc: "Escape",
    return: "Enter",
    space: "Space",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
  };
  return alias[key.toLowerCase()] ?? key;
}

function asModifier(key: string): BrowserKeyModifier | undefined {
  return ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(key)
    ? (key as BrowserKeyModifier)
    : undefined;
}

function keyDefinition(keyName: string): {
  key: string;
  code?: string;
  windowsVirtualKeyCode?: number;
} {
  const known = KEY_MAP[keyName];
  if (known) return known;
  const modifier = asModifier(keyName);
  if (modifier) return { key: modifier, ...MODIFIER_KEY_MAP[modifier] };
  if (/^[a-z]$/iu.test(keyName)) {
    const upper = keyName.toUpperCase();
    return { key: keyName, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/u.test(keyName)) {
    return {
      key: keyName,
      code: `Digit${keyName}`,
      windowsVirtualKeyCode: keyName.charCodeAt(0),
    };
  }
  return { key: keyName };
}

export function modifiersBitmask(mods?: readonly BrowserKeyModifier[]): number {
  if (!mods || mods.length === 0) return 0;
  let bits = 0;
  for (const m of mods) bits |= MODIFIER_BITS[m];
  return bits;
}

/** Resolves the ref element's center; not found (or malformed) -> null. */
export async function resolveRefCenter(
  view: ControlledView,
  ref: string,
): Promise<BrowserPoint | null> {
  const raw = (await view.webContents.executeJavaScript(RESOLVE_SCRIPT(ref))) as {
    cx?: unknown;
    cy?: unknown;
  } | null;
  if (!raw || typeof raw.cx !== "number" || typeof raw.cy !== "number") return null;
  return { cx: raw.cx, cy: raw.cy };
}

/** One real CDP mouse click at the given coordinates (mouseMoved->Pressed->Released). */
export async function dispatchClickAt(
  view: ControlledView,
  center: BrowserPoint,
  button: BrowserMouseButton,
  doubleClick: boolean,
  modifiers = 0,
): Promise<void> {
  const clickCount = doubleClick ? 2 : 1;
  // Omit the field when modifiers=0, matching existing tests that assert without it.
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: center.cx,
    y: center.cy,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: center.cx,
    y: center.cy,
    button,
    clickCount,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: center.cx,
    y: center.cy,
    button,
    clickCount,
    ...mod,
  });
}

/**
 * Drag from->to: mousePressed@from -> interpolated mouseMoved -> mouseReleased@to (with modifiers).
 * In-flight mouseMoved carries buttons:1 (left held) so the kernel reads a drag, not a move.
 */
export async function dispatchDrag(
  view: ControlledView,
  from: BrowserPoint,
  to: BrowserPoint,
  modifiers = 0,
): Promise<void> {
  const mod = modifiers > 0 ? { modifiers } : {};
  const STEPS = 10;
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: from.cx,
    y: from.cy,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.cx,
    y: from.cy,
    button: "left",
    clickCount: 1,
    ...mod,
  });
  for (let i = 1; i <= STEPS; i++) {
    const x = Math.round(from.cx + ((to.cx - from.cx) * i) / STEPS);
    const y = Math.round(from.cy + ((to.cy - from.cy) * i) / STEPS);
    await view.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "left",
      buttons: 1,
      ...mod,
    });
  }
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.cx,
    y: to.cy,
    button: "left",
    clickCount: 1,
    ...mod,
  });
}

/** Drag input keeps the caller's path point-by-point; freehand/curves never collapse to a chord. */
export async function dispatchDragPath(
  view: ControlledView,
  path: readonly { x: number; y: number }[],
  modifiers = 0,
): Promise<void> {
  const [first, ...rest] = path;
  if (!first) throw new Error("cua_drag requires a non-empty path");
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: first.x,
    y: first.y,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: first.x,
    y: first.y,
    button: "left",
    clickCount: 1,
    ...mod,
  });
  let last = first;
  try {
    for (const point of rest) {
      last = point;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        ...mod,
      });
    }
  } finally {
    await view.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: last.x,
      y: last.y,
      button: "left",
      clickCount: 1,
      ...mod,
    });
  }
}

/** CUA scroll: move to the anchor, then send real wheel input from there. */
export async function dispatchScrollGesture(
  view: ControlledView,
  point: BrowserPoint,
  scrollX: number,
  scrollY: number,
  modifiers = 0,
): Promise<void> {
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.cx,
    y: point.cy,
    ...mod,
  });
  // On Electron 41/Chromium 146, webview guests make
  // Input.synthesizeScrollGesture silently no-op -- no wheel events, page never scrolls.
  // mouseWheel stays trusted input on the anchor and keeps nested scrollers/wheel handlers working.
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.cx,
    y: point.cy,
    deltaX: scrollX,
    deltaY: scrollY,
    ...mod,
  });
}

/** Combo keys: press in order, then release the others in reverse after the last key's down/up. */
export async function dispatchKeyPress(
  view: ControlledView,
  keys: readonly string[],
): Promise<void> {
  const normalized = keys
    .flatMap((key) => key.split("+"))
    .filter(Boolean)
    .map(normalizeCuaKey);
  const last = normalized.at(-1);
  if (!last) throw new Error("keypress requires at least one key");
  const held = normalized.slice(0, -1);
  const pressedModifiers = new Set<BrowserKeyModifier>();

  const dispatch = async (type: "keyDown" | "keyUp", keyName: string): Promise<void> => {
    const modifier = asModifier(keyName);
    if (type === "keyDown" && modifier) pressedModifiers.add(modifier);
    if (type === "keyUp" && modifier) pressedModifiers.delete(modifier);
    const definition = keyDefinition(keyName);
    const modifiers = modifiersBitmask([...pressedModifiers]);
    await view.cdp.send("Input.dispatchKeyEvent", {
      type,
      ...definition,
      ...(modifiers > 0 ? { modifiers } : {}),
    });
  };

  for (const key of held) await dispatch("keyDown", key);
  await dispatch("keyDown", last);
  await dispatch("keyUp", last);
  for (const key of held.toReversed()) await dispatch("keyUp", key);
}

//** One keypress (keyDown+keyUp); known keys fully mapped, unknown keys bare. modifiers bitmask passthrough. */
export async function dispatchKey(
  view: ControlledView,
  keyName: string,
  modifiers = 0,
  sessionId?: string,
): Promise<void> {
  const def = KEY_MAP[keyName];
  const base = def
    ? { key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode }
    : { key: keyName };
  // Omit the field when modifiers=0, matching existing tests that assert without it.
  const mod = modifiers > 0 ? { modifiers } : {};
  const sendKey = (type: "keyDown" | "keyUp") =>
    sessionId == null
      ? view.cdp.send("Input.dispatchKeyEvent", { type, ...base, ...mod })
      : view.cdp.send("Input.dispatchKeyEvent", { type, ...base, ...mod }, sessionId);
  await sendKey("keyDown");
  await sendKey("keyUp");
}
