import type { DatabaseSync } from "node:sqlite";
import { areTasksDatabaseMigrationsApplied } from "#src/session/tasksDatabase/migrations.js";
// Handoff credentials for this process only; never persisted, never a replacement for the SQLite ledger, no effect on fresh DBs elsewhere.
const migrated = new Set<string>();
const prepared = new Set<string>();
export function markTasksStorageMigrated(path: string): void {
  migrated.add(path);
}
export function markTasksStoragePrepared(path: string): void {
  migrated.add(path);
  prepared.add(path);
}
export function isTasksStorageMigrated(path: string, db: DatabaseSync): boolean {
  return migrated.has(path) && areTasksDatabaseMigrationsApplied(db);
}
export function isTasksStoragePrepared(path: string, db: DatabaseSync): boolean {
  return prepared.has(path) && areTasksDatabaseMigrationsApplied(db);
}
