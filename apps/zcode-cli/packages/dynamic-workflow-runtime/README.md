# @zcode/dynamic-workflow-runtime

Sandbox harness (the dynamic workflow execution engine). It runs a workflow script inside a
controlled child process and bridges the child's `__host.*` calls to the pure engine core of
`@zcode/dynamic-workflow` over NDJSON.

## Dependency boundaries

Depends **only** on `@zcode/dynamic-workflow` (workspace) and Node built-ins. **Never** import
`@zcode/core` / `@zcode/contracts` / `@zcode/bootstrap` / `@zcode/adapters` — this package is
the proof that the entire sandbox↔engine pipeline runs app-free.

## Usage

```ts
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";

const settlement = await runWorkflowScript({
  scriptText, // or lowered: <async function body>
  caps: { maxConcurrency: 16 },
  askSpecs, // a site id in the synthesized schemas record => typed
  validate, // @zcode/dynamic-workflow's validate (adapted to ValidateFn)
  makeDriver: (sink) => driver, // the driver carries journal + emit; sink is the engine's upward report surface
  signal, // optional: AbortSignal
  timeoutMs, // optional: wall-clock timeout
});
// settlement: { status: "completed", artifact } | { status: "failed", error } | { status: "cancelled" }
```

## Architecture

```
┌─ parent (harness) ──────────────┐  NDJSON  ┌─ child (vm.createContext) ────────────────┐
│ runWorkflowScript               │  stdio   │ only ES intrinsics + __host               │
│  - lower(scriptText)            │◀────────▶│  createActor returns handles synchronously│
│  - WorkflowEngine(driver,...)   │          │  ask/worldRead → request the parent       │
│  - bridge __host.* ↔ engine     │          │  args frozen into globals (once, at spawn)│
│  - spawn/kill/timeout/abort     │          │  Date.now/Math.random banned at runtime   │
└─────────────────────────────────┘          └───────────────────────────────────────────┘
```

## NDJSON wire protocol

See `src/protocol.ts` (the single source of truth). child→parent: `create-actor`
(fire-and-forget) / `request` (ask, world-read) / `event` (log) / `complete`; parent→child:
`response`.

## Build order

Tests and typecheck resolve the dependency against the **built dist** of
`@zcode/dynamic-workflow`, so `pretest` / `pretypecheck` first run
`pnpm --filter @zcode/dynamic-workflow build`. On a fresh checkout, `pnpm test` just works —
no stale-dist surprises.

## Failure adjudication and trade-offs

- The run verdict belongs to the engine. Terminal failures (script throw / child crash /
  timeout / protocol corruption) all call `engine.fail(error)` — settlement `failed`,
  driver-side cancelation of in-flight asks, journal records `dwf_run.status = "failed"` +
  `failure_json`; the journal and the caller-visible result agree. The abort signal is the
  only "true cancel": it calls `engine.cancel()` (settlement `cancelled`, resumable). The
  harness-side first-wins finalize only handles child cleanup (clear timer, close stdin, kill
  child) and never fabricates a settlement.
