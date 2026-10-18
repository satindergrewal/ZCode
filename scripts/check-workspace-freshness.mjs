#!/usr/bin/env node
// Pre-work baseline freshness check — fails when the current branch is behind its own remote,
// or (for non-feature branches) behind origin/main beyond a threshold, preventing analysis,
// tests, and fixes against a stale architecture.
//
// Background: local zcode-cua was once 140 commits behind origin/main (local Skill still
// 558 lines while main had converged to 128), and the z-code integration branch was once
// 29 commits behind its remote; both led to work on stale baselines. Run this script at the
// start of every session (the zcode-cua repo uses its python equivalent).
//
// Rules:
//   1) Behind the upstream tracking branch (any amount) -> fail: run git merge --ff-only <upstream> first.
//   2) ahead==0 and behind origin/main beyond the threshold -> fail: a local main-like branch is purely stale.
//   3) ahead>0 (feature/MR branch) and behind origin/main beyond the threshold -> warn, don't fail:
//      divergence is normal, but the numbers are printed; you decide whether to rebase
//      (do not rebase blindly with unmerged draft changes).
//
// Usage: node scripts/check-workspace-freshness.mjs [--max-behind-main 50] [--no-fetch]

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);
const maxBehindMainIndex = args.indexOf("--max-behind-main");
const maxBehindMain = maxBehindMainIndex >= 0 ? Number(args[maxBehindMainIndex + 1]) : 50;
if (!Number.isInteger(maxBehindMain) || maxBehindMain < 0) {
  console.error("[freshness] --max-behind-main requires a non-negative integer");
  process.exit(2);
}
const doFetch = !args.includes("--no-fetch");

async function git(...gitArgs) {
  const { stdout } = await execFile("git", gitArgs, { encoding: "utf8" });
  return stdout.trim();
}

if (doFetch) {
  await git("fetch", "origin", "--prune");
}

const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
let upstream = null;
try {
  upstream = await git("rev-parse", "--abbrev-ref", "@{upstream}");
} catch {
  console.warn(
    `[freshness] ${branch} has no upstream tracking branch; skipping the behind-remote check (forgot push -u?)`,
  );
}

const failures = [];
if (upstream) {
  const behindRemote = Number(await git("rev-list", "--count", `HEAD..${upstream}`));
  if (behindRemote > 0) {
    failures.push(
      `${branch} is ${behindRemote} commits behind ${upstream}: run git merge --ff-only ${upstream} first`,
    );
  }
}

let mainReport = "";
try {
  await git("rev-parse", "--verify", "origin/main^{commit}");
  const aheadMain = Number(await git("rev-list", "--count", `origin/main..HEAD`));
  const behindMain = Number(await git("rev-list", "--count", `HEAD..origin/main`));
  mainReport = `vs origin/main: ahead ${aheadMain} / behind ${behindMain} (threshold ${maxBehindMain})`;
  if (behindMain > maxBehindMain) {
    const message = `behind origin/main by ${behindMain} commits, over the threshold of ${maxBehindMain}`;
    if (aheadMain === 0) {
      failures.push(`${message}: git merge --ff-only origin/main or recreate the branch`);
    } else {
      console.warn(
        `[freshness] warning: ${message}. This is a feature/MR branch (ahead ${aheadMain}); ` +
          `divergence is normal. To realign with main, check MR status first (do not rebase blindly with unmerged draft changes).`,
      );
    }
  }
} catch {
  console.warn("[freshness] repository has no origin/main; skipping the main-distance check.");
}

if (failures.length > 0) {
  console.error(`[freshness] stale baseline; refusing to start from an outdated architecture (current branch: ${branch}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `[freshness] baseline is fresh: ${branch}${upstream ? ` (in sync with ${upstream})` : ""}${
    mainReport ? `, ${mainReport}` : ""
  }`,
);
