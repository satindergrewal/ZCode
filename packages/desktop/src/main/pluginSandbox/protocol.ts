import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { PluginSandboxRegistryPort } from "./contract.js";
import {
  PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX,
  PLUGIN_SANDBOX_SCHEME,
  PLUGIN_SANDBOX_SHELL_HOST_PREFIX,
} from "./contract.js";
import { PLUGIN_SANDBOX_SHELL_CSP, buildPluginSandboxPermissionsPolicy } from "./csp.js";
import { createGenUiVendorResources, type GenUiVendorResources } from "./genUiVendor.js";

/** Bundled artifact file name under out/renderer (vite input name `plugin-sandbox`). */
export const PLUGIN_SANDBOX_SHELL_HTML_FILE = "plugin-sandbox.html";
/** `window.zcode` alias script injected at the top of plugin HTML; same-origin load, no inline nonce dependency. */
export const PLUGIN_SANDBOX_ALIAS_SCRIPT_PATH = "/__zcode__/alias.js";
export const PLUGIN_SANDBOX_ALIAS_SCRIPT_FILE = "plugin-sandbox-alias.js";

export interface PluginSandboxSchemeRegistrar {
  registerSchemesAsPrivileged(
    schemes: Array<{ scheme: string; privileges: Record<string, boolean> }>,
  ): void;
}

/** Must be registered in the same registerSchemesAsPrivileged call as zcode-media (a second call overrides the first). */
export const PLUGIN_SANDBOX_PRIVILEGED_SCHEME = {
  scheme: PLUGIN_SANDBOX_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
} as const;

export interface PluginSandboxProtocolHost {
  handle(scheme: string, handler: (request: Request) => Promise<Response> | Response): void;
  unhandle(scheme: string): void;
  isProtocolHandled(scheme: string): boolean;
}

export interface PluginSandboxAssetSource {
  /** out/renderer dir; the shell HTML and its assets read from here. */
  rendererDir: string;
  /** out/plugin-sandbox dir; the alias script reads from here (separate dir, safe from vite emptyOutDir). */
  aliasDir: string;
  /**
   * In dev (vite dev) out/renderer has no shell artifacts: the shell HTML, /src/*.ts and /@vite/*
   * all proxy from the renderer dev server (ELECTRON_RENDERER_URL). Absent in packaged builds,
   * which use rendererDir.
   */
  devServerUrl?: string;
}

export interface PluginSandboxRequestTarget {
  kind: "shell" | "plugin";
  sandboxId: string;
  pathname: string;
}

