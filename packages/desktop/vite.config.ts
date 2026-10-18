import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveZCodeEndpointOrigin, pickProductEndpointEnv } from "@zcode/shared/zcodeEndpoint";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { resolveDesktopProductFlavor } from "./scripts/desktop-product-identity.mjs";

const buildMetadata = getBuildMetadata();
const desktopRequire = createRequire(import.meta.url);

interface IstanbulInstrumenter {
  instrumentSync(sourceCode: string, filename: string): string;
  lastFileCoverage(): unknown;
  lastSourceMap(): object | null;
}

interface IstanbulLibInstrument {
  createInstrumenter(options: {
    autoWrap: boolean;
    compact: boolean;
    coverageGlobalScope: string;
    coverageGlobalScopeFunc: boolean;
    esModules: boolean;
    parserPlugins: string[];
    preserveComments: boolean;
    produceSourceMap: boolean;
  }): IstanbulInstrumenter;
}

const { createInstrumenter } = desktopRequire("istanbul-lib-instrument") as IstanbulLibInstrument;

function resolveInstalledPackageRoot(packageName: string): string {
  return dirname(desktopRequire.resolve(`${packageName}/package.json`));
}

export const desktopRendererDependencyAliases = {
  // pnpm hoisted/package-local layouts vary with install configuration; hardcoded node_modules subpaths
  // make Rolldown dependency optimization resolve entries like react/jsx-runtime to nonexistent locations.
  // Resolving the real install root via Node keeps a single React runtime and tolerates any node-linker.
  react: resolveInstalledPackageRoot("react"),
  "react-dom": resolveInstalledPackageRoot("react-dom"),
  "lucide-react": resolveInstalledPackageRoot("lucide-react"),
} as const;

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

