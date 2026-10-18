import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  type DynamicWorkflowRunProgressPayload,
  type SessionEvent,
} from "@zcode/contracts";
import type { RunContext } from "@zcode/shared-types";
import { zcodeSessionEventTypeSchema } from "@zcode/shared";
import { run } from "../src/run.js";
import type { RunDependencies } from "../src/run.js";
import {
  WORKFLOW_RUN_PROGRESS_STREAM_TYPE,
  createHeadlessPermissionBroker,
  createWorkflowProgressReporter,
  isDynamicWorkflowRunProgressEvent,
  mapWorkflowRunProgressStreamLine,
  waitForHeadlessWorkflowSettle,
} from "../src/headless-workflow.js";

const progressEvent = (
  payload: Partial<DynamicWorkflowRunProgressPayload> & { eventType: string },
  envelope: Partial<SessionEvent> = {},
): SessionEvent =>
  ({
    id: "evt-dwf-1",
    sessionId: "session-test",
    traceId: "trace-test",
    type: SessionEventType.DynamicWorkflowRunProgress,
    timestamp: new Date(1_700_000_000_000),
    sequenceNumber: 7,
    payload: {
      runId: "dwfrun-abc",
      sequence: 3,
      payload: {},
      ...payload,
    },
    ...envelope,
  }) as SessionEvent;

const permissionRequest = (toolName: string) =>
  ({
    requestId: "perm_1",
    sessionId: "session-test",
    traceId: "trace-test",
    toolCallId: "call-1",
    toolName,
    input: {},
    mode: "build",
    ruleId: "tool.alwaysAsk",
    reason: `Tool ${toolName} always requires explicit approval`,
    riskLevel: "low",
    requestedAt: new Date(),
  }) as never;

// —————————————————————————————————————————————————————————————
// Approval bypass (headless broker)
// —————————————————————————————————————————————————————————————

test("headless broker allows CreateWorkflow", async () => {
  const broker = createHeadlessPermissionBroker();
  const result = await broker.requestPermission(permissionRequest("CreateWorkflow"));
  assert.equal(result.decision, "allow");
});

test("headless broker leaves every other tool at today's deny semantics", async () => {
  // Regression pin: the bypass is a per-tool-name hole, not a switch. The copy is pinned too -- it comes from core's
  // deny broker and the bypass only delegates, never restates, so this assertion also proves there is no second copy.
  const broker = createHeadlessPermissionBroker();
  for (const toolName of ["Bash", "Write", "Edit", "Agent", "Workflow"]) {
    const result = await broker.requestPermission(permissionRequest(toolName));
    assert.equal(result.decision, "deny", `${toolName} must stay denied`);
    assert.match(result.reason ?? "", /No permission client configured for/);
    assert.match(result.reason ?? "", new RegExp(toolName));
  }
});

// —————————————————————————————————————————————————————————————
// stream-json typed line
// —————————————————————————————————————————————————————————————

test("dwf progress events are recognised, other session events are not", () => {
  assert.equal(
    isDynamicWorkflowRunProgressEvent(progressEvent({ eventType: "run-started" })),
    true,
  );
  assert.equal(
    isDynamicWorkflowRunProgressEvent(
      progressEvent({ eventType: "run-started" }, { type: SessionEventType.AssistantMessage }),
    ),
    false,
  );
});

test("the CLI-private stream type stays out of the v3 protocol enum", () => {
  // Tripwire: the typed line's type is deliberately not a zcodeSessionEventTypeSchema member. That enum is closed
  // and feeds a discriminated union in zcodeSessionEventSchema; adding a value would make the v3 app-server declare,
  // at the type level, an event it never emits (the protocol path already strips it in mapSessionEventForProtocol).
  // Whoever moves the mapping into the protocol enum sees this fail first.
  assert.equal(
    zcodeSessionEventTypeSchema.options.includes(WORKFLOW_RUN_PROGRESS_STREAM_TYPE as never),
    false,
  );
});

