// Shadow-replay conservation audit (delivery / test infrastructure).
// Purpose: feed the full history of the local real CLI store (default ~/.zcode/cli/db/db.sqlite)
// through the cold-recovery pipeline (transcript synthesis -> ProductProjection) and emit a conservation
// audit report. Per-stage gate = full replay with no crashes, no silent drops, and a reviewed failure list.
//
// The source store is read-only: copy the db (incl. -wal/-shm) to a temp dir before opening, because opening
// the store runs migrations (0015/0016 etc.) which must not land on the user's real store (migrations belong
// to the normal CLI startup path). Build first: pnpm -C apps/zcode-cli build (imports resolve from package dists).
//
// Usage:
//   node scripts/shadow-replay.mjs [--db <path>] [--limit <n>] [--session <id>] [--verbose] [--no-copy]
import { parseArgs } from "node:util";
import { homedir, tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = (relative) => import(pathToFileURL(join(here, "..", "packages", relative)).href);

const { values: args } = parseArgs({
  options: {
    db: { type: "string" },
    limit: { type: "string" },
    session: { type: "string" },
    verbose: { type: "boolean", default: false },
    "no-copy": { type: "boolean", default: false },
  },
});

const [{ createSqliteSessionStore }, hydration, projectionModule, contracts] = await Promise.all([
  pkg("adapters/dist/storage/index.js"),
  pkg("bootstrap/dist/zcode-protocol-v4/transcript-hydration.js"),
  pkg("bootstrap/dist/zcode-protocol-v4/product-projection.js"),
  pkg("contracts/dist/index.js"),
]);
const { synthesizeEventsFromMessages, goalVerificationEntriesFromSessionEntries } = hydration;
const { ProductProjection } = projectionModule;
const { SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION } = contracts;

const sourceDbPath = args.db ?? join(homedir(), ".zcode", "cli", "db", "db.sqlite");
const limit = args.limit ? Number(args.limit) : Infinity;

let dbPath = sourceDbPath;
if (!args["no-copy"]) {
  const tempDir = mkdtempSync(join(tmpdir(), "zcode-shadow-replay-"));
  dbPath = join(tempDir, basename(sourceDbPath));
  copyFileSync(sourceDbPath, dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(sourceDbPath + suffix)) {
      copyFileSync(sourceDbPath + suffix, dbPath + suffix);
    }
  }
}

const store = createSqliteSessionStore({ dbPath });

const sessions = args.session
  ? [{ id: args.session }]
  : await store.listSessions({ includeArchived: true, limit: 100000 });

const totals = {
  sessions: 0,
  crashed: 0,
  assistantTextMissing: 0,
  userInputMismatch: 0,
  goalVerifyMissing: 0,
  modelChangeMissing: 0,
  entityTargetMismatch: 0,
  actionAddressabilityMismatch: 0,
  clean: 0,
};
const offenders = [];

