export type RunPhase = "idle" | "running" | "completed" | "compacting" | "goalVerifying";
export type QueueState = "empty" | "text" | "goal" | "compact" | "mixed";
export type CompactMemory = "never" | "compactable" | "justCompacted" | "notNeeded";
export type GoalState = "none" | "active" | "verifying" | "verified" | "failed";
export type TurnTarget = "latest" | "old" | "none";
export type CandidateKind = "user" | "system";
// Inputs held during a run are not silently enqueued;
// the user chooses between "clear queue then send" and "keep queue and send".
export type DecisionKind = "allow" | "reject" | "enqueue" | "choice" | "system" | "undefined";
export type NodeKind = "state" | "candidate" | "guard" | "effect" | "case" | "summary";

export interface ProductContext {
  readonly runPhase: RunPhase;
  readonly queue: QueueState;
  readonly compactMemory: CompactMemory;
  readonly canCompactAgain: boolean;
  readonly goal: GoalState;
  readonly selectedTurn: TurnTarget;
  readonly forked: boolean;
}

export interface Candidate {
  readonly id: string;
  readonly kind: CandidateKind;
  readonly label: string;
  readonly target: TurnTarget;
  readonly surface: string;
}

export interface Decision {
  readonly kind: DecisionKind;
  readonly ruleId: string;
  readonly title: string;
  readonly reason: string;
  readonly next?: ProductContext;
  readonly assertion: string;
}

export interface TraceNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string;
  readonly context: ProductContext;
  readonly candidate?: Candidate;
  readonly decision?: Decision;
  readonly caseId?: string;
  readonly e2e?: string;
  readonly children: TraceNode[];
}

export interface TraceStats {
  readonly nodes: number;
  readonly cases: number;
  readonly rejects: number;
  readonly undefined: number;
  readonly enqueued: number;
  readonly allowed: number;
  readonly choices: number;
  readonly system: number;
}

export interface ModelProfile {
  readonly id: string;
  readonly label: string;
  readonly context: ProductContext;
}

