// report vs log land correctly in one lowered output: report sites (via __host.report(siteId, item)) while
// log does not (via __host.log(msg)). Same verdict as the git.log/top-level-log pair -- identity by
// declaration, not spelling; the only difference is that report is a container-less site producer.
interface Finding {
  path: string;
  note: string;
}

const scout = agent("scout");
log("scanning");
const paths = await files.glob("src/**/*.ts");
report({ phase: "scanned", total: paths.length });

const findings: Finding[] = [];
for (const path of paths) {
  const note = await scout.ask<string>(`review ${path}`);
  report({ path, note });
  findings.push({ path, note });
}

log("done");
report({ phase: "done", total: findings.length });
return findings;
