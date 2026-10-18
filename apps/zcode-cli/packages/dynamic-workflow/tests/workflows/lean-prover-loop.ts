interface ImplUpdate {
  /** Files changed this round */
  changed: string[];
  /** How this version addresses the last round's counterexamples */
  notes: string;
  /** Whether the lake build self-check passed before delivery */
  buildOk: boolean;
}

interface Verdict {
  pass: boolean;
  /** On pass: the file holding the proof */
  proofPath?: string;
  /** On falsify: a concrete counterexample input reproducing the failure */
  counterExamples?: string[];
  /** Verdict rationale, fed to the next Programmer round */
  reason: string;
}

const IMPL_PATH = "lean/Compress.lean";
const PROOF_PATH = "lean/CompressProof.lean";
const THEOREM = "∀ s, decompress (compress s) = s";

const programmer = agent("Programmer", {
  system:
    `You are a Lean 4 engineer. Put the implementation in ${IMPL_PATH}; lake build must pass before delivery.` +
    "The deliverable is the file itself; say what changed, never paste the source back.",
});

const prover = agent("Prover", {
  system:
    `You are a Lean 4 formalization expert. Read ${IMPL_PATH}, write the proof in ${PROOF_PATH}, verify via lake build.` +
    "If it fails, pass=false plus a concrete counterexample; no sorry hand-waving.",
});

const MAX_ROUNDS = 10;

let impl = await programmer.ask<ImplUpdate>(
  `Implement compress/decompress in ${IMPL_PATH} such that ${THEOREM} becomes provable.`,
);
let verdict = await prover.ask<Verdict>(
  `Prove or refute ${THEOREM}.\nChanged: ${impl.changed.join(", ")}\n` +
    `Author notes: ${impl.notes}\nSelf-check: lake build ${impl.buildOk ? "pass" : "fail"}`,
);

let round = 1;
while (!verdict.pass && round < MAX_ROUNDS) {
  round = round + 1;
  log(`Round ${round}: ${verdict.counterExamples?.length ?? 0} counterexample(s)`);
  impl = await programmer.ask<ImplUpdate>(
    `The last version failed verification.\nReason: ${verdict.reason}\n` +
      `Counterexamples: ${JSON.stringify(verdict.counterExamples ?? [])}\n` +
      `Edit ${IMPL_PATH} directly (failed attempts in ${PROOF_PATH}), then re-run lake build.`,
  );
  verdict = await prover.ask<Verdict>(
    `Implementation updated (${impl.notes}). Prove or refute ${THEOREM} again.`,
  );
}

return {
  proved: verdict.pass,
  rounds: round,
  implPath: IMPL_PATH,
  proofPath: verdict.proofPath,
  verdict,
};