for (const session of sessions) {
  if (totals.sessions >= limit) break;
  totals.sessions += 1;
  const sessionId = String(session.id);
  const report = {
    sessionId,
    problems: [],
  };
  try {
    const messages = await store.messages({ sessionID: session.id });
    if (messages.length === 0) continue;
    const entries = store.sessionEntries
      ? await store.sessionEntries({
          sessionID: session.id,
          type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        })
      : [];
    const goalVerificationEntries = goalVerificationEntriesFromSessionEntries(entries);
    const events = synthesizeEventsFromMessages(messages, {
      sessionId,
      goalVerificationEntries,
    });
    const projection = new ProductProjection(sessionId, "shadow-replay");
    for (const event of events) projection.applyEvent(event);
    const rows = projection.getSnapshot().rows.window;

    // -- Conservation audit --
    // assistant conservation: every visible assistant text must appear in rows (multiset coverage).
    const expectedTexts = [];
    for (const message of messages) {
      if (message.info.role !== "assistant") continue;
      for (const part of message.parts) {
        if (part.type === "text" && part.ignored !== true && part.text.length > 0) {
          expectedTexts.push(part.text);
        }
      }
    }
    const actualTexts = rows.filter((row) => row.kind === "assistantText").map((row) => row.text);
    const remaining = [...actualTexts];
    let missingTexts = 0;
    for (const text of expectedTexts) {
      const index = remaining.indexOf(text);
      if (index < 0) missingTexts += 1;
      else remaining.splice(index, 1);
    }
    if (missingTexts > 0) {
      totals.assistantTextMissing += 1;
      report.problems.push(`missing assistant text ${missingTexts}/${expectedTexts.length}`);
    }

    // goalVerify conservation: lifecycle key count across part-union-entry vs goalVerify marker rows.
    const goalKeys = new Set();
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === "timeline" && part.timelineType === "goal_verification") {
          goalKeys.add(
            part.goalIteration !== undefined
              ? `${part.targetId}_${part.goalIteration}`
              : part.verificationId,
          );
        }
      }
    }
    for (const entry of goalVerificationEntries) {
      const payload = entry.payload;
      goalKeys.add(
        payload.goalIteration !== undefined
          ? `${payload.targetId}_${payload.goalIteration}`
          : payload.verificationId,
      );
    }
    const goalMarkers = rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
    ).length;
    if (goalMarkers < goalKeys.size) {
      totals.goalVerifyMissing += 1;
      report.problems.push(`goalVerify marker ${goalMarkers}/${goalKeys.size}`);
    }

    // Visible-user-input conservation: the userInput row count must not fall below a lower-bound estimate of
    // real user text messages (synthetic/model-only excluded; guide-steer inlines are visible rows counted on
    // both sides). Known false positive: legacy data persists goal-continuation reminders / fork notices as
    // bare text (no synthetic/source/metadata marker); the classifier hides them correctly by text prefix, but
    // this heuristic counts them as visible, so flags need manual review (of all flags raised in full replay,
    // 21 were this false positive; true conservation failures: 0).
    const expectedUsers = messages.filter(
      (message) =>
        message.info.role === "user" &&
        message.info.synthetic !== true &&
        message.info.visibility !== "model-only" &&
        // Compact continuation summaries (info.summary / semantics.kind=compact_summary) are
        // providerContextOnly: ruled invisible by the classifier, not counted in the visible-user lower bound.
        message.info.summary === undefined &&
        !message.info.semantics?.kind?.startsWith?.("compact") &&
        message.info.source === undefined &&
        message.parts.some(
          (part) => part.type === "text" && part.ignored !== true && part.text.length > 0,
        ),
    ).length;
    const actualUsers = rows.filter((row) => row.kind === "userInput").length;
    if (actualUsers < expectedUsers) {
      totals.userInputMismatch += 1;
      report.problems.push(`userInput rows ${actualUsers}/${expectedUsers}`);
    }

    // Addressability conservation: shadow replay must prove more than "the text survives". Every transcript
    // row's entity/productTurn/message target, and every published action, must be hit exactly by the resolver
    // of the same cold materialization; otherwise the UI shows buttons whose commands are stale/rejected.
    let entityTargetProblems = 0;
    let actionProblems = 0;
    const actionByFlag = [
      ["canEdit", "editUserQuery"],
      ["canRetry", "retryTurn"],
      ["canFork", "forkAssistant"],
      ["canRewindFiles", "fileRewindPreview"],
    ];
    for (const row of rows) {
      const entityId = projection.getEntityIdForRow(row.rowId);
      const messageId = projection.getMessageIdForRow(row.rowId);
      if (
        (row.kind === "userInput" || row.kind === "assistantText") &&
        (!entityId || !messageId || !row.turnId)
      ) {
        entityTargetProblems += 1;
      }
      for (const [flag, action] of actionByFlag) {
        if (row.actions?.[flag] !== true) continue;
        if (!entityId) {
          actionProblems += 1;
          continue;
        }
        const resolution = projection.resolveRowActionTarget(
          { rowId: row.rowId, entityId },
          action,
        );
        if (!resolution.ok || resolution.row.turnId !== row.turnId) {
          actionProblems += 1;
          continue;
        }
        if (
          (action === "editUserQuery" || action === "retryTurn" || action === "forkAssistant") &&
          (!messageId ||
            ("messageId" in resolution && resolution.messageId !== messageId) ||
            ("editTarget" in resolution && resolution.editTarget.productTurnId !== row.turnId))
        ) {
          actionProblems += 1;
        }
      }
    }
    if (entityTargetProblems > 0) {
      totals.entityTargetMismatch += 1;
      report.problems.push(`unaddressable entity/target ${entityTargetProblems}`);
    }
    if (actionProblems > 0) {
      totals.actionAddressabilityMismatch += 1;
      report.problems.push(`row.actions resolver mismatch ${actionProblems}`);
    }

    if (report.problems.length === 0) totals.clean += 1;
  } catch (error) {
    totals.crashed += 1;
    report.problems.push(`replay crash: ${error?.message ?? error}`);
  }
  if (report.problems.length > 0) {
    offenders.push(report);
    if (args.verbose) {
      console.log(`✗ ${sessionId}: ${report.problems.join("; ")}`);
    }
  }
}

store.close();

console.log("\n-- shadow replay conservation report --");
console.log(
  `source DB: ${sourceDbPath}${dbPath === sourceDbPath ? "" : " (copied to temp for replay)"}`,
);
console.log(`sessions: ${totals.sessions} (clean ${totals.clean})`);
console.log(`replay crashes: ${totals.crashed}`);
console.log(`missing assistant text: ${totals.assistantTextMissing}`);
console.log(`userInput rows short: ${totals.userInputMismatch}`);
console.log(`missing goalVerify markers: ${totals.goalVerifyMissing}`);
console.log(`unaddressable entity/target: ${totals.entityTargetMismatch}`);
console.log(`row.actions resolver mismatch: ${totals.actionAddressabilityMismatch}`);
if (offenders.length > 0 && !args.verbose) {
  console.log(`\nproblem sessions (first 20; --verbose for all):`);

  for (const report of offenders.slice(0, 20)) {
    console.log(`  ${report.sessionId}: ${report.problems.join("; ")}`);
  }
}
process.exitCode =
  totals.crashed > 0 || totals.entityTargetMismatch > 0 || totals.actionAddressabilityMismatch > 0
    ? 1
    : 0;
