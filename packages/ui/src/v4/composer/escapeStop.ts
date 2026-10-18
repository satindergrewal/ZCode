// composer parity: the Esc-to-stop ignore decision (pure, host-free).
export function shouldIgnoreEscapeForStopGeneration(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) {
    return true;
  }

  const path = event.composedPath();
  return path.some((target) => {
    if (!target || typeof target !== "object") {
      return false;
    }

    const maybeElement = target as {
      dataset?: { slot?: string };
      getAttribute?: (name: string) => string | null;
    };
    return (
      // The Cmd/Ctrl+P file picker closing with Escape lets the same event
      // bubble to the window; detect Radix/Dialog paths and skip stop, so closing a dialog never stops the run.
      maybeElement.dataset?.slot === "dialog-content" ||
      maybeElement.getAttribute?.("role") === "dialog"
    );
  });
}
