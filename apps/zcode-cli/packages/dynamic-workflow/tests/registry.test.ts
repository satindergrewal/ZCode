import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createWorkflowProgram } from "../src/compiler/compile.js";
import { collectSites } from "../src/analysis/sites.js";
import {
  facadeMemberOf,
  isSiteProducing,
  SITE_MEMBER_NAMES,
  siteProducingFunctionOfSymbol,
  WORLD_READ_REGISTRY,
  worldReadOp,
  worldReadOpOfSymbol,
} from "../src/facade/registry.js";

/**
 * The world-read registry: single source of truth for (facade container, member) -> op
 * (docs/identity is judged by declaring container, never bare name -- git.log
 * collides with the top-level log(), the one trap when git.* lands).
 */

/** Compiles a script, returning a lookup that finds symbols by identifier/property-name text. */
function symbols(scriptText: string): (name: string) => ts.Symbol | undefined {
  const { program, scriptFile } = createWorkflowProgram(scriptText);
  const checker = program.getTypeChecker();
  const found = new Map<string, ts.Symbol>();
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined && !found.has(node.text)) found.set(node.text, symbol);
    }
    ts.forEachChild(node, walk);
  };
  walk(scriptFile);
  return (name) => found.get(name);
}

describe("world-read registry — pure lookup", () => {
  it("keys on (container, member), so a bare member name never resolves alone", () => {
    expect(worldReadOp("files", "glob")).toBe("glob");
    expect(worldReadOp("files", "read")).toBe("read");
    expect(worldReadOp("files", "grep")).toBe("grep");
    expect(worldReadOp("git", "changedFiles")).toBe("git-changed-files");
    expect(worldReadOp("git", "diff")).toBe("git-diff");
    expect(worldReadOp("git", "status")).toBe("git-status");
    expect(worldReadOp("git", "log")).toBe("git-log");
    // Container-less (top-level) functions never hit: world-reads hang off facade container objects.
    expect(worldReadOp(undefined, "glob")).toBeUndefined();
    // The same member on another container is a different op -- exactly the git.log vs top-level log() shape.
    expect(worldReadOp("git", "glob")).toBeUndefined();
    expect(worldReadOp("files", "log")).toBeUndefined();
    expect(worldReadOp("files", "nope")).toBeUndefined();
  });

  it("gives every op a distinct name and every member a distinct one too", () => {
    // Op names are unique: they are the journal inputHash and Boundary A's wire vocabulary.
    const ops = WORLD_READ_REGISTRY.map((row) => row.op);
    expect(new Set(ops).size).toBe(ops.length);
    // Member names are unique across containers: facade-misuse's retyping gate reverse-searches candidates by
    const members = WORLD_READ_REGISTRY.map((row) => row.member);
    expect(new Set(members).size).toBe(members.length);
  });

  it("derives the site-producing member set from the table (plus ask)", () => {
    for (const row of WORLD_READ_REGISTRY) {
      expect(SITE_MEMBER_NAMES.has(row.member)).toBe(true);
      // Every row's op reverse-resolves from (container, member) -- the table is the single source of truth.
      expect(worldReadOp(row.container, row.member)).toBe(row.op);
    }
    expect(SITE_MEMBER_NAMES.has("ask")).toBe(true);
    // "log" IS in this set because git.log is tabulated -- the top-level log() still sites nothing.
    expect(SITE_MEMBER_NAMES.has("log")).toBe(true);
    expect(isSiteProducing(undefined, "log")).toBe(false);
  });

  it("treats report as a site-producing top-level function and log as not", () => {
    // report and log are both container-less top-level facade functions; the one divide: report journals
    expect(isSiteProducing(undefined, "report")).toBe(true);
    expect(isSiteProducing(undefined, "log")).toBe(false);
    expect(siteProducingFunctionOfSymbol(undefined)).toBeUndefined();
    // report is neither a world-read nor any container's member -- absent from both tables.
    expect(worldReadOp(undefined, "report")).toBeUndefined();
    expect(SITE_MEMBER_NAMES.has("report")).toBe(false);
  });

  it("treats agent/Agent.ask as site-producing and log as not", () => {
    expect(isSiteProducing(undefined, "agent")).toBe(true);
    expect(isSiteProducing("Agent", "ask")).toBe(true);
    expect(isSiteProducing("files", "glob")).toBe(true);
    expect(isSiteProducing("files", "grep")).toBe(true);
    expect(isSiteProducing("git", "log")).toBe(true);
    expect(isSiteProducing(undefined, "log")).toBe(false);
    // The key line of defense: a container-less log sites nothing. With git.log landed, this actively
    expect(worldReadOp(undefined, "log")).toBeUndefined();
  });
});

