/** Runs in the main world before Electron registers the webview; functions must not capture preload closures. */
export function enableSandboxRetainedMoves(): boolean {
  if (typeof Element.prototype.moveBefore !== "function") return false;
  const define = customElements.define;
  customElements.define = function (name, constructor, options) {
    if (name === "webview") {
      const prototype = constructor.prototype as HTMLElement & {
        connectedCallback(): void;
        disconnectedCallback(): void;
        connectedMoveCallback?: () => void;
      };
      // Electron 41 has no move callbacks registered; moveBefore still detaches/reattaches and
      // wipes the guest. Marked-only sandboxes skip this pair; real removes keep stock webview behavior.
      if (!prototype.connectedMoveCallback) {
        const connect = prototype.connectedCallback,
          disconnect = prototype.disconnectedCallback;
        prototype.connectedMoveCallback = function () {
          if (this.hasAttribute("data-zcode-retained-sandbox")) return;
          disconnect.call(this);
          connect.call(this);
        };
      }
      customElements.define = define;
    }
    return define.call(this, name, constructor, options);
  };
  return true;
}