export const profiles: ModelProfile[] = [
  {
    id: "running",
    label: "running: message sending",
    context: {
      runPhase: "running",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "completed",
    label: "completed: message completed",
    context: {
      runPhase: "completed",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "goal-verifying",
    label: "goalVerifying: verifying goal",
    context: {
      runPhase: "goalVerifying",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "verifying",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "compacting",
    label: "compacting: compacting",
    context: {
      runPhase: "compacting",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "just-compacted-noop",
    label: "justCompacted: just compacted, no more compact needed",
    context: {
      runPhase: "completed",
      queue: "empty",
      compactMemory: "justCompacted",
      canCompactAgain: false,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "just-compacted-more",
    label: "justCompacted: just compacted, but can compact again",
    context: {
      runPhase: "completed",
      queue: "empty",
      compactMemory: "justCompacted",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
];

export const userCandidates: Candidate[] = [
  { id: "sendText", kind: "user", label: "Send more text", target: "none", surface: "composer" },
  { id: "slashCompact", kind: "user", label: "Type /compact", target: "none", surface: "composer" },
  { id: "setGoal", kind: "user", label: "Set goal", target: "none", surface: "goal control" },
  { id: "compact", kind: "user", label: "Click compact", target: "none", surface: "toolbar" },
  {
    id: "forkLatest",
    kind: "user",
    label: "Fork latest turn",
    target: "latest",
    surface: "turn actions",
  },
  { id: "forkOld", kind: "user", label: "Fork older turn", target: "old", surface: "turn actions" },
  {
    id: "editLatest",
    kind: "user",
    label: "Edit latest query",
    target: "latest",
    surface: "message actions",
  },
  {
    id: "editOld",
    kind: "user",
    label: "Edit older query",
    target: "old",
    surface: "message actions",
  },
];

const systemCandidates: Candidate[] = [
  {
    id: "assistantComplete",
    kind: "system",
    label: "assistant completes the run",
    target: "none",
    surface: "runtime event",
  },
  {
    id: "compactComplete",
    kind: "system",
    label: "compact completed",
    target: "none",
    surface: "runtime event",
  },
  {
    id: "compactNoop",
    kind: "system",
    label: "compact decides no more is needed",
    target: "none",
    surface: "runtime event",
  },
  {
    id: "goalVerifyStart",
    kind: "system",
    label: "goal verification starts",
    target: "none",
    surface: "goal runtime",
  },
  {
    id: "goalVerifyPass",
    kind: "system",
    label: "goal verification passed",
    target: "none",
    surface: "goal runtime",
  },
  {
    id: "goalVerifyFail",
    kind: "system",
    label: "goal verification failed",
    target: "none",
    surface: "goal runtime",
  },
];

let nextNodeId = 0;
let nextCaseId = 0;

export function resetIds(): void {
  nextNodeId = 0;
  nextCaseId = 0;
}

export function contextLabel(context: ProductContext): string {
  return [
    `phase=${context.runPhase}`,
    `queue=${context.queue}`,
    `compact=${context.compactMemory}`,
    context.canCompactAgain ? "canCompactAgain" : "cannotCompactAgain",
    `goal=${context.goal}`,
    `turn=${context.selectedTurn}`,
    context.forked ? "forked" : "notForked",
  ].join(" / ");
}

export function contextKey(context: ProductContext): string {
  return [
    context.runPhase,
    context.queue,
    context.compactMemory,
    String(context.canCompactAgain),
    context.goal,
    context.selectedTurn,
    String(context.forked),
  ].join("|");
}

export function enumerateCandidates(context: ProductContext): Candidate[] {
  const events = systemCandidates.filter((candidate) =>
    isSystemCandidateApplicable(context, candidate),
  );
  return [...userCandidates, ...events];
}

export function buildTraceTree(context: ProductContext, maxRounds: number): TraceNode {
  resetIds();
  return buildStateNode(context, 1, maxRounds, new Map());
}

export function collectStats(root: TraceNode): TraceStats {
  const stats = {
    nodes: 0,
    cases: 0,
    rejects: 0,
    undefined: 0,
    enqueued: 0,
    allowed: 0,
    choices: 0,
    system: 0,
  };

  visit(root, (node) => {
    stats.nodes += 1;
    if (node.kind === "case") {
      stats.cases += 1;
    }
    if (node.decision?.kind === "reject") {
      stats.rejects += 1;
    }
    if (node.decision?.kind === "undefined") {
      stats.undefined += 1;
    }
    if (node.decision?.kind === "enqueue") {
      stats.enqueued += 1;
    }
    if (node.decision?.kind === "allow") {
      stats.allowed += 1;
    }
    if (node.decision?.kind === "choice") {
      stats.choices += 1;
    }
    if (node.decision?.kind === "system") {
      stats.system += 1;
    }
  });

  return stats;
}

export function flatten(root: TraceNode): TraceNode[] {
  const nodes: TraceNode[] = [];
  visit(root, (node) => nodes.push(node));
  return nodes;
}

export function decisionLabel(decision: Decision): string {
  if (decision.kind === "reject") {
    return `reject · ${decision.title}`;
  }
  if (decision.kind === "enqueue") {
    return `enqueue · ${decision.title}`;
  }
  if (decision.kind === "allow") {
    return `allow · ${decision.title}`;
  }
  if (decision.kind === "choice") {
    return `choice · ${decision.title}`;
  }
  if (decision.kind === "system") {
    return `system · ${decision.title}`;
  }
  return `undefined · ${decision.title}`;
}

function visit(node: TraceNode, fn: (node: TraceNode) => void): void {
  fn(node);
  for (const child of node.children) {
    visit(child, fn);
  }
}

function buildStateNode(
  context: ProductContext,
  round: number,
  maxRounds: number,
  seen: Map<string, number>,
): TraceNode {
  const node = makeNode({
    kind: "state",
    title: `S${round}: ${context.runPhase}`,
    subtitle: contextLabel(context),
    detail:
      "Visible product context. The next layer enumerates the Cartesian product of all candidate actions, then prunes with product guards.",
    context,
    children: [],
  });

  if (round > maxRounds) {
    return makeCaseNode(
      node,
      "Round limit reached",
      "This trace reached the enumeration depth; review manually whether to expand further.",
    );
  }

  const loopKey = `${round}:${contextKey(context)}`;
  const visited = seen.get(loopKey) ?? 0;
  if (visited > 1) {
    return makeCaseNode(
      node,
      "Duplicate context",
      "The model reached the same context again; decide whether to merge equivalent classes.",
    );
  }
  const nextSeen = new Map(seen);
  nextSeen.set(loopKey, visited + 1);

  node.children.push(
    ...enumerateCandidates(context).map((candidate) =>
      buildCandidateNode(context, candidate, round, maxRounds, nextSeen),
    ),
  );
  return node;
}

function buildCandidateNode(
  context: ProductContext,
  candidate: Candidate,
  round: number,
  maxRounds: number,
  seen: Map<string, number>,
): TraceNode {
  const decision = evaluate(context, candidate);
  const candidateNode = makeNode({
    kind: "candidate",
    title: candidate.label,
    subtitle: `${candidate.kind} / ${candidate.surface}`,
    detail: `Candidate combination: ${contextLabel(context)} × ${candidate.label}`,
    context,
    candidate,
    children: [],
  });
  const guardNode = makeNode({
    kind: "guard",
    title: decisionLabel(decision),
    subtitle: decision.ruleId,
    detail: decision.reason,
    context,
    candidate,
    decision,
    children: [],
  });
  const effectNode = makeNode({
    kind: "effect",
    title: effectTitle(decision),
    subtitle: decision.assertion,
    detail: decision.next
      ? contextLabel(decision.next)
      : "No next state: the path is pruned here or awaits a product decision.",
    context: decision.next ?? context,
    candidate,
    decision,
    children: [],
  });

  // choice does not expand a next state: both clear/keep dispositions end on the completedCanSend path.
  if (
    decision.next &&
    decision.kind !== "reject" &&
    decision.kind !== "undefined" &&
    decision.kind !== "choice"
  ) {
    effectNode.children.push(buildStateNode(decision.next, round + 1, maxRounds, seen));
  } else {
    effectNode.children.push(
      makeCaseNode(effectNode, decision.title, decision.assertion, candidate, decision),
    );
  }

  guardNode.children.push(effectNode);
  candidateNode.children.push(guardNode);
  return candidateNode;
}

function makeCaseNode(
  base: TraceNode,
  title: string,
  detail: string,
  candidate?: Candidate,
  decision?: Decision,
): TraceNode {
  nextCaseId += 1;
  const caseId = `CASE-${String(nextCaseId).padStart(5, "0")}`;
  return makeNode({
    kind: "case",
    title: caseId,
    subtitle: title,
    detail,
    context: base.context,
    candidate,
    decision,
    caseId,
    e2e: buildE2eAssertion(base.context, candidate, decision),
    children: [],
  });
}

function makeNode(input: Omit<TraceNode, "id">): TraceNode {
  nextNodeId += 1;
  return {
    ...input,
    id: `n-${nextNodeId}`,
  };
}

function effectTitle(decision: Decision): string {
  if (decision.kind === "reject") {
    return "Pruned: explicit rejection shown";
  }
  if (decision.kind === "enqueue") {
    return "Side effect: enters message queue";
  }
  if (decision.kind === "allow") {
    return "Side effect: action applies";
  }
  if (decision.kind === "system") {
    return "System event: phase advances";
  }
  if (decision.kind === "choice") {
    return "Blocked: waiting for the user's queue disposition";
  }
  return "Undefined: needs product review";
}

// Exported as an executable verdict table (02-projection "rule module sinking"):
// guard derivation in the CLI projection must match this function rule for rule,
// mechanically backed by the formal-proof-consistency golden test in bootstrap.
export function evaluate(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.kind === "system") {
    return evaluateSystem(context, candidate);
  }

  if (context.runPhase === "running") {
    return evaluateRunning(context, candidate);
  }
  if (context.runPhase === "compacting") {
    return evaluateCompacting(context, candidate);
  }
  if (context.runPhase === "goalVerifying") {
    return evaluateGoalVerifying(context, candidate);
  }
  if (context.runPhase === "completed") {
    return evaluateCompleted(context, candidate);
  }
  return evaluateIdle(context, candidate);
}

function evaluateRunning(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "sendText") {
    return enqueue(
      context,
      candidate,
      "queueTextWhileRunning",
      "Text sent while running enters the message queue.",
    );
  }
  if (candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "queueGoalWhileRunning",
      "A goal set while running enters the message queue.",
    );
  }
  if (candidate.id === "slashCompact" || candidate.id === "compact") {
    return enqueue(
      context,
      candidate,
      "runningCompactQueues",
      "Compact while running enters the FIFO as maintenance intent.",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "runningCannotFork",
      "Cannot fork while running",
      "Neither the latest nor older turns can be forked.",
    );
  }
  if (candidate.id === "editLatest" || candidate.id === "editOld") {
    return reject(
      context,
      "runningCannotEditQuery",
      "Cannot edit query while running",
      "Neither the latest nor earlier queries can be edited while sending.",
    );
  }
  return undefinedDecision(context, candidate, "runningUnhandled");
}

function evaluateCompacting(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return reject(
      context,
      "compactingCannotCompact",
      "Already compacting; cannot compact again",
      "Dedupe or disable the entry point.",
    );
  }
  // Re-verdict (compactingAcceptsFutureInput):
  // compact is maintenance; user input is future intent, so enqueue instead of interrupting.
  if (candidate.id === "sendText" || candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "compactingAcceptsFutureInput",
      "Input while compacting is appended to the queue without interrupting compact.",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "compactingCannotFork",
      "Cannot fork while compacting",
      "Avoid forking into a half-compacted context.",
    );
  }
  return undefinedDecision(context, candidate, "compactingUnhandled");
}

function evaluateGoalVerifying(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return enqueue(
      context,
      candidate,
      "goalVerifierAcceptsFutureInput",
      "Compact during goal verification is queued without interrupting verification.",
    );
  }
  if (candidate.id === "sendText" || candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "goalVerifierAcceptsFutureInput",
      "Input during goal verification is queued without interrupting verification.",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "goalVerifyingCannotFork",
      "Cannot fork during goal verification",
      "Forking during verification breaks result attribution.",
    );
  }
  return undefinedDecision(context, candidate, "goalVerifyingUnhandled");
}

