// Session-scoped lazy index for commands/query.
// The loader runs once per session; new transcript/marker/child/discarded facts merge incrementally via record.
import type { CommandAck, CommandKey } from "@zcode/shared/zcode-protocol-v4";

export type PersistentCommandFactSource = "transcript" | "timeline" | "child" | "discarded";

export interface PersistentCommandIndexSeed {
  workspacePath: string;
  workspaceIdentity?: string;
  facts?: Partial<Record<PersistentCommandFactSource, readonly CommandAck[]>>;
}

export interface PersistentCommandIndexTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface PersistentCommandIndexHost {
  loadSession(sessionId: string): Promise<PersistentCommandIndexSeed | null>;
}

interface SessionIndex {
  workspaceKey: string;
  facts: Record<PersistentCommandFactSource, Map<string, CommandAck>>;
}

function workspaceKey(target: PersistentCommandIndexTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function emptyFacts(): SessionIndex["facts"] {
  return {
    transcript: new Map(),
    timeline: new Map(),
    child: new Map(),
    discarded: new Map(),
  };
}

export class PersistentCommandIndex {
  private readonly sessions = new Map<string, Promise<SessionIndex | null>>();

  constructor(private readonly host: PersistentCommandIndexHost) {}

  async lookup(source: PersistentCommandFactSource, key: CommandKey): Promise<CommandAck | null> {
    if (key.sessionId === null) return null;
    const index = await this.ensureSession(key.sessionId);
    return index?.facts[source].get(key.commandId) ?? null;
  }

  /**
   * Call after transcript append / marker settle / child create / discarded ledger writes; never a full rescan.
   * Reject explicitly when the expected target's workspaceKey differs from the first load's, preventing same-path cross-remote leaks.
   */
  async record(
    target: PersistentCommandIndexTarget,
    sessionId: string,
    source: PersistentCommandFactSource,
    ack: CommandAck,
  ): Promise<void> {
    const index = await this.ensureSession(sessionId);
    if (!index) throw new Error("fault.command.querySessionNotFound");
    if (index.workspaceKey !== workspaceKey(target)) {
      throw new Error("fault.command.queryForeignWorkspace");
    }
    index.facts[source].set(ack.commandId, ack);
  }

  invalidate(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private ensureSession(sessionId: string): Promise<SessionIndex | null> {
    let pending = this.sessions.get(sessionId);
    if (!pending) {
      pending = this.host.loadSession(sessionId).then((seed) => {
        if (!seed) return null;
        const facts = emptyFacts();
        for (const source of ["transcript", "timeline", "child", "discarded"] as const) {
          for (const ack of seed.facts?.[source] ?? []) facts[source].set(ack.commandId, ack);
        }
        return { workspaceKey: workspaceKey(seed), facts };
      });
      // Do not cache rejected Promises on read failure; the next query may retry once the store recovers.
      pending.catch(() => {
        if (this.sessions.get(sessionId) === pending) this.sessions.delete(sessionId);
      });
      pending.then(
        (index) => {
          // unknown/session-not-found are not facts; never cache them. They must become visible once the transcript lands.
          if (index === null && this.sessions.get(sessionId) === pending) {
            this.sessions.delete(sessionId);
          }
        },
        () => {},
      );
      this.sessions.set(sessionId, pending);
    }
    return pending;
  }
}