test("the typed stream-json line carries its own type and the bounded payload verbatim", () => {
  const event = progressEvent({
    eventType: "node-settled",
    runId: "dwfrun-abc",
    sequence: 12,
    toolCallId: "call-42",
    payload: { instance: { siteId: "ask#1", ordinal: 2 }, outcome: "ok" },
    truncated: true,
  });

  const line = mapWorkflowRunProgressStreamLine(event);

  // Typed: its own type, not the catch-all session.updated.
  assert.equal(line.type, WORKFLOW_RUN_PROGRESS_STREAM_TYPE);
  assert.notEqual(line.type as string, "session.updated");
  // Envelope matches mapSessionEvent (same String()/getTime() normalization).
  assert.equal(line.eventId, "evt-dwf-1");
  assert.equal(line.sessionId, "session-test");
  assert.equal(line.traceId, "trace-test");
  assert.equal(line.seq, 7);
  assert.equal(line.timestamp, 1_700_000_000_000);
  // dwf events are out-of-turn: the envelope has no turnId key (not an undefined value).
  assert.equal("turnId" in line, false);
  // payload verbatim: no field renaming; readers interpret via eventType.
  assert.deepEqual(line.payload, {
    runId: "dwfrun-abc",
    sequence: 12,
    toolCallId: "call-42",
    eventType: "node-settled",
    payload: { instance: { siteId: "ask#1", ordinal: 2 }, outcome: "ok" },
    truncated: true,
  });
  // Each NDJSON line must parse standalone.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(line)));
});

// —————————————————————————————————————————————————————————————
// stderr progress in text mode
// —————————————————————————————————————————————————————————————

const collectProgress = (
  events: readonly SessionEvent[],
  options: { throttleMs?: number; clock?: number[] } = {},
): string[] => {
  const lines: string[] = [];
  const clock = options.clock ? [...options.clock] : undefined;
  let fallbackNow = 0;
  const reporter = createWorkflowProgressReporter({
    now: () => (clock ? (clock.shift() ?? 0) : fallbackNow++),
    ...(options.throttleMs === undefined ? {} : { throttleMs: options.throttleMs }),
    write: (line) => lines.push(line),
  });
  for (const event of events) reporter(event);
  return lines;
};

test("run lifecycle and log lines are never throttled away", () => {
  const lines = collectProgress(
    [
      progressEvent({ eventType: "run-started" }),
      progressEvent({ eventType: "log", payload: { message: "compiled" } }),
      progressEvent({ eventType: "log", payload: { message: "asking reviewer" } }),
      progressEvent({ eventType: "run-settled", payload: { status: "completed" } }),
    ],
    // Frozen clock: any time-based throttle would eat the last three here -- exactly the regression this case guards.
    { clock: [0, 0, 0, 0] },
  );
  assert.deepEqual(lines, [
    "workflow dwfrun-abc: started\n",
    "workflow dwfrun-abc: log: compiled\n",
    "workflow dwfrun-abc: log: asking reviewer\n",
    "workflow dwfrun-abc: completed\n",
  ]);
});

test("a failed settle carries the error message", () => {
  const lines = collectProgress([
    progressEvent({
      eventType: "run-settled",
      payload: { status: "errored", error: { code: "DriverError", message: "boom" } },
    }),
  ]);
  assert.deepEqual(lines, ["workflow dwfrun-abc: errored: boom\n"]);
});

test("a stopped settle prints the stop reason next to the status", () => {
  const lines = collectProgress([
    progressEvent({
      eventType: "run-settled",
      payload: {
        status: "stopped",
        stopReason: "provider",
        error: { code: "ProviderStop", message: "sign-in expired" },
      },
    }),
  ]);
  assert.deepEqual(lines, ["workflow dwfrun-abc: stopped/provider: sign-in expired\n"]);
});