function evaluateCompleted(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return allow(context, "completedCanFork", "Fork allowed once completed", {
      ...context,
      forked: true,
      selectedTurn: candidate.target,
    });
  }
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    if (context.queue !== "empty") {
      return enqueue(
        context,
        candidate,
        "heldCompactQueues",
        "Compact with a held queue is appended to the back; no future intent is bypassed.",
      );
    }
    if (context.compactMemory === "justCompacted" && !context.canCompactAgain) {
      return reject(
        context,
        "justCompactedNoNeed",
        "Just compacted; no need to compact again",
        "Compact stays clickable but the model replies with a noop hint.",
      );
    }
    return allow(context, "completedCanCompact", "Compact allowed once completed", {
      ...context,
      runPhase: "compacting",
      compactMemory: "compactable",
    });
  }
  // held verdict: a queue lingering in completed can only be a held queue with autoDrain=false
  // (with autoDrain=true assistantComplete consumes it, so completed+queue>0 never persists).
  // Re-verdict (heldQueueInputRequiresChoice, replacing heldQueueCapturesNewInput):
  // input while held is not silently enqueued; the user picks clear/keep before sending.
  if (candidate.id === "sendText") {
    if (context.queue !== "empty") {
      return choice(
        context,
        "heldQueueInputRequiresChoice",
        "Sending with a held queue needs a user verdict",
        'Present "clear queue then send / keep queue and send"; the disposition travels with the command.',
      );
    }
    return allow(context, "completedCanSend", "Send again once completed", {
      ...context,
      runPhase: "running",
      queue: "empty",
    });
  }
  if (candidate.id === "setGoal") {
    if (context.queue !== "empty") {
      return choice(
        context,
        "heldQueueInputRequiresChoice",
        "Setting a goal with a held queue needs a user verdict",
        "Same as sendText: composer input always goes through choice.",
      );
    }
    return allow(context, "completedCanSetGoal", "Goal can be set once completed", {
      ...context,
      goal: "active",
    });
  }
  return undefinedDecision(context, candidate, "completedUnhandled");
}

