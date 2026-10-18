## English-only policy (mandatory)

- **Every artifact in this repository is English. Nothing else.** This binds all code, comments, documentation, specs, commit messages, PR titles and descriptions, and developer/user-facing strings in tooling — for every agent and every model, with no exceptions.
- Never introduce non-English comments, docs, or messages. When editing a file, convert any legacy non-English comments in the region you touch to English as part of the same change.
- Exempt from rewriting: third-party/vendored files, generated files (e.g. `THIRD-PARTY-NOTICES.md`), quoted license texts, and product localization resources (`locales`/`i18n` data — UI translations are product content, not engineering prose).

## Core principles

- Before adding or changing behavior, update the corresponding spec first; create its directory if missing. Pin down product rules, state owners, interfaces, and acceptance scenarios before writing code.
- Trust the checked-out source, `package.json`, and the architecture policy as the source of truth. Instructions may only reference features, commands, and files that exist in this repo; when removing a feature, clean up references in instructions and skills too.
- When diagnosing a problem, investigate the cause first unless a code change was explicitly requested. Combine source, logs, and runtime evidence; separate confirmed causes from unverified hypotheses.
- Preserve local changes unrelated to the task; do not restore removed modules or internal dependencies on your own initiative.

## Commands and repo layout

Run `node scripts/check-workspace-freshness.mjs` before starting work to check the baseline. The Node version follows `mise.toml`.

Run from the repo root:

| Purpose                 | Command                                      |
| ----------------------- | -------------------------------------------- |
| Typecheck               | `pnpm typecheck`                             |
| Lint                    | `pnpm lint` / `pnpm lint:fix`                |
| Format check            | `pnpm fmt:check`                             |
| Desktop dev             | `pnpm dev:desktop`                           |
| Web dev                 | `pnpm dev:web`                               |
| Pre-push check          | `pnpm verify:pre-push` (lint + architecture) |
| Architecture check      | `pnpm architecture:check --changed`          |
| Module reading bundle   | `pnpm architecture:context <module-id>`      |
| Unused deps and exports | `pnpm knip`                                  |
| Export reference lookup | `pnpm dep:refs --list-exports <file>`        |

Test entry points follow each target package's `package.json` and actual test files; do not assume a unified unit-test or E2E command.

- `packages/desktop`: Electron main, host, renderer.
- `packages/web`, `packages/server`: web client and server.
- `packages/ui`: shared React components, hooks, and the Zustand store.
- `packages/services`: business services; `packages/rpc`: RPC framework.
- `packages/shared`: shared protocol and types; `packages/client`: agent client SDK.
- `apps/zcode-cli`: agent CLI and runtime.
- `CONTEXT.md`: plugin-store domain glossary; read it before touching related UI.
- `DESIGN.md`: UI design rules; read it before UI work.

## Implementation and verification

- For code changes use `.agents/skills/architecture-governance/SKILL.md`: run the architecture check first, then read the target module's governed context.
- Avoid duplicated state and multiple write paths. Make the single owner, interfaces, dependency direction, event order, and idempotency boundaries explicit; never paper over synchronization issues with timeouts.
- Add tests for behavior changes; interaction changes need E2E scenarios. Check that tests match the implementation, and actually run the verification that is available. Report honestly when a check was not run or the environment blocks it.
- When fixing a bug, document the cause and the evidence for the fix in an English comment. When you find a design flaw, align with the user first instead of piling on fallback branches.
- For designs involving state, timing, remote, or async synchronization, present owners and event order in a diagram.
- Always run `pnpm typecheck` and `pnpm lint`; report the real results, and never present pre-existing failures as passes.
- Use async file and network IO. Import across packages through public entry points and respect existing path aliases.
- No direct UI-to-Repo calls, no Services referencing concrete Runtime implementations, no cross-domain imports of implementation details, no circular dependencies.

## UI and platform boundaries

- Follow `DESIGN.md`, reuse existing components, and account for desktop and mobile-web layout, interaction, theming, and internationalization.
- Components access services through `packages/ui/src/hooks/`; platform operations go through `IPlatformService` (`packages/shared/src/platform.ts`), never `window.zcode` directly.
- Handle Desktop, Web, local, and remote differences via dependency injection, covering Windows, macOS, and Linux.
- Zustand state lives in `packages/ui/src/store/`. Broadcast-synced fields such as theme and language need loop protection; UI-local state must not be mistaken for server-side truth.
- Hook files containing JSX use the `.tsx` extension.

## Processes, protocol, and remote control

- The desktop app talks to the agent over stdio. Protocol changes must update `packages/shared/src/zcode-protocol/index.ts` with strict types and runtime validation.
- Main handles windows, native operations, process scheduling, and message forwarding; it carries no task/session business state.
- One window-scoped Local Host per window; local workspaces share that Host. Remote workspaces are managed by the in-window connection registry; do not create a separate Desktop Remote Host.
- Phone remote control attaches to the desktop's existing Host and reuses session runtimes; never spin up a separate agent, Local Host, or remote session for the phone.
- Keep the desktop `desktop-continuous` live link and the phone `web-remote-replayable` resume link clearly distinct. When touching stream, snapshot, queue, or reconnect, verify both semantics.
- The external relay and Main only do auth, pairing, heartbeat, forwarding, and attachment scheduling; they store no task queues, snapshots, or other business state.
- Accepted busy/running input is admitted serially by the CLI/runtime `CommandInbox`; the renderer keeps only uncommitted drafts and a pending optimistic overlay; the Host owner/lease is responsible for routing.
- Keep owner/lease, cross-Host routing, and stale-run guards; never remove a boundary check because one path happens to be safe.

## Workspace identity

- `workspaceIdentity` isolates identity; `workspacePath` is for file operations, command cwd, git, and path display.
- The identity key is always `workspaceIdentity?.trim() || workspacePath` — use it for dedup, binding, caching, queues, persistence, and request correlation.
- `workspaceIdentity` and `remoteSessionId` must be threaded through the entire remote path; never match by path alone.
- New interfaces keep the local-path fallback; remote identity reuses the existing construction/parsing utilities — never hand-roll the format in business code.

## Logging

- UI logging goes through `packages/ui/src/logger.ts`, not `console.log` or `window.zcode?.log`.
- Agent/session/runtime service logs use `createServiceLogger(scope)` (`packages/services/src/logger/serviceLogger.ts`).
- `debug` is for high-frequency diagnostics — raw protocol data, stream chunks, per-item tool updates — and is not persisted in production.
- `info` is for production-relevant events: process and session lifecycle, permission outcomes, one-time initialization.
- `warn` is for recoverable anomalies; `error` is for unrecoverable failures — crashes, handshake failures, lost auth.
- No credentials, real user data, or internal service addresses in logs, examples, or commits.