describe("world-read registry — declaration-based resolution", () => {
  const lookup = symbols(
    `const paths = await files.glob("src/**");\n` +
      `const body = await files.read(paths[0] ?? "x");\n` +
      `log(body);\n` +
      `const out = await agent("a").ask<string>("go");\n` +
      `return out;\n`,
  );

  it("resolves a facade member's declaring container from its declaration", () => {
    expect(facadeMemberOf(lookup("glob"))).toEqual({ container: "files", member: "glob" });
    expect(facadeMemberOf(lookup("read"))).toEqual({ container: "files", member: "read" });
    // ask is declared in declare interface Agent -> the container is Agent (an interface container).
    expect(facadeMemberOf(lookup("ask"))).toEqual({ container: "Agent", member: "ask" });
    // Top-level facade functions have no container -- why git.log cannot collide with them.
    expect(facadeMemberOf(lookup("log"))).toEqual({ container: undefined, member: "log" });
    expect(facadeMemberOf(lookup("agent"))).toEqual({ container: undefined, member: "agent" });
  });

  it("resolves the two bare site-producing functions and rejects log", () => {
    const fns = symbols(
      `report({ a: 1 });\nlog("x");\nconst out = await agent("a").ask<string>("go");\nreturn out;\n`,
    );
    expect(siteProducingFunctionOfSymbol(fns("report"))).toBe("report");
    expect(siteProducingFunctionOfSymbol(fns("agent"))).toBe("agent");
    expect(siteProducingFunctionOfSymbol(fns("log"))).toBeUndefined();
    // Container members resolve elsewhere (worldReadOp / ASK_MEMBER), not through this entry.
    expect(siteProducingFunctionOfSymbol(fns("ask"))).toBeUndefined();
  });

  it("does not resolve a script-local function named report", () => {
    const local = symbols(
      `const report = (item: unknown): void => { void item; };\nreport({ a: 1 });\nreturn 1;\n`,
    );
    expect(siteProducingFunctionOfSymbol(local("report"))).toBeUndefined();
    expect(facadeMemberOf(local("report"))).toBeUndefined();
  });

  it("maps only facade-declared members to ops", () => {
    expect(worldReadOpOfSymbol(lookup("glob"))).toBe("glob");
    expect(worldReadOpOfSymbol(lookup("read"))).toBe("read");
    expect(worldReadOpOfSymbol(lookup("log"))).toBeUndefined();
    expect(worldReadOpOfSymbol(lookup("ask"))).toBeUndefined();
    expect(worldReadOpOfSymbol(undefined)).toBeUndefined();
  });

  it("resolves the two `log` declarations to different identities in one script", () => {
    // Two logs in one script: git.log's container is git (the git-log op) while top-level log is
    // container-less (not a world-read). symbols() takes the FIRST match by name, so fetch the two
    // sides separately: first with only the top-level log, then only git.log.
    const topLevel = symbols(`log("progress");\nreturn 1;\n`);
    expect(facadeMemberOf(topLevel("log"))).toEqual({ container: undefined, member: "log" });
    expect(worldReadOpOfSymbol(topLevel("log"))).toBeUndefined();

    const gitLog = symbols(`const c = await git.log(3);\nreturn c.length;\n`);
    expect(facadeMemberOf(gitLog("log"))).toEqual({ container: "git", member: "log" });
    expect(worldReadOpOfSymbol(gitLog("log"))).toBe("git-log");
  });

  it("resolves the whole git container and files.grep from declarations", () => {
    const git = symbols(
      `const changed = await git.changedFiles();\n` +
        `const d = await git.diff("HEAD");\n` +
        `const s = await git.status();\n` +
        `const hits = await files.grep("TODO", "*.ts");\n` +
        `return [changed.length, d.length, s.clean, hits.length];\n`,
    );
    expect(worldReadOpOfSymbol(git("changedFiles"))).toBe("git-changed-files");
    expect(worldReadOpOfSymbol(git("diff"))).toBe("git-diff");
    expect(worldReadOpOfSymbol(git("status"))).toBe("git-status");
    expect(worldReadOpOfSymbol(git("grep"))).toBe("grep");
    expect(facadeMemberOf(git("grep"))).toEqual({ container: "files", member: "grep" });
  });

  it("does not resolve a script-local object whose members merely share the names", () => {
    const local = symbols(
      `const fake = { glob(p: string): string[] { return [p]; }, read(p: string): string { return p; } };\n` +
        `const out = fake.glob("x").join(fake.read("y"));\n` +
        `return out;\n`,
    );
    expect(facadeMemberOf(local("glob"))).toBeUndefined();
    expect(worldReadOpOfSymbol(local("glob"))).toBeUndefined();
    expect(worldReadOpOfSymbol(local("read"))).toBeUndefined();
  });

  it("does not resolve a script-local `git`-shaped object (shadowing the facade)", () => {
    // A hand-rolled myGit.status(): name and container shape fit, but the declaration is not in the facade dts.
    const local = symbols(
      `const myGit = { status(): string { return "clean"; }, log(n: number): number { return n; } };\n` +
        `return myGit.status() + String(myGit.log(1));\n`,
    );
    expect(worldReadOpOfSymbol(local("status"))).toBeUndefined();
    expect(worldReadOpOfSymbol(local("log"))).toBeUndefined();
  });
});

