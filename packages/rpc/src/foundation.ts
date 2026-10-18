/**
 * Layer 0: foundation
 * - IDisposable / DisposableStore: resource lifetime management
 * - Event / Emitter: the event system
 * - CancellationToken: cancellation tokens
 *
 * The bedrock of the IPC framework; every upper layer depends on them.
 */

// ============================================================================
// Disposable - the resource-release pattern
// ============================================================================

export interface IDisposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): IDisposable {
  return { dispose: once(fn) };
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (!called) {
      called = true;
      fn();
    }
  };
}

/**
 * DisposableStore collects multiple IDisposable instances and disposes them together.
 * Nearly every class in VS Code keeps a DisposableStore for its child resources.
 */
export class DisposableStore implements IDisposable {
  private items = new Set<IDisposable>();
  private isDisposed = false;

  add<T extends IDisposable>(item: T): T {
    if (this.isDisposed) {
      console.warn("Adding to a disposed DisposableStore");
      item.dispose();
      return item;
    }
    this.items.add(item);
    return item;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    for (const item of this.items) {
      item.dispose();
    }
    this.items.clear();
  }
}

// ============================================================================
// Event system
// ============================================================================

/**
 * Event<T> is just a function signature: pass a listener, get an IDisposable to unsubscribe.
 * The core type for event flow across the whole IPC framework.
 */
export type Event<T> = (listener: (e: T) => void) => IDisposable;

export namespace Event {
  /** An event that never fires */
  export const None: Event<any> = () => ({ dispose() {} });

/** Fires once, then unsubscribes automatically */
  export function once<T>(event: Event<T>): Event<T> {
    return (listener) => {
      let fired = false;
      const disposable = event((e) => {
        if (!fired) {
          fired = true;
          disposable.dispose();
          listener(e);
        }
      });
      return disposable;
    };
  }

  /** Resolve a Promise on next fire, then unsubscribe */
  export function toPromise<T>(event: Event<T>): Promise<T> {
    return new Promise((resolve) => once(event)(resolve));
  }

  /** Filter an event */
  export function filter<T>(event: Event<T>, fn: (e: T) => boolean): Event<T> {
    return (listener) =>
      event((e) => {
        if (fn(e)) {
          listener(e);
        }
      });
  }

  /** Map an event */
  export function map<T, R>(event: Event<T>, fn: (e: T) => R): Event<R> {
    return (listener) => event((e) => listener(fn(e)));
  }
}

/**
 * Emitter<T> emits events.
 *
 * Key design:
 * - onWillAddFirstListener: fires when the first subscriber arrives (lazy init)
 * - onDidRemoveLastListener: fires when the last subscriber leaves (release resources)
 *
 * This lazy-subscription mechanism is crucial to the IPC framework: ChannelClient
 * requestEvent uses it to send EventListen only while someone listens, and
 * EventDispose once nobody does.
 */
export class Emitter<T> implements IDisposable {
  private listeners = new Set<(e: T) => void>();
  private disposed = false;
  private options?: EmitterOptions;

  constructor(options?: EmitterOptions) {
    this.options = options;
  }

  get event(): Event<T> {
    return (listener: (e: T) => void) => {
      if (this.disposed) {
        return { dispose() {} };
      }

      const isFirst = this.listeners.size === 0;
      this.listeners.add(listener);

      if (isFirst) {
        this.options?.onWillAddFirstListener?.();
      }

      return toDisposable(() => {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) {
          this.options?.onDidRemoveLastListener?.();
        }
      });
    };
  }

  fire(event: T): void {
    if (this.disposed) {
      return;
    }
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

interface EmitterOptions {
  onWillAddFirstListener?: () => void;
  onDidRemoveLastListener?: () => void;
}

/**
 * Relay relays events and can switch its input source dynamically.
 * Used by getDelayedChannel: create the Relay, then switch input once the channel
 * promise resolves.
 */
export class Relay<T> implements IDisposable {
  private emitter = new Emitter<T>();
  private inputDisposable: IDisposable = { dispose() {} };

  readonly event = this.emitter.event;

  set input(event: Event<T>) {
    this.inputDisposable.dispose();
    this.inputDisposable = event((e) => this.emitter.fire(e));
  }

  dispose(): void {
    this.inputDisposable.dispose();
    this.emitter.dispose();
  }
}

/**
 * EventMultiplexer merges many event sources into one event.
 * IPCServer getMulticastEvent uses it to merge the same event across all clients.
 */
export class EventMultiplexer<T> implements IDisposable {
  private readonly emitter = new Emitter<T>();
  private readonly disposables: IDisposable[] = [];

  readonly event = this.emitter.event;

  add(event: Event<T>): IDisposable {
    const d = event((e) => this.emitter.fire(e));
    this.disposables.push(d);
    return d;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.emitter.dispose();
  }
}

// ============================================================================
// Cancellation token
// ============================================================================

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<void>;
}

export namespace CancellationToken {
  export const None: CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: Event.None,
  };
}

export class CancellationTokenSource implements IDisposable {
  private _token?: CancellationToken;
  private emitter = new Emitter<void>();
  private _isCancelled = false;

  get token(): CancellationToken {
    if (!this._token) {
      this._token = {
        isCancellationRequested: false,
        onCancellationRequested: this.emitter.event,
      };
    }
    return this._token;
  }

  cancel(): void {
    if (!this._isCancelled) {
      this._isCancelled = true;
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
