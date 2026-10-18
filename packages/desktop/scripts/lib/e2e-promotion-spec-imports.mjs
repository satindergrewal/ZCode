import { readFileSync, writeFileSync } from "node:fs";

export function rewriteFormalSpecImports(specPath) {
  const original = readFileSync(specPath, "utf8");
  // Root cause: pending specs nest two dirs deeper than formal ones; rewriting only helpers/pages
  // lets case-local file fixtures drift to packages/desktop/fixtures after promotion and ENOENT at
  // runtime.
  const rewritten = original
    .replaceAll("../../../helpers/", "../helpers/")
    .replaceAll("../../../pages/", "../pages/")
    .replaceAll("../../../fixtures/", "../fixtures/");
  if (rewritten !== original) {
    writeFileSync(specPath, rewritten, "utf8");
  }
}
