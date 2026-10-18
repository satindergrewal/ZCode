#!/usr/bin/env node
/* eslint-disable max-lines -- single script owning third-party license inventory/notices/gating; data tables and checks live together. */
// Third-party license inventory / notices / gate, in one script
//
// Usage:
//   node scripts/licenses.mjs notices   generate THIRD-PARTY-NOTICES.md (exact versions, original copyrights and license texts)
//   node scripts/licenses.mjs check     manual gate: exit 1 if any package is outside the allowlist or has an unknown license
//
// Data model:
// - Installed set = the recursive union of all workspace node_modules, including nested versions and symlinks.
// - Notices: third-party-npm.mjs collects real license files by exact production-dependency versions.
// - prod determination uses exact versions from the lockfile production graph.
// - Commercial/semi-open checks apply to the full installed set (prod+dev)
import { generateThirdPartyNotices } from "./generate-third-party-notices.mjs";
import { readVerifiedNotices } from "./third-party-notices.mjs";
import { readFile } from "node:fs/promises";
import {
  readWorkspaceProductionGraph,
  scanInstalledPackages,
  missingProductionPackages,
} from "./third-party-npm.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "notices";
if (command === "notices") {
  await generateThirdPartyNotices(ROOT);
  process.exit(0);
}

// The identity gate and notices generation share the workspace graph and recursive scan; never guess the prod set from package names.
const { required, projects } = await readWorkspaceProductionGraph(ROOT);
const ownNames = new Set(projects.map((project) => project.name));
const installed = new Map();
const MANUAL_LICENSE = {
  "exif-parser": "MIT", // in-package LICENSE.md
  khroma: "MIT", // in-package license file
  semaphore: "MIT", // License section of in-package README
  "css-value": "MIT", // License section of in-package Readme
  "@fig/autocomplete-helpers": "MIT", // in-package LICENSE
};
function normLicense(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(normLicense).join(" OR ");
  return value?.type?.trim() || "(missing)";
}
const scanned = await scanInstalledPackages(ROOT, projects);
missingProductionPackages(required, scanned);
for (const [key, { pkg }] of scanned) {
  if (ownNames.has(pkg.name)) continue;
  installed.set(key, {
    name: pkg.name,
    version: pkg.version,
    license: normLicense(pkg.license ?? pkg.licenses ?? MANUAL_LICENSE[pkg.name]),
    isProd: required.has(key),
  });
}
// ---------- Classification ----------
const GREEN =
  /^(MIT|MIT-0|ISC|BSD-2-Clause|BSD-3-Clause|BSD-4-Clause|0BSD|Unlicense|Apache-2\.0|Zlib|WTFPL|Artistic-2\.0|BlueOak-1\.0\.0|CC0-1\.0|CC-BY-4\.0|CC-BY-3\.0|BSD|Python-2\.0)$/i;
function classify(raw) {
  const s = raw.replace(/[()]/g, " ").trim();
  if (s === "(missing)" || s === "missing" || s === "") return "missing";
  if (/^UNLICENSED|SEE LICEN[CS]E IN|UNKNOWN|N\/A$/i.test(s)) return "unresolved";
  const or = s
    .split(/\s+OR\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
  if (or.length > 1 && or.some((x) => GREEN.test(x))) return "green";
  const and = s
    .split(/\s+AND\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
  if (and.length > 1 && and.every((x) => GREEN.test(x))) return "green";
  const t = or[0] || and[0] || s;
  if (/\bAGPL/i.test(t)) return "red-agpl";
  if (/\bLGPL/i.test(t)) return "yellow-lgpl";
  if (/\bGPL/i.test(t)) return "red-gpl";
  if (/^(MPL|EPL|CDDL)/i.test(t)) return "yellow-weak";
  if (/^(BUSL|BSL|Elastic|SSPL|PolyForm|FSL|CAL-1)/i.test(t)) return "red-semiopen";
  if (/^CC-BY-NC/i.test(t)) return "red-nc";
  if (/^CC-BY-(ND|SA)/i.test(t)) return "yellow-cc";
  return GREEN.test(t) ? "green" : "review";
}
for (const r of installed.values()) r.bucket = classify(r.license);

// ---------- Build-tool license identity review (not an exemption from binary distribution obligations) ----------
const WEAK_ALLOW = [[/^lightningcss/, "build-only dependency for now; re-check MPL source-provision obligations once it enters the production graph"]];
function weakAllowReason(r) {
  if (r.isProd) return null;
  for (const [re, why] of WEAK_ALLOW) if (re.test(r.name)) return why;
  return null;
}

if (command === "check") {
  const bad = [];
  for (const r of installed.values()) {
    if (r.bucket === "green") continue;
    if (r.bucket.startsWith("yellow") && weakAllowReason(r)) continue;
    bad.push(r);
  }
  if (bad.length) {
    console.error(`✗ license check failed: ${bad.length} package(s) outside the allowlist:`);
    for (const r of bad.sort((a, b) => a.name.localeCompare(b.name)))
      console.error(`  [${r.bucket}] ${r.name}@${r.version} → ${r.license}`);
    console.error("\nRemedy: replace the dependency, or record a manual review verdict in WEAK_ALLOW in scripts/licenses.mjs.");
    process.exit(1);
  }
  await readVerifiedNotices(ROOT, { requireComplete: process.argv.includes("--strict") });
  const reviewRequired =
    JSON.parse(await readFile(path.join(ROOT, "third-party/inventory.json"), "utf8"))
      .reviewRequired ?? [];
  if (reviewRequired.length)
    console.warn(
      `${reviewRequired.length} material(s) still to be added/verified; run node scripts/licenses.mjs check --strict before release. Passing the basic check does not count as compliance done.`,
    );
  const n = installed.size;
  console.log(
    `✓ license identity and notices freshness check passed: ${n} installed package(s) (build-dependency reviews: ${[...installed.values()].filter((r) => r.bucket.startsWith("yellow")).length}); for material constraints see third-party/README.md`,
  );
} else {
  console.error("Usage: node scripts/licenses.mjs [notices|check]");
  process.exit(2);
}
