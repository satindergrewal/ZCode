import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);
const PDFJS_CMAP_OUTPUT_DIRECTORY = "pdfjs/cmaps";

export interface PdfJsCMapAsset {
  fileName: string;
  source: Uint8Array;
}

export function resolvePdfJsCMapsDirectory(): string {
  return join(dirname(require.resolve("pdfjs-dist/package.json")), "cmaps");
}

export async function listPdfJsCMapAssets(): Promise<PdfJsCMapAsset[]> {
  const cMapsDirectory = resolvePdfJsCMapsDirectory();
  const entries = await readdir(cMapsDirectory, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".bcmap"))
      .map(async (entry) => ({
        fileName: `${PDFJS_CMAP_OUTPUT_DIRECTORY}/${entry.name}`,
        source: await readFile(join(cMapsDirectory, entry.name)),
      })),
  );
}

export function pdfJsCMapsPlugin(): Plugin {
  return {
    name: "zcode:pdfjs-cmaps",
    // Vite serve runs buildStart too, but dev mode cannot emitFile.
    // CMap assets are only emitted in generateBundle; dev mode keeps using the middleware below.
    async generateBundle() {
      for (const asset of await listPdfJsCMapAssets()) {
        this.emitFile({
          type: "asset",
          fileName: asset.fileName,
          source: asset.source,
        });
      }
    },
    configureServer(server) {
      const cMapsDirectory = resolvePdfJsCMapsDirectory();
      server.middlewares.use((request, response, next) => {
        const requestPath = request.url?.split("?", 1)[0] ?? "";
        const marker = `/${PDFJS_CMAP_OUTPUT_DIRECTORY}/`;
        const markerIndex = requestPath.indexOf(marker);
        if (markerIndex < 0) {
          next();
          return;
        }

        const fileName = requestPath.slice(markerIndex + marker.length);
        if (
          fileName.length === 0 ||
          fileName !== basename(fileName) ||
          !fileName.endsWith(".bcmap")
        ) {
          next();
          return;
        }

        // PDF.js does not bundle predefined CMaps into the worker, and ReportLab's STSong-Light
        // references UniGB-UCS2-H without embedding the mapping. Dev mode must serve local CMaps
        // exactly like the production build, or the in-app PDF.js viewer drops whole CJK runs
        // even though native browser preview looks fine.
        readFile(join(cMapsDirectory, fileName))
          .then((source) => {
            response.statusCode = 200;
            response.setHeader("Content-Type", "application/octet-stream");
            response.end(source);
          })
          .catch((error: unknown) => {
            next(error);
          });
      });
    },
  };
}
