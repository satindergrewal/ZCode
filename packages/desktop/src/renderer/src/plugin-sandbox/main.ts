import { createPluginSandboxRelay, resolvePluginSandboxShellIdentity } from "./relay.js";

/**
 * DOM wiring for the trusted relay shell: await the preload-handed init frame, create the plugin
 * iframe, accept only messages from that iframe with origin plugin-<id>, and forward verbatim to
 * the host port; the reverse direction too.
 */
const root = document.getElementById("root") ?? document.body;
const errorNode = document.getElementById("error");
const identity = resolvePluginSandboxShellIdentity(window.location.href);
let frameElement: HTMLIFrameElement | null = null;

function showError(message: string): void {
  if (errorNode) {
    errorNode.textContent = message;
    errorNode.hidden = false;
  }
}

if (!identity) {
  showError(`Plugin sandbox: unexpected shell origin ${window.location.origin}`);
} else {
  const relay = createPluginSandboxRelay({
    ...identity,
    createPluginFrame(src, allow) {
      const iframe = document.createElement("iframe");
      // Spec MUSTs: allow-scripts + allow-same-origin; allow-forms for form interaction.
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      // Resource-declared permissions (camera/microphone/geolocation/clipboard-write) delegate to
      // the cross-origin plugin iframe; the main permission gate still decides (undeclared
      // rejected, first-use prompt).
      if (allow) iframe.setAttribute("allow", allow);
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.title = "plugin";
      iframe.src = src;
      iframe.addEventListener("error", () =>
        console.warn(`[plugin-sandbox-shell] frame error src=${src}`),
      );
      root.appendChild(iframe);
      frameElement = iframe;
      return {
        postMessage(message, targetOrigin) {
          iframe.contentWindow?.postMessage(message, targetOrigin);
        },
        remove() {
          iframe.remove();
          if (frameElement === iframe) frameElement = null;
        },
      };
    },
    showError,
    log: (message) => console.warn(message),
  });

  window.addEventListener("message", (event) => {
    // preload postMessages on this same window; the plugin iframe's messages carry its contentWindow as source.
    if (event.source === window && event.origin === window.location.origin) {
      relay.handleInit(
        event.data,
        event.ports as unknown as Parameters<typeof relay.handleInit>[1],
      );
      return;
    }
    if (
      frameElement &&
      event.source === frameElement.contentWindow &&
      event.origin === identity.pluginOrigin
    ) {
      relay.handleFrameMessage(event.data);
      return;
    }
    // Drop any message with unexpected source/origin; guest console lands in main logs, easing sandbox-origin triage.
    console.warn(
      `[plugin-sandbox-shell] dropped message origin=${event.origin} expected=${identity.pluginOrigin} fromFrame=${String(
        Boolean(frameElement && event.source === frameElement.contentWindow),
      )}`,
    );
  });

  window.addEventListener("beforeunload", () => relay.dispose());
}