function evaluateIdle(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "sendText") {
    return allow(context, "idleCanSend", "Send message while idle", {
      ...context,
      runPhase: "running",
      queue: "empty",
    });
  }
  if (candidate.id === "setGoal") {
    return allow(context, "idleCanSetGoal", "Set goal while idle", {
      ...context,
      goal: "active",
    });
  }
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return reject(
      context,
      "idleCannotCompact",
      "No context to compact",
      "Compact must be disabled or hint when no message completed.",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "idleCannotFork",
      "No turn to fork",
      "Fork must be disabled when no turn completed.",
    );
  }
  if (candidate.id === "editLatest" || candidate.id === "editOld") {
    return reject(
      context,
      "idleCannotEdit",
      "No query to edit",
      "The edit entry must not appear when no query exists.",
    );
  }
  return undefinedDecision(context, candidate, "idleUnhandled");
}

function evaluateSystem(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "assistantComplete") {
    return systemTransition(
      context,
      "assistantComplete",
      "assistant completed",
      drainQueueAfterRun(context),
    );
  }
  if (candidate.id === "compactComplete") {
    return systemTransition(context, "compactComplete", "compact completed", {
      ...context,
      runPhase: "completed",
      compactMemory: "justCompacted",
      canCompactAgain: true,
    });
  }
  if (candidate.id === "compactNoop") {
    return systemTransition(context, "compactNoop", "compact decides no more is needed", {
      ...context,
      runPhase: "completed",
      compactMemory: "justCompacted",
      canCompactAgain: false,
    });
  }
  if (candidate.id === "goalVerifyStart") {
    return systemTransition(context, "goalVerifyStart", "goal verification starts", {
      ...context,
      runPhase: "goalVerifying",
      goal: "verifying",
    });
  }
  if (candidate.id === "goalVerifyPass") {
    return systemTransition(context, "goalVerifyPass", "goal verification passed", {
      ...context,
      runPhase: "completed",
      goal: "verified",
    });
  }
  return systemTransition(context, "goalVerifyFail", "goal verification failed", {
    ...context,
    runPhase: "completed",
    goal: "failed",
  });
}