test("node phase transitions are throttled but the first one gets through", () => {
  const nodeEvent = (eventType: string, ordinal: number) =>
    progressEvent({
      eventType,
      payload: {
        instance: { siteId: "ask#1", ordinal },
        ...(eventType === "node-settled" ? { outcome: "ok" } : {}),
      },
    });
  // The throttle treats every node phase alike; `node-settled` is swallowed too -- deliberate: run
  // endpoints are guaranteed by run-settled (the case above); per-node completion is not must-arrive, or a
  // 100-node run would flood text mode.
  const lines = collectProgress(
    [
      nodeEvent("node-queued", 1),
      nodeEvent("node-dispatched", 1),
      nodeEvent("node-settled", 1),
      nodeEvent("node-queued", 2),
    ],
    { clock: [0, 100, 200, 1_000], throttleMs: 400 },
  );
  assert.deepEqual(lines, [
    "workflow dwfrun-abc: queued ask#1@1\n",
    "workflow dwfrun-abc: queued ask#1@2\n",
  ]);
});

test("counting-only and non-transition events produce no progress line", () => {
  const lines = collectProgress([
    progressEvent({ eventType: "usage-updated", payload: { spentTokens: 12 } }),
    progressEvent({
      eventType: "actor-created",
      payload: { actor: { siteId: "actor#1", ordinal: 1 } },
    }),
    progressEvent({ eventType: "compaction", payload: {} }),
    progressEvent({ eventType: "log", payload: {} }),
    progressEvent({ eventType: "run-started" }, { type: SessionEventType.AssistantMessage }),
  ]);
  assert.deepEqual(lines, []);
});

// —————————————————————————————————————————————————————————————
// End-to-end wiring through run() (headless prompt path)
// —————————————————————————————————————————————————————————————

type CapturedWriteStream = NodeJS.WriteStream & { output: () => string };

const createWriteStream = (): CapturedWriteStream => {
  let output = "";
  return {
    output: () => output,
    write: (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void,
    ): boolean => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      (typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
      return true;
    },
  } as CapturedWriteStream;
};

const createContext = (
  argv: string[],
): RunContext & { stderr: CapturedWriteStream; stdout: CapturedWriteStream } => ({
  argv,
  stderr: createWriteStream(),
  stdin: { isTTY: false } as NodeJS.ReadStream,
  stdout: createWriteStream(),
});

const turnEvents: readonly SessionEvent[] = [
  progressEvent({ eventType: "run-started" }, { id: "evt-1" }),
  progressEvent(
    {
      eventType: "node-settled",
      payload: { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" },
    },
    { id: "evt-2", sequenceNumber: 8 },
  ),
  {
    ...progressEvent({ eventType: "run-started" }),
    id: "evt-3",
    type: SessionEventType.TurnComplete,
    payload: {},
  } as SessionEvent,
];

const createRunDeps = (): RunDependencies & { appOptions: () => unknown } => {
  let appOptions: unknown;
  return {
    appOptions: () => appOptions,
    createZCodeApp: (options?: unknown) => {
      appOptions = options;
      return {
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (
          _prompt: unknown,
          submitOptions?: { onEvent?: (event: unknown) => void | Promise<void> },
        ) => {
          for (const event of turnEvents) submitOptions?.onEvent?.(event);
          return {
            events: turnEvents,
            projection: {
              contextUsed: 12,
              contextWindow: 1000,
              status: "idle",
              totalTokenCount: 12,
              turnCount: 1,
            } as never,
            response: "the answer",
            traceId: "trace-test" as never,
            turnId: "turn-test" as never,
          };
        },
      } as never;
    },
    loadDotenv: () => ({ keys: [], loaded: false }),
    // The prompt command now starts the process Provider Registry runtime before it
    // creates the app; without this stand-in `run` exits 1 before the broker is built.
    startProcessProviderRegistryRuntime: async () =>
      ({
        dispose: () => {},
        runtime: { registryService: {} },
      }) as never,
    mapSessionEvent: ((event: { id: string; type: string }) => ({
      eventId: event.id,
      type: event.type,
    })) as never,
  } as RunDependencies & { appOptions: () => unknown };
};

test("headless app creation installs the CreateWorkflow-only broker", async () => {
  const ctx = createContext(["--workflow-mode", "alwaysOn", "--prompt", "hi"]);
  const deps = createRunDeps();
  assert.equal(await run(ctx, deps), 0);

  const broker = (deps.appOptions() as { permissionBroker?: { requestPermission: unknown } })
    .permissionBroker;
  assert.ok(broker, "prompt-command must hand createZCodeApp a permission broker");
  const allowed = await (
    broker as { requestPermission: (r: unknown) => Promise<{ decision: string }> }
  ).requestPermission(permissionRequest("CreateWorkflow"));
  assert.equal(allowed.decision, "allow");
  const denied = await (
    broker as { requestPermission: (r: unknown) => Promise<{ decision: string }> }
  ).requestPermission(permissionRequest("Bash"));
  assert.equal(denied.decision, "deny");
});

test("stream-json emits the typed workflow line and still terminates with the result line", async () => {
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--output-format",
    "stream-json",
    "--prompt",
    "hi",
  ]);
  assert.equal(await run(ctx, createRunDeps()), 0);

  const lines = ctx.stdout
    .output()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload?: { eventType?: string } });

  const workflowLines = lines.filter((line) => line.type === WORKFLOW_RUN_PROGRESS_STREAM_TYPE);
  assert.equal(workflowLines.length, 2);
  assert.deepEqual(
    workflowLines.map((line) => line.payload?.eventType),
    ["run-started", "node-settled"],
  );
  // Regression pin: these two used to leak through as catch-all session.updated.
  assert.equal(
    lines.some((line) => line.type === "session.updated"),
    false,
  );
  // Non-dwf events still go through mapSessionEvent, and the result line remains the stream terminator.
  assert.equal(lines.at(-2)?.type, "turn_complete");
  assert.equal(lines.at(-1)?.type, "result");
});

