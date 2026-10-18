import type { DatabaseMigrationFacts } from "@zcode/shared";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
// As in the existing repos: keep builders from rewriting node:sqlite into a nonexistent npm sqlite package.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import { OffPeakTaskRepo } from "#src/session/offPeakTaskRepo.js";
import {
  runTasksDatabaseMigrations,
  inspectTasksMigrationKind,
} from "#src/session/tasksDatabase/migrations.js";
import {
  markTasksStorageMigrated,
  markTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";

export type TasksStoragePhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "maintaining"
  | "committing"
  | "ready";
const LOCK_WAIT_MS = 60 * 60_000;

/** Invoked by the Host Worker; SQL and post-migration repair shared with the legacy repo, only write-lock waiting is async. */
export async function prepareTasksIndexStorage(
  path: string,
  onProgress: (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) => void,
): Promise<void> {
  // The callback receives point-in-time facts, not the internal objects that keep counting later.
  const report = (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) =>
    onProgress(phase, migration ? { ...migration } : undefined);
  report("checking");
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  let failure: unknown;
  let migration: DatabaseMigrationFacts | undefined;
  try {
    db.exec("PRAGMA busy_timeout = 25");
    db.exec("PRAGMA foreign_keys = ON");
    const deadline = Date.now() + LOCK_WAIT_MS;
    const acquire = async (operation: string | (() => void)) => {
      // Locks can hit before and after the precheck; the post-migration wait must re-publish visible state.
      let waiting = false;
      for (;;) {
        try {
          if (typeof operation === "string") db.exec(operation);
          else operation();
          return;
        } catch (error) {
          const code = (error as { errcode?: number }).errcode;
          if (typeof code !== "number" || (code & 0xff) !== 5) throw error;
          if (Date.now() >= deadline)
            throw Object.assign(new Error("Task storage lock wait expired", { cause: error }), {
              kind: "lock_timeout",
            });
          if (!waiting) {
            waiting = true;
            report("waiting_for_lock", migration);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }
    };
    await acquire("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    await acquire(() => {
      migration = { kind: inspectTasksMigrationKind(db), executedCount: 0, committedCount: 0 };
    });
    report("checking", migration);
    await acquire("BEGIN IMMEDIATE");
    runTasksDatabaseMigrations(db, { transactionOpen: true, migration, onProgress: report });
    // COMMIT succeeded: publish first; a later close failure must not misreport committed as uncommitted.
    report("maintaining", migration);
  } catch (error) {
    failure = error;
    // Failure facts ride the original error to the Worker; never regress to checking/migrating nor mask the first cause.
    if (migration && error && typeof error === "object") {
      try {
        Object.assign(error, { startupMigration: { ...migration } });
      } catch {
        /* Non-extendable exceptions keep the original error. */
      }
    }
    throw error;
  } finally {
    try {
      db.close();
    } catch (error) {
      if (!failure) throw error;
    }
  }
  markTasksStorageMigrated(path);
  const repos = [
    new TaskIndexRepo(path, LOCK_WAIT_MS),
    new AutomationRepo(path, LOCK_WAIT_MS),
    new OffPeakTaskRepo(path, LOCK_WAIT_MS),
  ];
  let preparationFailure: unknown;
  try {
    // These repairs always ran at init; no new migration, no changed transaction boundaries.
    for (const repo of repos) await repo.ensureReady();
  } catch (error) {
    preparationFailure = error;
    throw error;
  } finally {
    let closeFailure: unknown;
    for (const repo of repos) {
      try {
        repo.close({ throwOnError: true });
      } catch (error) {
        closeFailure ??= error;
      }
    }
    if (!preparationFailure && closeFailure) throw closeFailure;
  }
  markTasksStoragePrepared(path);
  report("ready", migration);
}