function isSystemCandidateApplicable(context: ProductContext, candidate: Candidate): boolean {
  if (candidate.id === "assistantComplete") {
    return context.runPhase === "running";
  }
  if (candidate.id === "compactComplete" || candidate.id === "compactNoop") {
    return context.runPhase === "compacting";
  }
  if (candidate.id === "goalVerifyStart") {
    return context.runPhase === "completed" && context.goal === "active";
  }
  if (candidate.id === "goalVerifyPass" || candidate.id === "goalVerifyFail") {
    return context.runPhase === "goalVerifying";
  }
  return false;
}

function allow(
  context: ProductContext,
  ruleId: string,
  title: string,
  next: ProductContext,
): Decision {
  return {
    kind: "allow",
    ruleId,
    title,
    reason: title,
    next,
    assertion:
      "The action must apply, with UI, message ownership, button state, and next context consistent.",
  };
}

function enqueue(
  context: ProductContext,
  candidate: Candidate,
  ruleId: string,
  reason: string,
): Decision {
  const queued =
    candidate.id === "setGoal"
      ? "goal"
      : candidate.id === "compact" || candidate.id === "slashCompact"
        ? "compact"
        : "text";
  return {
    kind: "enqueue",
    ruleId,
    title:
      queued === "goal"
        ? "goal enqueued"
        : queued === "compact"
          ? "compact enqueued"
          : "text message enqueued",
    reason,
    next: {
      ...context,
      queue: mergeQueue(context.queue, queued),
    },
    assertion:
      queued === "goal"
        ? "The queue must retain the goal intent."
        : queued === "compact"
          ? "The queue must retain the compact maintenance intent and must not emit a user row."
          : "The queue must retain the user's text message.",
  };
}