test("text mode prints workflow progress to stderr and keeps stdout to the answer", async () => {
  const ctx = createContext(["--workflow-mode", "alwaysOn", "--prompt", "hi"]);
  assert.equal(await run(ctx, createRunDeps()), 0);

  assert.equal(ctx.stdout.output(), "the answer\n");
  const stderr = ctx.stderr.output();
  assert.match(stderr, /^workflow dwfrun-abc: started$/m);
  assert.match(stderr, /^workflow dwfrun-abc: settled ask#1@1 \(ok\)$/m);
});

test("json mode stays exactly one object: no progress, no stderr noise", async () => {
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--output-format",
    "json",
    "--prompt",
    "hi",
  ]);
  assert.equal(await run(ctx, createRunDeps()), 0);

  assert.doesNotThrow(() => JSON.parse(ctx.stdout.output()));
  assert.equal(ctx.stderr.output().includes("workflow dwfrun-abc"), false);
});

test("stream-json does not duplicate progress onto stderr", async () => {
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--output-format",
    "stream-json",
    "--prompt",
    "hi",
  ]);
  assert.equal(await run(ctx, createRunDeps()), 0);
  assert.equal(ctx.stderr.output().includes("workflow dwfrun-abc"), false);
});

// —————————————————————————————————————————————————————————————
// Settlement wait (in-flight run plus notification-driven turns)
// —————————————————————————————————————————————————————————————

const abortedSignal = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

test("the wait returns immediately when the runtime reports no work", async () => {
  let polls = 0;
  await waitForHeadlessWorkflowSettle({
    runtime: {
      hasActiveOrQueuedTurnWork: () => {
        polls += 1;
        return false;
      },
      hasRunningBackgroundTasks: () => false,
    },
    signal: new AbortController().signal,
    sleep: async () => assert.fail("must not sleep when there is nothing to wait for"),
  });
  assert.equal(polls, 1);
});

