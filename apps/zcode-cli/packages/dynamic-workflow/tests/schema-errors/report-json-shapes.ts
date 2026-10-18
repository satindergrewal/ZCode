// Positive coverage: plain JSON shapes and unknown pass with zero findings.
interface Finding {
  path: string;
  line: number;
  note?: string;
}

const g = agent("g");
const text = await g.ask<string>("go");
const anything: unknown = JSON.parse(text);

report({ paths: ["a.ts", "b.ts"], total: 2, clean: false, extra: null });
report(anything);
report(text);
report([1, 2, 3]);
const finding: Finding = { path: "a.ts", line: 3 };
report(finding);
