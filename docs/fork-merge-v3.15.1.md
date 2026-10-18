# Fork survival plan — merge upstream v3.15.1

Status: PRE-MERGE. The merge itself is a hard stop awaiting explicit approval.
Branch `pre-merge-v3.15.1` marks the purged, verified fork state (`addf8090`).
Upstream ref: `upstream/main` = `aac47556` ("feat: update to v3.15.1"), a single
squashed release commit on our exact base `29628c9a` (v3.14.3).

## Fork deltas that MUST survive the merge

Fork side is 20 commits, 48 files. Survival map by theme (commit → files → what to preserve):

1. **Privacy hardening** (`20e33c2c`) — `packages/desktop/src/main/*` telemetry
   bootstrap, agent OTLP export, auto-update paths. Hard-disabled upstream.
   Post-merge: re-verify all three still hard-disabled; audit every endpoint/CDN
   the release adds (seen in diff: alicdn CDN, provider registry hosts) against
   the hardening; restore disables where upstream rewired the call sites.
2. **Mission mode / goal continuation** (`7cdd2f5f`, `d132d403`, `74c18377`,
   `8e69da3a`, `af9d544b`, `bc83ed77`, `8948fab0`, `6a96edcb`, `0bbeeca6`,
   `d08f991a`, `cd9a7e39`, `a61a2193`, `9d121009`) — `apps/zcode-cli/packages/
   core/src/runtime/**` (agent-runtime, methods/turn|target|goal*,
   synthetic-notice-metadata), `bootstrap/src/**` (create-app, slash-command-
   surface, protocol handlers goal-compact/queue/session-flow),
   `contracts/src/interfaces/session-store.port.ts`. Fork semantics: goals drive
   continuation every turn; missions auto-resume cold; queue promotion inserts
   without pausing; verifiers reject narrative-closed numeric goals. Upstream
   touched the same runtime files — resolve hunk-by-hunk, fork behavior wins,
   upstream refactorings adapted INTO fork shape.
3. **Refusals stripped from system prompt** (`d82394c1`) — prompt assembly in
   core runtime; re-apply if upstream reshaped the prompt template.
4. **Custom-provider-first onboarding** (`6c75ce0c`) — onboarding flow order.
5. **Build/packaging** (`efd8cae6` CSC_NAME signing, `ca1e76be` reproducible deb,
   `94f31fba` deb native-search ELF verify, `ad8d209c` version `3.14.3-<N>` →
   rebase to `3.15.1-<N>`) — `packages/desktop/electron-builder.config.js`,
   scripts, `packages/desktop/src/main/desktopHostProcess.ts` version plumbing.

## Conflict candidates (fork∩release, 34 files)

`.gitignore`, bootstrap app/slash/protocol handlers (5), contracts session
store port, core runtime (10), desktop electron-builder + main (3),
services node.ts + setting/telemetry/process trees. Full list:
`comm -12 <(git diff --name-only 29628c9a HEAD | sort) <(git diff --name-only 29628c9a aac47556 | sort)`

## Resolution policy

- Plain `git merge upstream/main` on `main`. No rebase, no `-X theirs`.
- Every conflicted hunk: fork logic survives; upstream's new functionality is
  adopted where orthogonal; both merged where they interleave. No silent
  override of either side.
- Per-conflict decision log goes in the merge commit message.
- `workspaceIdentity`/lease/stale-run guards and CommandInbox boundaries are
  load-bearing: verify intact post-merge (AGENTS.md invariants).

## Post-merge restoration passes (before gates)

1. Privacy: re-audit hardening (item 1) against the merged tree.
2. English: full Han sweep on merge-introduced sources (locales/legalese
   exempt) — upstream v3.15.1 ships new Chinese comments/strings.
3. Fork features: mission/goal behavior tests + greps on merged runtime.
4. Version: `3.15.1-<N>` fork suffix restored.

## Final gates

`pnpm typecheck` (0 errors) · `pnpm lint` (0 errors, warnings ≈71) ·
`pnpm architecture:check --changed` · `oxfmt` · Han sweep · fork-feature
greps (`mission`, `goalContinuation`, telemetry-disabled asserts).