test("the wait polls until both busy facts clear", async () => {
  // The predicate is an OR: the background task clears first while the notification turn is still queued, so the wait continues.
  // The two counters stay independent because the predicate short-circuits -- while the task flag is true, turn work is never asked.
  let backgroundCalls = 0;
  let turnWorkCalls = 0;
  let sleeps = 0;
  await waitForHeadlessWorkflowSettle({
    runtime: {
      hasActiveOrQueuedTurnWork: () => {
        turnWorkCalls += 1;
        return turnWorkCalls <= 1;
      },
      hasRunningBackgroundTasks: () => {
        backgroundCalls += 1;
        return backgroundCalls <= 2;
      },
    },
    signal: new AbortController().signal,
    sleep: async () => {
      sleeps += 1;
    },
  });
  // Two polls for the background task plus one for the notification turn; round four clears both and exits.
  assert.equal(sleeps, 3);
  assert.equal(backgroundCalls, 4);
});

test("an already-aborted signal never enters the wait: Ctrl-C is not swallowed", async () => {
  await waitForHeadlessWorkflowSettle({
    runtime: {
      hasActiveOrQueuedTurnWork: () => true,
      hasRunningBackgroundTasks: () => true,
    },
    signal: abortedSignal(),
    sleep: async () => assert.fail("an aborted wait must not sleep"),
  });
});

test("aborting mid-wait breaks the loop even while the runtime stays busy", async () => {
  const controller = new AbortController();
  let sleeps = 0;
  await waitForHeadlessWorkflowSettle({
    runtime: {
      hasActiveOrQueuedTurnWork: () => true,
      hasRunningBackgroundTasks: () => true,
    },
    signal: controller.signal,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) controller.abort();
    },
  });
  assert.equal(sleeps, 2);
});

/**
 * An app test double that starts a dwf run, settles it, then runs a notification-driven turn.
 *
 * Key point: `submitPrompt` fans each event to both the resident-subscription sink and `options.onEvent` -- the real
 * runtime behaves this way when both are mounted. That makes exactly-once provable in this assembly:
 * if prompt-command mounted both, every event would appear twice.
 */
const createWaitingRunDeps = (
  script: {
    busyPolls: number;
    notificationTurns?: readonly { turnId: string; response: string }[];
  } = {
    busyPolls: 2,
  },
): RunDependencies & { pollCount: () => number } => {
  let remainingBusyPolls = script.busyPolls;
  let polls = 0;
  const sinks: ((event: SessionEvent) => void)[] = [];
  return {
    pollCount: () => polls,
    createZCodeApp: () =>
      ({
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {
          subscribeEvents: (sink: { onSessionEvent: (event: SessionEvent) => void }) => {
            sinks.push(sink.onSessionEvent);
            return () => {
              const at = sinks.indexOf(sink.onSessionEvent);
              if (at >= 0) sinks.splice(at, 1);
            };
          },
          hasRunningBackgroundTasks: () => {
            polls += 1;
            return remainingBusyPolls-- > 0;
          },
          hasActiveOrQueuedTurnWork: () => false,
        } as never,
        submitPrompt: async (
          _prompt: unknown,
          submitOptions?: { onEvent?: (event: SessionEvent) => void | Promise<void> },
        ) => {
          const emit = (event: SessionEvent) => {
            for (const sink of [...sinks]) sink(event);
            void submitOptions?.onEvent?.(event);
          };
          for (const event of turnEvents) emit(event);
          // The notification-driven turn lands during the wait: this 0ms timer fires before the sleep(100) elapses.
          setTimeout(() => {
            for (const turn of script.notificationTurns ?? []) {
              emit({
                ...progressEvent({ eventType: "run-settled" }),
                id: `evt-${turn.turnId}`,
                turnId: turn.turnId as never,
                type: SessionEventType.TurnComplete,
                payload: { response: turn.response },
              } as SessionEvent);
            }
          }, 0);
          return {
            events: turnEvents,
            projection: {
              contextUsed: 12,
              contextWindow: 1000,
              status: "idle",
              totalTokenCount: 12,
              turnCount: 1,
            } as never,
            response: "starting the workflow",
            traceId: "trace-test" as never,
            turnId: "turn-test" as never,
          };
        },
      }) as never,
    loadDotenv: () => ({ keys: [], loaded: false }),
    startProcessProviderRegistryRuntime: async () =>
      ({
        dispose: () => {},
        runtime: { registryService: {} },
      }) as never,
    mapSessionEvent: ((event: { id: string; type: string }) => ({
      eventId: event.id,
      type: event.type,
    })) as never,
  } as RunDependencies & { pollCount: () => number };
};