/** Parse a zcode-sandbox:// URL; host prefix mismatch, credentials or port yield null. */
export function parsePluginSandboxUrl(rawUrl: string): PluginSandboxRequestTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${PLUGIN_SANDBOX_SCHEME}:` || url.port || url.username || url.password) {
    return null;
  }
  const host = url.hostname;
  if (host.startsWith(PLUGIN_SANDBOX_SHELL_HOST_PREFIX)) {
    const sandboxId = url.pathname.split("/")[2];
    if (!url.pathname.startsWith("/instance/")) return null;
    return sandboxId
      ? { kind: "shell", sandboxId, pathname: "/" + url.pathname.split("/").slice(3).join("/") }
      : null;
  }
  if (host.startsWith(PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX)) {
    const sandboxId = url.pathname.split("/")[2];
    const pathname = "/" + url.pathname.split("/").slice(3).join("/");
    if (!url.pathname.startsWith("/instance/")) return null;
    return sandboxId ? { kind: "plugin", sandboxId, pathname } : null;
  }
  return null;
}

/** Inject the alias script reference at the top of the plugin HTML `<head>` (or document start). */
export function injectPluginSandboxAliasScript(html: string, sandboxId?: string): string {
  const tag = `<script src="${sandboxId ? `/instance/${sandboxId}` : ""}${PLUGIN_SANDBOX_ALIAS_SCRIPT_PATH}"></script>`;
  const headMatch = /<head[^>]*>/i.exec(html);
  if (headMatch) {
    const index = headMatch.index + headMatch[0].length;
    return `${html.slice(0, index)}${tag}${html.slice(index)}`;
  }
  return `${tag}${html}`;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

export function createPluginSandboxProtocolHandler(options: {
  registry: PluginSandboxRegistryPort;
  assets: PluginSandboxAssetSource;
  readAsset?: (absolutePath: string) => Promise<Uint8Array>;
  vendorResources?: GenUiVendorResources;
  logger?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
}): (request: Request) => Promise<Response> {
  const readAsset = options.readAsset ?? ((path: string) => readFile(path));
  const notFound = () => new Response(null, { status: 404 });
  const vendorResources =
    options.vendorResources ?? createGenUiVendorResources(options.assets.aliasDir, readAsset);

  const serveAsset = async (
    baseDir: string,
    relativePath: string,
    headers: Record<string, string>,
  ) => {
    // Path traversal guard: after normalization the path must remain inside baseDir.
    const absolute = normalize(join(baseDir, relativePath));
    const root = normalize(baseDir + sep);
    if (!absolute.startsWith(root)) return notFound();
    try {
      const body = await readAsset(absolute);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": MIME_BY_EXTENSION[extname(absolute)] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          ...headers,
        },
      });
    } catch {
      return notFound();
    }
  };

  const handle = async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const target = parsePluginSandboxUrl(request.url);
    if (!target) return notFound();
    const record = options.registry.get(target.sandboxId);
    if (!record) return notFound();
    if (new URL(request.url).hostname !== `${target.kind}-${record.instance.appIdentity}`)
      return notFound();

    if (target.kind === "shell") {
      const shellHeaders = {
        "Content-Security-Policy": PLUGIN_SANDBOX_SHELL_CSP,
        "Permissions-Policy": buildPluginSandboxPermissionsPolicy(record.permissions, "shell"),
      };
      if (options.assets.devServerUrl) {
        // dev: proxy the whole shell path space same-origin so vite module scripts resolve under
        // zcode-sandbox://shell-<id>.
        const upstreamPath =
          target.pathname === "/" || target.pathname === "/index.html"
            ? `/${PLUGIN_SANDBOX_SHELL_HTML_FILE}`
            : target.pathname;
        const search = new URL(request.url).search;
        try {
          const upstream = await fetch(`${options.assets.devServerUrl}${upstreamPath}${search}`);
          if (!upstream.ok) return new Response(null, { status: upstream.status });
          return new Response(await upstream.arrayBuffer(), {
            status: 200,
            headers: {
              "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
              ...shellHeaders,
            },
          });
        } catch {
          return new Response(null, { status: 502 });
        }
      }
      if (target.pathname === "/" || target.pathname === "/index.html") {
        return serveAsset(options.assets.rendererDir, PLUGIN_SANDBOX_SHELL_HTML_FILE, shellHeaders);
      }
      if (target.pathname.startsWith("/assets/")) {
        return serveAsset(options.assets.rendererDir, target.pathname.slice(1), shellHeaders);
      }
      return notFound();
    }

    if (record.contentKind === "gen-ui" && target.pathname.startsWith("/__zcode__/vendor/")) {
      const file = target.pathname.slice("/__zcode__/vendor/".length);
      try {
        if (!(await vendorResources.hasFile(file))) return notFound();
        return serveAsset(join(options.assets.aliasDir, "vendor"), file, {
          "Content-Security-Policy": record.cspHeader,
        });
      } catch {
        return new Response(null, { status: 500 });
      }
    }
    if (record.contentKind === "gen-ui" && target.pathname === "/__zcode__/gen-ui.js") {
      return serveAsset(options.assets.aliasDir, "gen-ui.js", {
        "Content-Security-Policy": record.cspHeader,
      });
    }
    if (record.contentKind !== "gen-ui" && target.pathname === PLUGIN_SANDBOX_ALIAS_SCRIPT_PATH) {
      return serveAsset(options.assets.aliasDir, PLUGIN_SANDBOX_ALIAS_SCRIPT_FILE, {
        "Content-Security-Policy": record.cspHeader,
      });
    }
    if (target.pathname === "/" || target.pathname === "/index.html") {
      let html =
        record.contentKind === "gen-ui"
          ? record.html.replace(
              "__ZCODE_GEN_UI_RUNTIME__",
              `/instance/${record.sandboxId}/__zcode__/gen-ui.js`,
            )
          : injectPluginSandboxAliasScript(record.html, record.sandboxId);
      if (record.contentKind === "gen-ui") {
        try {
          const [styles, kit] = await Promise.all([
            readAsset(join(options.assets.aliasDir, "visualize.css")),
            readAsset(join(options.assets.aliasDir, "visualize.html")),
          ]);
          const decode = (value: Uint8Array) => new TextDecoder().decode(value);
          // bridge/Tweak before author scripts, inner kit after the fragment; the old hand-written
          // Widgets changed upstream initialization semantics.
          html = html.replace(
            "<!--__ZCODE_GEN_UI_STYLES__-->",
            `<style>${decode(styles)}\n:root { --visualize-paint-gutter: 5px; --viz-fg: var(--foreground); }</style>`,
          );
          if (/\bviz-calendar\b/i.test(record.html)) {
            const calendar = decode(await readAsset(join(options.assets.aliasDir, "calendar.js")));
            html = html.replace(
              "</head>",
              `<script>${calendar.replaceAll("</script", "<\\/script")}</script></head>`,
            );
          }
          const marker = "<!--__ZCODE_GEN_UI_INNER_KIT__-->";
          const index = html.lastIndexOf(marker);
          if (index < 0) throw new Error("Gen UI document is missing its runtime slot");
          html =
            html.slice(0, index) +
            decode(kit).replace("<!--__INLINE_VISUALIZATION_FRAGMENT__-->", "") +
            // Transient tab-switch overflow can leave an empty scrollbar after growth; hide only
            // the root scrollbar, never clipping content or disabling author scroll areas.
            '<style id="zcode-gen-ui-document-scrollbar">html,body{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}</style>' +
            html.slice(index + marker.length);
        } catch {
          // Missing resources must not yield a half-built document; the page would look loaded
          // while interactions silently fail.
          options.logger?.warn("[plugin-sandbox] Gen UI runtime resources unavailable");
          return new Response(null, { status: 500 });
        }
      }
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": record.cspHeader,
          "Permissions-Policy": buildPluginSandboxPermissionsPolicy(record.permissions, "plugin"),
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return notFound();
  };

  return async (request) => {
    const response = await handle(request);
    // A stable origin shares the Chromium resource cache; disabling only HTML caching would let
    // already-loaded scripts bypass later guest-ownership checks. Disable caching on every
    // instance response; browser business storage keeps its own semantics.
    response.headers.set("Cache-Control", "no-store");
    // Log plugin document and alias-script requests at info (not shell static assets) so a blank
    // sandbox page can be attributed to 404 vs script-never-ran.
    const isShellAsset = request.url.includes(`://${PLUGIN_SANDBOX_SHELL_HOST_PREFIX}`);
    if (!isShellAsset || response.status >= 400) {
      const line = `[plugin-sandbox] ${request.method} ${request.url} -> ${response.status} type=${response.headers.get("Content-Type") ?? ""} csp=${response.headers.get("Content-Security-Policy") ?? ""}`;
      if (response.status >= 400) options.logger?.warn(line);
      else options.logger?.info?.(line);
    }
    return response;
  };
}

const installedProtocols = new WeakSet<PluginSandboxProtocolHost>();

export function installPluginSandboxProtocol(
  protocol: PluginSandboxProtocolHost,
  handler: (request: Request) => Promise<Response>,
): void {
  if (installedProtocols.has(protocol)) return;
  protocol.handle(PLUGIN_SANDBOX_SCHEME, handler);
  installedProtocols.add(protocol);
}

export function uninstallPluginSandboxProtocol(protocol: PluginSandboxProtocolHost): void {
  if (!installedProtocols.has(protocol)) return;
  if (protocol.isProtocolHandled(PLUGIN_SANDBOX_SCHEME)) protocol.unhandle(PLUGIN_SANDBOX_SCHEME);
  installedProtocols.delete(protocol);
}
