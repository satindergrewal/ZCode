# Agent instructions

This is the TypeScript Node.js coding-agent CLI supporting mainstream models and operating systems. General rules follow the [root AGENTS.md](../../AGENTS.md); this file adds CLI-specific rules. Node.js and package-manager versions follow the root [mise.toml](../../mise.toml) and [package.json](../../package.json).

## Working rules (most important)

- Before adding or changing behavior, write or update the corresponding spec first — pin down product rules, state owners, interfaces, and acceptance scenarios — then implement. Reuse existing docs where possible; create docs and directories on demand when missing; do not assume a fixed-version design directory.
- Next, tests are critical: they are what proves the result matches the expectation.
- Leave breadcrumbs: after adding a feature, leave the new docs behind; after a bugfix, record the bug's cause in a comment.
- Keep the project agent-friendly: expose the logs and interfaces an agent needs to take operations over entirely.
- Long-horizon first: the core agent loop is designed by default for sustainably running complex tasks; never hard-stop on tool-call counts. Resource and safety boundaries are carried by explicit conditions — token/context-limit auto-compact, user cancellation, permission denial, tool timeouts, output truncation, provider retry caps, and the like.
- A single source file is capped at 400 lines by default; beyond that, split into high-cohesion low-coupling modules instead of piling more responsibilities into a big file.
- Extract constants — strings, numbers, and the like — into named variables or constants instead of scattering literals through business logic, so there is one place to change them.
- Before changing a database schema, confirm the approach with the module maintainer and settle migration, compatibility, and rollback strategy.
- Keyboard-first: core logic must be operable via keyboard; mouse support is an enhancement.

## Tooling rules

- Before touching the operating system, consider Windows, macOS, and Linux support simultaneously.
- Keep the default release artifact a standard Node.js CLI package.
- Project-owned environment variables use the `ZCODE_` prefix — but do not add env vars casually. Before adding one, define its purpose, precedence, failure behavior, and test coverage in the owning feature's spec. Anything expressible as a config file, CLI flag, or session setting should prefer those over a new env var.

## Open-source content and sensitive information

- Licensing and attribution live in the root [LICENSE](../../LICENSE), [NOTICE.md](../../NOTICE.md), and [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md). Before including third-party code, docs, prompts, or assets, confirm origin, license, and usage rights; preserve copyright, attribution, and change notices as the applicable license requires; do not strip attribution that still applies in the name of cleanup.
- Docs, examples, test data, logs, and commit messages must not contain real credentials, user privacy data, internal service addresses, personal home directories, or non-public content; examples use fictional data and placeholders.
- Audit the actual delivery scope before release; when git history ships, audit the history too. Deletions or replacements in current files do not mean the history is clean.

## Cross-platform principles

- Every feature is designed for Windows, macOS, and Linux simultaneously; never implement only for your dev machine's OS behavior.
- Path handling prefers Node.js standard library — `path`, `url`, `fs`, and similar cross-platform APIs — never hand-rolled path separators, absolute-path prefixes, line endings, or temp-dir locations.
- When spawning external commands, prefer the argument-array forms of `child_process.spawn` / `execFile`; avoid depending on shell string concatenation, POSIX-only syntax, pipes, redirection, or shell builtins.
- When invoking system commands, editors, shells, package managers, or executables, account for Windows `.cmd` / `.exe`, spaces in paths, argument escaping, env-var case, and shell differences.
- Filesystem logic must account for case-sensitivity, permission models, symlink support, executable bits, line endings, and path-length limits.
- Terminal interaction is capability-detected, never assumed: color, TTY, Unicode, interactive input, window size, and signal handling all need a fallback when non-interactive or capability-poor.
- User, cache, config, temp, and project directories come from explicit cross-platform resolution logic — never hardcode Unix-style directory layouts.
- New OS-interfacing capabilities ship with tests covering the cross-platform differences; behavior that cannot be verified on the current system gets its residual risk stated in the implementation and docs.

## Module boundaries and interface contracts

- Module-to-module interaction happens only through explicit, limited, stable interfaces.
- Every module must be understandable, testable, and replaceable in isolation, and expose strict type declarations, interface definitions, or schema declarations.
- Modules are not coupled to each other's implementations; they dispatch through standardized contracts. Callers must not depend on a callee's internals, directory layout, implicit globals, or undeclared conventions.
- An exposed contract must clearly describe capability, inputs, outputs, error shapes, state changes, and side effects.
- When data crosses a process, storage, network, plugin, tool-call, or LLM boundary, describe it with a runtime-validatable schema, not just a TypeScript type.
- When adding new cross-module interaction, land the interface contract before the implementation.

## External I/O boundary

- Every external side effect must be uniformly observable, approvable, cancellable, retryable, queueable, auditable, and testable. Business logic expresses intent and never touches the outside world directly.
- All external I/O converges in a dedicated infrastructure layer or adapter: network requests, filesystem reads/writes, subprocesses, env-var reads, terminal I/O, caches, databases, the system clipboard, external services.
- Except at the entry, infrastructure, and adapter layers, business modules must not call low-level I/O APIs — `fetch`, `http`, `fs`, `child_process`, `process.env` — directly; they depend on project-defined interfaces, services, or adapters.
- An I/O adapter exposes stable types or a schema declaring inputs, outputs, error types, timeout, cancellation, retry semantics, idempotency, and side-effect scope.
- Network access goes through the single request entry so timeouts, retries, backoff, auth, proxies, custom certificates, rate limits, logging, audit, and error normalization are centralized.
- File access goes through the single filesystem entry so atomic writes, concurrency control, temp files, write queueing, permission errors, path normalization, and platform differences are centralized.
- Subprocess execution goes through the single execution entry so sandboxing, permission approval, env vars, timeouts, cancellation, output truncation, streaming, and exit-code normalization are centralized.
- When an I/O operation needs asyncification, queueing, retry, degradation, or audit, handle it at the I/O boundary layer — never scatter those mechanisms through business logic.