test("text mode waits for settle and prints every turn, ending with the post-settle answer", async () => {
  const ctx = createContext(["--workflow-mode", "alwaysOn", "--prompt", "run my workflow"]);
  const deps = createWaitingRunDeps({
    busyPolls: 2,
    notificationTurns: [{ turnId: "turn-notify", response: "the workflow produced 42" }],
  });
  assert.equal(await run(ctx, deps), 0);

  // The wait really happened (the predicate was polled more than once).
  assert.ok(deps.pollCount() >= 3, `expected repeated polling, got ${deps.pollCount()}`);
  // Both turns in arrival order; the last segment is the post-settlement summary.
  assert.equal(ctx.stdout.output(), "starting the workflow\n\nthe workflow produced 42\n");
});

test("json mode reports the last turn as response and every turn in turnResponses", async () => {
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--output-format",
    "json",
    "--prompt",
    "run my workflow",
  ]);
  const deps = createWaitingRunDeps({
    busyPolls: 1,
    notificationTurns: [{ turnId: "turn-notify", response: "the workflow produced 42" }],
  });
  assert.equal(await run(ctx, deps), 0);

  const parsed = JSON.parse(ctx.stdout.output()) as {
    response: string;
    turnResponses?: string[];
  };
  assert.equal(parsed.response, "the workflow produced 42");
  assert.deepEqual(parsed.turnResponses, ["starting the workflow", "the workflow produced 42"]);
});

test("a late turn_complete for the first turn is not counted twice", async () => {
  // The first turn's text comes from submitPrompt's return. If its turn_complete lands during the wait,
  // the turnId must block it -- otherwise response falls back to the first turn's text.
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--output-format",
    "json",
    "--prompt",
    "run my workflow",
  ]);
  const deps = createWaitingRunDeps({
    busyPolls: 1,
    notificationTurns: [
      { turnId: "turn-notify", response: "the workflow produced 42" },
      { turnId: "turn-test", response: "starting the workflow" },
    ],
  });
  assert.equal(await run(ctx, deps), 0);

  const parsed = JSON.parse(ctx.stdout.output()) as { response: string; turnResponses?: string[] };
  assert.equal(parsed.response, "the workflow produced 42");
  assert.deepEqual(parsed.turnResponses, ["starting the workflow", "the workflow produced 42"]);
});

test("every event reaches stdout exactly once even though both sinks are offered", async () => {
  // This pins duplicated lines: the double fans every event to both the resident sink and options.onEvent.
  // prompt-command must pick one -- mounting both duplicates every event line.
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--output-format",
    "stream-json",
    "--prompt",
    "run my workflow",
  ]);
  const deps = createWaitingRunDeps({
    busyPolls: 1,
    notificationTurns: [{ turnId: "turn-notify", response: "the workflow produced 42" }],
  });
  assert.equal(await run(ctx, deps), 0);

  const lines = ctx.stdout
    .output()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; eventId?: string });

  const eventIds = lines.filter((line) => line.eventId !== undefined).map((line) => line.eventId);
  assert.deepEqual(
    eventIds.length,
    new Set(eventIds).size,
    `duplicate NDJSON lines for the same event: ${eventIds.join(", ")}`,
  );
  // Notification-turn events are in the stream too (the resident subscription spans turns), and the result line stays the only terminator.
  assert.equal(
    lines.some((line) => line.eventId === "evt-turn-notify"),
    true,
  );
  assert.equal(lines.filter((line) => line.type === "result").length, 1);
  assert.equal(lines.at(-1)?.type, "result");
});

