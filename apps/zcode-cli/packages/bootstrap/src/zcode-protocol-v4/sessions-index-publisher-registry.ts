import type { SessionsIndexPublisher } from "./sessions-index-publisher.js";

const GATEWAY_DISPOSED_FAULT = "fault.gateway.disposed";

/**
 * Workspace-level lifecycle boundary for sessions-index publishers: same-key async ops serialize, no writes after dispose.
 * The gateway only builds/projects; concurrency waiting, retry-after-failure, and dispose generations converge here.
 */
export class SessionsIndexPublisherRegistry {
  private readonly publishers = new Map<string, SessionsIndexPublisher>();
  private readonly inFlight = new Map<string, Promise<SessionsIndexPublisher>>();
  private disposed = false;

  get(workspaceId: string): SessionsIndexPublisher | undefined {
    return this.publishers.get(workspaceId);
  }

  set(workspaceId: string, publisher: SessionsIndexPublisher): void {
    this.ensureActive();
    this.publishers.set(workspaceId, publisher);
  }

  keys(): IterableIterator<string> {
    return this.publishers.keys();
  }

  ensureActive(): void {
    if (this.disposed) throw new Error(GATEWAY_DISPOSED_FAULT);
  }

  async runExclusive(
    workspaceId: string,
    operation: () => Promise<SessionsIndexPublisher>,
  ): Promise<SessionsIndexPublisher> {
    this.ensureActive();
    const pending = this.inFlight.get(workspaceId);
    if (pending) {
      try {
        await pending;
      } catch {
        // A previous failure must not block the current request; dispose is enforced by ensureActive, other failures may retry.
      }
      this.ensureActive();
      return this.runExclusive(workspaceId, operation);
    }

    const current = (async () => {
      this.ensureActive();
      const publisher = await operation();
      this.ensureActive();
      return publisher;
    })();
    this.inFlight.set(workspaceId, current);
    try {
      return await current;
    } finally {
      if (this.inFlight.get(workspaceId) === current) this.inFlight.delete(workspaceId);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.inFlight.clear();
    this.publishers.clear();
  }
}
