/**
 * Session file-change tracker
 *
 * Records before/after contents of agent-runtime file writes.
 * Multiple writes to one file in a turn keep the first before and the last after.
 *
 * Used by:
 * - Rewind: restore beforeContent in reverse when rolling back to a turn
 * - Aggregation: the final result of every file op in the session
 */

// ---- Types ----

/** One file's change snapshot within a turn (first/last merged) */
interface FileSnapshot {
  path: string;
  /** Content before the turn's first write; null means a new file */
  beforeContent: string | null;
  /** Content of the turn's last write */
  afterContent: string;
  /** Write count within the turn */
  writeCount: number;
}

/** File changes for one conversation turn */
interface TurnFileChanges {
  turnIndex: number;
  /** File snapshots for the turn, keyed by path */
  snapshots: Map<string, FileSnapshot>;
  /** Whether this turn's changes are currently applied to the workspace */
  fileState: "applied" | "reverted";
}

/** Serializable file snapshot (for persistence) */
interface SerializedFileSnapshot {
  path: string;
  beforeContent: string | null;
  afterContent: string;
  writeCount: number;
}

/** Serializable per-turn file changes (for persistence) */
interface SerializedTurnFileChanges {
  turnIndex: number;
  snapshots: SerializedFileSnapshot[];
  fileState?: "applied" | "reverted";
}

// ---- Tracker ----

export class SessionFileChangeTracker {
  private turns: TurnFileChanges[] = [];
  private currentTurnIndex = -1;

  /** Starts a new turn, advancing turnIndex */
  newTurn(): number {
    this.currentTurnIndex++;
    this.turns.push({
      turnIndex: this.currentTurnIndex,
      snapshots: new Map(),
      fileState: "applied",
    });
    return this.currentTurnIndex;
  }

  /**
   * Records one file write.
   * Read the prior content before writeTextFile runs, then call this.
   *
   * @param path file path
   * @param beforeContent content before the write; null means new file
   * @param afterContent content after the write
   */
  record(path: string, beforeContent: string | null, afterContent: string): void {
    if (this.currentTurnIndex < 0) {
      // With no turn yet, create the first one
      this.newTurn();
    }

    const currentTurn = this.turns[this.turns.length - 1]!;
    const existing = currentTurn.snapshots.get(path);

    if (existing) {
      // Same file, same turn: keep the first before, refresh after
      existing.afterContent = afterContent;
      existing.writeCount++;
    } else {
      currentTurn.snapshots.set(path, {
        path,
        beforeContent,
        afterContent,
        writeCount: 1,
      });
    }
  }

  /** File changes for the given turn */
  getChangesForTurn(turnIndex: number): FileSnapshot[] {
    const turn = this.turns.find((t) => t.turnIndex === turnIndex);
    if (!turn) return [];
    return Array.from(turn.snapshots.values());
  }

  /** Applied-state for the given turn */
  getFileStateForTurn(turnIndex: number): "applied" | "reverted" {
    return this.turns.find((turn) => turn.turnIndex === turnIndex)?.fileState ?? "applied";
  }

  /** Updates applied-state for the given turn */
  setFileStateForTurn(turnIndex: number, fileState: "applied" | "reverted"): void {
    const turn = this.turns.find((item) => item.turnIndex === turnIndex);
    if (!turn) {
      return;
    }
    turn.fileState = fileState;
  }

  /** All changes after the given turn (exclusive), in turn order */
  getChangesAfterTurn(turnIndex: number): FileSnapshot[] {
    const result: FileSnapshot[] = [];
    for (const turn of this.turns) {
      if (turn.turnIndex > turnIndex) {
        result.push(...turn.snapshots.values());
      }
    }
    return result;
  }

  /**
   * Computes the restores needed to roll back to a turn.
   * Maps each file to its restore content (null = delete the file).
   * Logic: collect each file's earliest beforeContent across turns after toTurnIndex.
   * If also modified at/before toTurnIndex, use that turn's afterContent instead.
   */
  getRewindOperations(toTurnIndex: number): Map<string, string | null> {
    const rewindOps = new Map<string, string | null>();

    // Walk newest-to-oldest above toTurnIndex, overwriting per file, so the survivor is
    // the earliest beforeContent inside the rollback range
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i]!;
      if (turn.turnIndex <= toTurnIndex) break;

      for (const snapshot of turn.snapshots.values()) {
        rewindOps.set(snapshot.path, snapshot.beforeContent);
      }
    }

    // Files also touched at/before toTurnIndex restore to that turn's afterContent
    for (const turn of this.turns) {
      if (turn.turnIndex > toTurnIndex) break;
      for (const snapshot of turn.snapshots.values()) {
        if (rewindOps.has(snapshot.path)) {
          rewindOps.set(snapshot.path, snapshot.afterContent);
        }
      }
    }

    return rewindOps;
  }

  /** Every modified file in the session with its final content */
  getAllChangedFiles(): Map<string, { originalContent: string | null; finalContent: string }> {
    const result = new Map<string, { originalContent: string | null; finalContent: string }>();

    for (const turn of this.turns) {
      for (const snapshot of turn.snapshots.values()) {
        const existing = result.get(snapshot.path);
        if (existing) {
          // Refresh finalContent, keep originalContent
          existing.finalContent = snapshot.afterContent;
        } else {
          result.set(snapshot.path, {
            originalContent: snapshot.beforeContent,
            finalContent: snapshot.afterContent,
          });
        }
      }
    }

    return result;
  }

  /** Current turn index */
  getCurrentTurnIndex(): number {
    return this.currentTurnIndex;
  }

  /** Backfills the turn cursor for legacy tasks that only have message history */
  restoreCurrentTurnIndex(turnIndex: number): void {
    if (!Number.isFinite(turnIndex)) {
      return;
    }

    // Bugfix: legacy imports (external import) often carry only messages.turnIndex, no fileChanges.
    // Without advancing the cursor to the last turn, the next sendPrompt renumbers from 0,
    // landing follow-ups in the imported turn and skewing fork/retry boundaries.
    this.currentTurnIndex = Math.max(this.currentTurnIndex, Math.trunc(turnIndex));
  }

  //* Total turn count */
  getTurnCount(): number {
    return this.turns.length;
  }

  // ---- (De)serialization (persistence) ----

  //* Serializes to a JSON-safe shape */
  serialize(): SerializedTurnFileChanges[] {
    return this.turns.map((turn) => ({
      turnIndex: turn.turnIndex,
      snapshots: Array.from(turn.snapshots.values()),
      fileState: turn.fileState,
    }));
  }

  //* Restores from serialized data */
  static deserialize(data: SerializedTurnFileChanges[]): SessionFileChangeTracker {
    const tracker = new SessionFileChangeTracker();
    for (const turn of data) {
      const snapshots = new Map<string, FileSnapshot>();
      for (const s of turn.snapshots) {
        snapshots.set(s.path, { ...s });
      }
      tracker.turns.push({
        turnIndex: turn.turnIndex,
        snapshots,
        fileState: turn.fileState ?? "applied",
      });
    }
    tracker.currentTurnIndex = data.length > 0 ? data[data.length - 1]!.turnIndex : -1;
    return tracker;
  }

  //* Truncate through the given turn, dropping everything after */
  truncateAfterTurn(turnIndex: number): void {
    this.turns = this.turns.filter((t) => t.turnIndex <= turnIndex);
    this.currentTurnIndex =
      this.turns.length > 0 ? this.turns[this.turns.length - 1]!.turnIndex : -1;
  }
}