test("a resolvable custom command waits for settle instead of early-returning", async () => {
  // Bug regression pin: custom commands resolve to type === "unknown" and used to early-exit into command-center,
  // exiting after the first turn and orphaning the in-flight run as stopped(interrupted). Now anything resolvable as a real
  // custom command takes the plain prompt path, so the wait and last-turn semantics apply; the app receives the
  // raw text (expansion is the facade's job). The sample is a project custom command (`/workflow` is a builtin reserved name, see next case).
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--prompt",
    "/launch-plan build me a plan",
  ]);
  const deps = createWaitingRunDeps({
    busyPolls: 2,
    notificationTurns: [{ turnId: "turn-notify", response: "the workflow produced 42" }],
  });
  const loadedNames: string[] = [];
  const exitCode = await run(ctx, {
    ...deps,
    isReservedSlashCommandName: () => false,
    loadCustomCommand: async (options) => {
      loadedNames.push(options.name);
      return {
        content: "Run the dynamic workflow: $ARGUMENTS.",
        metadata: {
          description: "Start a dynamic workflow",
          name: "launch-plan",
          path: "/workspace/.zcode/commands/launch-plan.md",
          scope: "project",
          source: "zcode",
        },
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(loadedNames, ["launch-plan"]);
  assert.ok(deps.pollCount() >= 3, `expected repeated polling, got ${deps.pollCount()}`);
  assert.equal(ctx.stdout.output(), "starting the workflow\n\nthe workflow produced 42\n");
});

test("the builtin /workflow command rides the plain prompt path without a custom command lookup", async () => {
  // `/workflow` is now a CLI builtin prompt command (bootstrap/src/builtin-workflow-command.ts):
  // resolved known and not expert/goal, it goes straight down the plain prompt path with no custom-command probe; the raw text goes
  // to the facade for expansion. The dwf settlement wait and last-turn semantics match the custom-command path. The standalone CLI
  // (launch.md, "The standalone CLI: `--workflow-mode`"); enabled explicitly here.
  const ctx = createContext([
    "--prompt",
    "/workflow build me a plan",
    "--workflow-mode",
    "alwaysOn",
  ]);
  const deps = createWaitingRunDeps({
    busyPolls: 2,
    notificationTurns: [{ turnId: "turn-notify", response: "the workflow produced 42" }],
  });
  const loadedNames: string[] = [];
  const exitCode = await run(ctx, {
    ...deps,
    loadCustomCommand: async (options) => {
      loadedNames.push(options.name);
      throw new Error(`Custom command not found: ${options.name}`);
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(loadedNames, []);
  assert.ok(deps.pollCount() >= 3, `expected repeated polling, got ${deps.pollCount()}`);
  assert.equal(ctx.stdout.output(), "starting the workflow\n\nthe workflow produced 42\n");
});

test("a run with no workflow activity never polls and stays byte-identical", async () => {
  const ctx = createContext(["--prompt", "hi"]);
  const deps = createWaitingRunDeps({ busyPolls: 99 });
  // Strips dwf activity from the turn events: with no trigger evidence, never enter the wait.
  const quietDeps = {
    ...deps,
    createZCodeApp: ((options?: unknown) => {
      const app = (deps.createZCodeApp as (o?: unknown) => Record<string, unknown>)(options);
      return {
        ...app,
        submitPrompt: async (
          _prompt: unknown,
          submitOptions?: { onEvent?: (event: SessionEvent) => void },
        ) => {
          submitOptions?.onEvent?.({
            ...progressEvent({ eventType: "run-started" }),
            type: SessionEventType.TurnComplete,
            payload: { response: "" },
          } as SessionEvent);
          return {
            events: [],
            projection: { status: "idle", turnCount: 1, totalTokenCount: 1 } as never,
            response: "the answer",
            traceId: "trace-test" as never,
            turnId: "turn-test" as never,
          };
        },
      };
    }) as never,
  } as RunDependencies & { pollCount: () => number };

  assert.equal(await run(ctx, quietDeps), 0);
  assert.equal(ctx.stdout.output(), "the answer\n");
  assert.equal(deps.pollCount(), 0);
});
