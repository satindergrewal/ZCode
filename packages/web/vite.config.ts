import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { thirdPartyNoticesVitePlugin } from "../../scripts/third-party-notices.mjs";
import { resolveRemoteFrontendVersion } from "./vite/remoteFrontendVersion.mjs";
// Bugfix: the Vite config runs during Node loading and must not import the @zcode/shared root entry.
// The root entry re-exports NodeNext-style sources; Node looks up real .js files and fails during bootstrap.
import {
  resolveRuntimeZCodeEndpointOrigin,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
} from "@zcode/shared/zcodeEndpoint";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export default defineConfig(({ mode }) => {
  // `.env*` files only carry link constants; the product env is injected via ZCODE_ENV by the start script or CI.
  // The start script picks test/production explicitly via process.env and must take precedence over .env files,
  // or share:test may resolve stale mode config onto the wrong endpoint.
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  const endpointEnv = {
    ...env,
    ZCODE_ENV: zcodeEnv,
  };
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);
  const zaiOAuthOrigin = resolveZaiOAuthOrigin(endpointEnv);
  // The ZAI OAuth client_id is public and may be injected into the browser bundle; secrets/tokens never go through VITE_.
  const zaiOAuthClientId = resolveZaiOAuthClientId(endpointEnv);

  return {
    plugins: [pdfJsCMapsPlugin(), react(), tailwindcss(), thirdPartyNoticesVitePlugin()],
    resolve: {
      alias: {
        // Fix @ alias resolution failures from the UI component library.
        // Cause: packages/ui sources are bundled by the web app directly, but web never declared @ -> packages/ui/src,
        // so imports like "@/components/lib/utils" fail module resolution during the runtime build.
        // Add the alias in the consumer Vite config, leaving component sources untouched for the smallest blast radius.
        "@": resolve(__dirname, "../ui/src"),
        // Recharts depends on d3-shape@3.x, which needs d3-path's Path export.
        // Hoisted node_modules can expose a stale d3-path@1.x next to d3-shape to Vite prebundling,
        // breaking desktop/web dev during dependency optimization; pin the root 3.x entry to fix resolution.
        "d3-path": resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        // For local web-login debugging the OAuth token exchange must hit the production same-origin endpoint first.
        // This dedicated proxy sits before the `/api` wildcard so requests never fall through to the local server as 404s.
        "/api/v1/oauth/token": {
          target: zcodeEndpointOrigin,
          changeOrigin: true,
          secure: true,
        },
        // Proxy /ws and /api requests to the server (port 3030 by default)
        "/ws": { target: "ws://localhost:3030", ws: true },
        "/api": { target: "http://localhost:3030" },
      },
    },
    optimizeDeps: {
      // Fix: add the react entries to prebundling explicitly so rolldown resolving `react/jsx-runtime`
      // or `react/jsx-dev-runtime` never gets extensionless paths and fails to load (UNLOADABLE_DEPENDENCY).
      include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    worker: {
      rollupOptions: {
        // The @pierre/diffs worker entry registers its message listener after import.
        // A missing package sideEffects entry tree-shakes the production worker sub-build to 0B;
        // disable tree-shaking for the worker build only, leaving the main package alone.
        treeshake: false,
      },
    },
    define: {
      __ZCODE_VERSION__: JSON.stringify(
        resolveRemoteFrontendVersion(version, process.env.WEB_REMOTE_FRONTEND_VERSION),
      ),
      __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "unknown"),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      // Legacy web runtime read name; new code reads VITE_ZCODE_BASE_URL.
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      // Inject the public OAuth config explicitly so no web mode relies on implicit source fallbacks.
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(zaiOAuthClientId),
      "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(zaiOAuthOrigin),
    },
    build: {
      // Production omits sourceMappingURL from browser artifacts so clients cannot reconstruct app sources.
      sourcemap: mode === "production" ? "hidden" : true,
    },
  };
});