describe("world-read registry — site collection uses it", () => {
  it("sites facade world reads with the registry op, not the member name", () => {
    const table = collectSites(
      createWorkflowProgram(
        `const paths = await files.glob("src/**");\n` +
          `const body = await files.read(paths[0] ?? "x");\n` +
          `return body;\n`,
      ),
    );
    expect(table.worldReads.map((site) => site.op)).toEqual(["glob", "read"]);
    expect(table.worldReads.map((site) => site.id)).toEqual(["world-read#1", "world-read#2"]);
    // Args collected positionally (the multi-arg seam; single-arg ops get one-element arrays).
    expect(table.worldReads[0]?.args).toHaveLength(1);
  });

  it("sites every new op on one shared world-read counter, args packed positionally", () => {
    const table = collectSites(
      createWorkflowProgram(
        `const hits = await files.grep("TODO", "*.ts");\n` +
          `const changed = await git.changedFiles();\n` +
          `const d = await git.diff("main", "src/a.ts");\n` +
          `const s = await git.status();\n` +
          `const c = await git.log(5);\n` +
          `return [hits.length, changed.length, d.length, s.clean, c.length];\n`,
      ),
    );
    expect(table.worldReads.map((site) => site.op)).toEqual([
      "grep",
      "git-changed-files",
      "git-diff",
      "git-status",
      "git-log",
    ]);
    // One shared per-kind counter (world-read#N with an op field), not grep#N/git-log#N.
    expect(table.worldReads.map((site) => site.id)).toEqual([
      "world-read#1",
      "world-read#2",
      "world-read#3",
      "world-read#4",
      "world-read#5",
    ]);
    // Arity preserved positionally: an absent optional is a shorter array (keeping journal keys distinct).
    expect(table.worldReads.map((site) => site.args.length)).toEqual([2, 0, 2, 0, 1]);
  });

  it("mints no world-read site for a same-named script-local method", () => {
    const table = collectSites(
      createWorkflowProgram(
        `const fake = { glob(p: string): string[] { return [p]; } };\n` +
          `const out = fake.glob("x");\n` +
          `return out.length;\n`,
      ),
    );
    expect(table.worldReads).toEqual([]);
  });

  it("mints a site for git.log and none for the top-level log, in one script", () => {
    // This is the executable proof of container-keyed identity. Both bare-name failure modes show here:
    const table = collectSites(
      createWorkflowProgram(
        `log("progress");\n` +
          `const c = await git.log(3);\n` +
          `log("done");\n` +
          `const out = await agent("a").ask<string>(String(c.length));\n` +
          `return out;\n`,
      ),
    );
    expect(table.worldReads).toHaveLength(1);
    expect(table.worldReads[0]?.op).toBe("git-log");
    expect(table.worldReads[0]?.id).toBe("world-read#1");
    expect(table.asks).toHaveLength(1);
  });

  it("mints no world-read site for the top-level log alone", () => {
    const table = collectSites(
      createWorkflowProgram(
        `log("progress");\nconst out = await agent("a").ask<string>("go");\nreturn out;\n`,
      ),
    );
    expect(table.worldReads).toEqual([]);
    expect(table.asks).toHaveLength(1);
  });
});