## Tool and side-effect contracts

- Every tool declares an explicit `inputSchema`, `outputSchema`, read-only-ness, destructiveness, concurrency safety, max output size, timeout, cancellation semantics, and permission requirements.
- A tool's side-effect scope is declared explicitly — e.g. `none`, `workspace`, `git`, `network`, `system`. The permission system, sandbox, and approval flow read these declarations instead of guessing at call sites.
- Side-effecting tools declare idempotency and recovery strategy where possible, so retry, rollback, queued execution, and failure recovery can be built later.
- Oversized tool results are not fed back into model context directly; they land on disk or in artifact/storage, returning only a summary, preview, and traceable reference.
- External extensions — MCP, plugins, subagents — integrate through capability declarations, schema validation, namespace isolation, and permission funnels; they never get raw access to internal module implementations.

## Session, config, and observability

- The coding-agent CLI treats session, message, tool call, permission, checkpoint, queue, and pending state as first-class state objects supporting resume, fork, rollback, and concurrent sessions.
- The TUI only handles input capture, layout rendering, and transient interaction state — cursor, input box, scroll position, active dialog choice. Business state (session, mode, model, tool, todo, permission, checkpoint) never lives in the TUI; it is stored by server/bootstrap/core/session and delivered through explicit interfaces or session events.
- Collapse/expand indicators in the TUI are uniformly `+`/`-` (`+` collapsed, `-` expanded), never `v` and `>`.
- Confirmation, selection, input, progress, and error-recovery interactions are designed as stable request/response interfaces or session events serving both the TUI and ZCode Protocol V4 clients; clients are presentation/transport adapters, and interaction flows must not be hardwired into a single frontend.
- Every task execution carries a propagating `traceId`. By default a `traceId` spans one top-level session's complete task chain; child sessions, subagents, retries, background queue tasks, and async I/O created within it all belong to the same `traceId`.
- `traceId` sits above `sessionId`; `sessionId`, `turnId`, `messageId`, `toolCallId`, `spanId`, `parentSpanId` and the like are structured sub-identifiers under the `traceId`, used to reconstruct the full call chain.
- Every module, service, adapter, tool runtime, provider client, I/O adapter, and permission check receives and forwards the unified execution context — never dropping, overwriting, or minting an unrelated `traceId` mid-flight.
- Any async task, tool call, external I/O, cross-module call, or child session that cannot be correlated to a `traceId` is unobservable behavior; avoid introducing it.
- Providers, models, MCP, storage, network proxies, and certificates plug in via adapters; session-core never hardcodes a vendor, transport, or deployment environment.
- Configuration has explicit layers and precedence — system, user, project, session, CLI flags, env vars — with security-relevant settings traceable to their source.
- Embrace the `.agents` protocol and `AGENTS.md` conventions; future design work — especially config discovery, reading, and precedence resolution — must stay compatible with the `.agents` protocol by default.
- Keep debug and observability hooks from day one, covering model requests, context composition, tokens/cost, tool calls, I/O, permission decisions, retries, queue depth, and queue drops.
- Logs, traces, and debug output avoid leaking secrets, tokens, privacy data, and full user content; highly sensitive data goes only through controlled debug paths.

## Errors first

- Errors are first-class design objects. When adding a feature, consider failure paths, error ownership, propagation, and the end-user message first.
- Let errors bubble up by default until they reach the layer actually capable of handling them. Do not swallow errors in low-level modules, log-and-continue, or prematurely flatten them into strings.
- Catch an error only when you can recover, retry, degrade, enrich context, convert it into a user-actionable message — or at the CLI entry boundary.
- When throwing or wrapping, preserve the original cause and add the needed context; never lose the call chain or system error info.
- The user can perceive deep system state: error, waiting, retry, permission, model, tool, and I/O states all surface up the call chain to the CLI/TUI, without leaking secrets, privacy, or full raw content.
- Low-level business modules never call `process.exit`, print errors to the terminal themselves, or decide the final exit code; the CLI entry layer owns formatting, messaging, and exit codes.
- Never branch on error message text; distinguish error kinds with stable error types, codes, or structured fields.
- Tests cover the key failure paths — missing config, insufficient permissions, network failure, filesystem trouble, invalid input, external-command failure — the usual CLI error surface.

## Commit discipline

- One commit per feature-level change.
- Never mix unrelated features, refactors, dependency bumps, and formatting in one commit.
- Keep commits small enough to review in isolation.
- When one feature's change spans multiple files, commit those files together.
- When a task needs several feature-level changes, split it into independent commits in reviewable order.

## Verification

- Before finishing code changes, run `pnpm typecheck` and `pnpm lint` from the repo root; when CLI code is involved also run `pnpm --dir apps/zcode-cli typecheck` and `pnpm --dir apps/zcode-cli lint`.
- Test entry points follow the target package's `package.json` and actual test files — never assume a unified test command; behavior changes run their tests, interaction changes cover E2E scenarios.
- Record honestly which commands ran, their results, and what went unverified; never dress up missing test entry points, pre-existing failures, or environment limits as passes.