function choice(context: ProductContext, ruleId: string, title: string, reason: string): Decision {
  return {
    kind: "choice",
    ruleId,
    title,
    reason,
    // No next: the state does not advance until the user submits a disposition (clear/keep both end at startNow).
    next: context,
    assertion:
      "A clear choice must be presented; nothing is enqueued or sent before the user decides.",
  };
}

function reject(context: ProductContext, ruleId: string, title: string, reason: string): Decision {
  return {
    kind: "reject",
    ruleId,
    title,
    reason,
    assertion: "This path must show explicit feedback and must not produce forbidden side effects.",
    next: context,
  };
}

function systemTransition(
  context: ProductContext,
  ruleId: string,
  title: string,
  next: ProductContext,
): Decision {
  return {
    kind: "system",
    ruleId,
    title,
    reason: "An async system event advances product state.",
    next,
    assertion:
      "System events must be persisted under the owning session/run and must not pollute other traces.",
  };
}

function undefinedDecision(
  context: ProductContext,
  candidate: Candidate,
  ruleId: string,
): Decision {
  return {
    kind: "undefined",
    ruleId,
    title: "Product expectation undefined",
    reason: `The model does not yet know whether ${context.runPhase} + ${candidate.label} should allow, reject, or enqueue.`,
    assertion: "Needs manual review: add a product rule, prune as invalid, or mark ignorable.",
  };
}

function mergeQueue(queue: QueueState, item: "text" | "goal" | "compact"): QueueState {
  if (queue === "empty") {
    return item;
  }
  if (queue === item) {
    return queue;
  }
  return "mixed";
}

function drainQueueAfterRun(context: ProductContext): ProductContext {
  if (context.queue === "text") {
    return { ...context, runPhase: "running", queue: "empty" };
  }
  if (context.queue === "goal") {
    return { ...context, runPhase: "completed", queue: "empty", goal: "active" };
  }
  if (context.queue === "compact") {
    return { ...context, runPhase: "compacting", queue: "empty" };
  }
  if (context.queue === "mixed") {
    return { ...context, runPhase: "running", queue: "goal" };
  }
  return {
    ...context,
    runPhase: "completed",
    compactMemory: context.compactMemory === "never" ? "compactable" : context.compactMemory,
  };
}

function buildE2eAssertion(
  context: ProductContext,
  candidate?: Candidate,
  decision?: Decision,
): string {
  if (!candidate || !decision) {
    return "Record the current trace and decide whether to expand further.";
  }
  if (decision.kind === "reject") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then show "${decision.title}" and no forbidden side effect occurs.`;
  }
  if (decision.kind === "enqueue") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then queue state becomes ${decision.next?.queue ?? "unknown"}.`;
  }
  if (decision.kind === "allow") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then transition to ${decision.next ? contextLabel(decision.next) : "next context"}.`;
  }
  if (decision.kind === "system") {
    return `Given ${contextLabel(context)}, when system emits ${candidate.label}, then reconcile to ${decision.next ? contextLabel(decision.next) : "next context"}.`;
  }
  return `Given ${contextLabel(context)}, when ${candidate.label}, product expectation is undefined and must be reviewed.`;
}