function createE2EUIRendererCoveragePlugin(repoRoot: string): Plugin {
  const sourceRoots = [
    resolve(repoRoot, "packages/ui/src"),
    resolve(repoRoot, "packages/desktop/src/renderer"),
  ].map(normalizePathForVite);
  const instrumenter = createInstrumenter({
    autoWrap: true,
    compact: false,
    coverageGlobalScope: "globalThis",
    coverageGlobalScopeFunc: false,
    esModules: true,
    parserPlugins: ["typescript", "jsx"],
    preserveComments: true,
    produceSourceMap: true,
  });
  const baselineCoverage: Record<string, unknown> = {};
  const baselinePath = resolve(
    repoRoot,
    "packages/desktop/out/renderer/e2e-coverage-baseline.json",
  );

  return {
    name: "zcode:e2e-ui-source-coverage",
    enforce: "pre",
    transform(sourceCode, id, options) {
      if (options?.ssr || id.startsWith("\0")) {
        return null;
      }
      const filename = stripViteRequestQuery(id);
      const absoluteFilename = isAbsolute(filename) ? filename : resolve(repoRoot, filename);
      const normalizedFilename = normalizePathForVite(absoluteFilename);
      if (!shouldInstrumentE2EUISource(normalizedFilename, sourceRoots)) {
        return null;
      }

      // Post-transform instrumentation depends on merged Vite/React/esbuild sourcemaps,
      // which project generated-JS coverage points back onto TS source lines such as imports and interfaces.
      // Instrument the original TS/TSX AST before Vite compiles, so the coverage map only contains real runtime code.
      const code = instrumenter.instrumentSync(sourceCode, normalizedFilename);
      baselineCoverage[normalizedFilename] = JSON.parse(
        JSON.stringify(instrumenter.lastFileCoverage()),
      );
      return {
        code,
        map: instrumenter.lastSourceMap(),
      };
    },
    closeBundle() {
      // Reading only the page __coverage__ global drops never-loaded lazy chunks and shrinks the denominator.
      // The coverage build keeps zero-hit maps for the full renderer graph for the suite reporter to merge.
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(baselineCoverage, null, 2)}\n`, "utf-8");
    },
  };
}

function shouldInstrumentE2EUISource(filename: string, sourceRoots: string[]) {
  return (
    isCoverageSourceFile(filename) &&
    !filename.includes("/node_modules/") &&
    !isDeclarationFile(filename) &&
    !isTestSourceFile(filename) &&
    sourceRoots.some((sourceRoot) => isInsidePath(filename, sourceRoot))
  );
}

function isCoverageSourceFile(filename: string) {
  return [".cts", ".cjs", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(extname(filename));
}

function isDeclarationFile(filename: string) {
  return /\.d\.[cm]?ts$/u.test(filename);
}

function isTestSourceFile(filename: string) {
  return /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(filename);
}

function isInsidePath(filename: string, directory: string) {
  return filename === directory || filename.startsWith(`${directory}/`);
}

function normalizePathForVite(path: string) {
  return path.replaceAll("\\", "/");
}

function stripViteRequestQuery(id: string) {
  return id.split("?")[0] ?? id;
}

export default defineConfig(({ mode }) => {
  // `.env*` only provides link-time constants; the product environment is injected via ZCODE_ENV by the startup script or CI.
  const env = { ...loadEnv(mode, "../..", ""), ...process.env };
  const repoRoot = resolve(__dirname, "../..");
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  // Installer identity and backend environment are independent axes; the renderer uses it to decide whether to show the update entry.
  const zcodeProductFlavor = resolveDesktopProductFlavor({
    ...process.env,
    ...env,
    ZCODE_ENV: zcodeEnv,
  });
  const e2eCoverageEnabled =
    env.ZCODE_E2E_COVERAGE === "1" || process.env.ZCODE_E2E_COVERAGE === "1";
  const e2eStoreBridgeEnabled =
    env.VITE_ZCODE_E2E_STORE_BRIDGE === "1" || process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1";
  const zcodeEndpointOrigin = resolveZCodeEndpointOrigin({
    env: zcodeEnv,
    envBaseOrigin: env.ZCODE_BASE_URL ?? env.ZCODE_ENDPOINT_ORIGIN,
  });
  const codingPlanWebviewOrigin =
    env.VITE_CODING_PLAN_WEBVIEW_ORIGIN ?? process.env.VITE_CODING_PLAN_WEBVIEW_ORIGIN ?? "";
  const plugins = [
    ...(e2eCoverageEnabled ? [createE2EUIRendererCoveragePlugin(repoRoot)] : []),
    pdfJsCMapsPlugin(),
    react(),
    tailwindcss(),
  ];

  return {
    root: "src/renderer",
    plugins,
    resolve: {
      alias: {
        // Fix @ alias resolution failures inside the UI component library.
        // Root cause: desktop bundles packages/ui source directly, but this Vite config did not know @ maps to packages/ui/src,
        // breaking internal imports in components such as spinner and alert at build time.
        // Adding the alias on the consumer side is safer than editing each import and stays consistent with web.
        "@": resolve(__dirname, "../ui/src"),
        ...desktopRendererDependencyAliases,
        // Recharts reads the d3-path Path export via d3-shape; hoisted node_modules
        // may keep a stale d3-shape/node_modules/d3-path@1.x, and Vite prebundling hits it first, reporting Missing export.
        // Pin d3-path to the root 3.x entry so desktop dependency optimization and runtime resolution agree.
        "d3-path": resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
      },
      dedupe: ["react", "react-dom", "lucide-react"],
    },
    server: { port: 5174, strictPort: true },
    define: {
      __ZCODE_ENDPOINT_ENV__: JSON.stringify(pickProductEndpointEnv(env)),
      __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
      __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
      __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(zcodeProductFlavor),
      __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__: JSON.stringify(mode !== "production"),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      // Legacy renderer read name; new code reads VITE_ZCODE_BASE_URL.
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      "import.meta.env.VITE_CODING_PLAN_WEBVIEW_ORIGIN": JSON.stringify(codingPlanWebviewOrigin),
      "import.meta.env.VITE_REWARDS_WEBVIEW_ORIGIN": JSON.stringify(
        env.VITE_REWARDS_WEBVIEW_ORIGIN ?? process.env.VITE_REWARDS_WEBVIEW_ORIGIN ?? "",
      ),
      // The E2E store bridge is enabled only by the WDIO-specific variable, avoiding mistaking the ZCODE_ENV=test product env for a test run.
      "import.meta.env.VITE_ZCODE_E2E_STORE_BRIDGE": JSON.stringify(
        e2eStoreBridgeEnabled ? "1" : "",
      ),
    },
    // Electron loads the page via file://; asset paths must be relative or loading fails with ERR_FILE_NOT_FOUND.
    base: "./",
    worker: {
      rollupOptions: {
        // The @pierre/diffs worker entry registers a message listener on import.
        // Its missing package sideEffects declaration lets production worker sub-buildings be tree-shaken to 0B;
        // disable treeshake for the worker build only, leaving the main bundle untouched.
        treeshake: false,
      },
    },
    build: {
      outDir: "../../out/renderer",
      emptyOutDir: true,
      // If production bundles expose sourceMappingURL, attackers can recover business source on the client.
      // Production uses hidden sourcemaps: local/release flows keep .map files without exposing map entries in artifacts.
      sourcemap: mode === "production" ? "hidden" : true,
      rollupOptions: {
        // Multi-entry: main window + process monitor + CUA permission drag panel
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          "resource-manager": resolve(__dirname, "src/renderer/resource-manager.html"),
          "cua-permission-panel": resolve(__dirname, "src/renderer/cua-permission-panel.html"),
        },
      },
    },
  };
});
