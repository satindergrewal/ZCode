import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { thirdPartyNoticesVitePlugin } from "../../scripts/third-party-notices.mjs";
// vite.config runs during Node module loading and cannot import the @zcode/shared root entry:
// it NodeNext-re-exports sources, Node resolves the .js specifiers literally, and bootstrap fails.
import {
  resolveRuntimeZCodeEndpointOrigin,
  pickProductEndpointEnv,
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
  // `.env*` only carries link constants; ZCODE_ENV selects the product environment and is
  // injected by the start script or CI. The process.env value must win over .env files, or
  // share:test may resolve a stale mode config to the wrong endpoint.
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  const endpointEnv = {
    ...env,
    ZCODE_ENV: zcodeEnv,
  };
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);
  const zaiOAuthOrigin = resolveZaiOAuthOrigin(endpointEnv);
  // The ZAI OAuth client_id is public and safe to bundle; secrets/tokens never go through VITE_.
  const zaiOAuthClientId = resolveZaiOAuthClientId(endpointEnv);

  return {
    plugins: [pdfJsCMapsPlugin(), react(), tailwindcss(), thirdPartyNoticesVitePlugin()],
    resolve: {
      alias: {
        // Fix @ alias resolution for the UI package.
        // Cause: web feeds packages/ui sources straight to Vite, but web never declared
        // @ -> packages/ui/src, so imports like "@/components/lib/utils" fail module
        // resolution during build. Declaring the alias here on the consumer side keeps the
        // component sources untouched -- smallest possible blast radius.
        "@": resolve(__dirname, "../ui/src"),
        // Recharts needs d3-shape@3.x, which requires the Path export of d3-path.
        // Hoisted node_modules can expose a stale d3-path@1.x next to d3-shape to prebundling,
        // failing dependency optimization on desktop and web; pin the root 3.x entry explicitly.
        "d3-path": resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        // For local web sign-in debugging the OAuth token exchange must hit the live same-origin
        // API. This dedicated proxy sits before the `/api` wildcard so requests are not forwarded
        // to the local server and 404ing.
        "/api/v1/oauth/token": {
          target: zcodeEndpointOrigin,
          changeOrigin: true,
          secure: true,
        },
        // Proxy /ws and /api to the server (port 3030 by default)
        "/ws": { target: "ws://localhost:3030", ws: true },
        "/api": { target: "http://localhost:3030" },
      },
    },
    optimizeDeps: {
      // Fix: include the react entries in prebundling explicitly; rolldown otherwise resolves
      // `react/jsx-runtime` / `react/jsx-dev-runtime` to extension-less paths and the load fails
      // with UNLOADABLE_DEPENDENCY.
      include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    worker: {
      rollupOptions: {
        // The @pierre/diffs worker entry registers message listeners at import time. Its package
        // metadata misses sideEffects, so tree-shaking flattens the production worker chunk to 0B;
        // disable shaking for the worker build only, leaving the main bundle untouched.
        treeshake: false,
      },
    },
    define: {
      __ZCODE_ENDPOINT_ENV__: JSON.stringify(pickProductEndpointEnv(env)),
      __ZCODE_VERSION__: JSON.stringify(version),
      __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "unknown"),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      // Legacy web runtime name; new code reads VITE_ZCODE_BASE_URL.
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      // Inject the public OAuth config explicitly so no mode relies on source-level fallbacks.
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(zaiOAuthClientId),
      "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(zaiOAuthOrigin),
    },
    build: {
      // Production omits sourceMappingURL from browser assets, keeping app sources out of the client.
      sourcemap: mode === "production" ? "hidden" : true,
    },
  };
});
