// Test corpus, NOT an authoring example: the static name in the trailing findings.map is deliberate --
// do not fix it. The script hits DuplicateActorName at runtime and draws one 9006 at compile time
// (docs/execution-engine.md, Amend-resume), so it is unsubmittable -- exactly the shape the corpus wants:
// this file and tests/graphs/planner-reviewer.ts are two copies of one source, and the graph snapshots there
// pin every product of named actors inside fan-out. Rewriting to template names migrates both onto the
// ActorSite.namePattern path, deleting the coverage; the corpus exemption lives in helpers/analysis-corpus.ts.
// (Comments live only in this copy: the graphs copy's snapshots pin line numbers; a comment there is a fake diff.)
// Authoring examples to copy live in packages/bundled-skills/skills/dynamic-workflows/.
interface Flaky {
  findings: {
    testId: string;
    /** 0-1, how confident the scan is */
    confidence: number;
  }[];
}

interface Review {
  approved: boolean;
  feedback: string;
}

const findings = await agent("scanner").ask<Flaky>("Find flaky tests");
log(`found ${findings.findings.length} findings`);

const planner = agent("planner", "You plan fixes...");
const reviewer = agent("reviewer", { system: "You critique plans..." });

let feedback = "none";
for (let round = 0; round < 5; round++) {
  const plan = await planner.ask<string>(`Plan fixes. Feedback: ${feedback}`);
  const review = await reviewer.ask<Review>(`Critique: ${plan}`);
  if (review.approved) return plan;
  feedback = review.feedback;
}

const verdicts = await Promise.all(
  findings.findings.map((f) => agent("judge").ask<Review>(`Judge: ${f.testId}`)),
);
return verdicts.filter((v) => v.approved).length;
