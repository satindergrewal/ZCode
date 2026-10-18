/**
 * Layer 5: ProxyChannel -- automatic service proxies (the killer feature)
 *
 * The abstraction that makes VS Code developers hugely productive.
 *
 * Without ProxyChannel you would hand-write an IServerChannel per service:
 *   class FileServiceChannel implements IServerChannel {
 *     call(ctx, command, arg) {
 *       switch (command) {
 *         case 'readFile': return this.service.readFile(arg[0]);
 *         case 'writeFile': return this.service.writeFile(arg[0], arg[1]);
 *         // ... every method mapped by hand
 *       }
 *     }
 *   }
 *
 * With ProxyChannel, one line:
 *   const channel = ProxyChannel.fromService(fileService);
 *   // every method becomes call, every on* event becomes listen
 *
 * One line on the client too:
 *   const fileService = ProxyChannel.toService<IFileService>(channel);
 *   await fileService.readFile(uri);  // just like a local call!
 *
 * How it works:
 * - fromService: walks the service props; methods -> call, on* events -> listen
 * - toService: an ES6 Proxy intercepts property access and dispatches to call/listen
 */

import { Event, Emitter, IDisposable, DisposableStore } from "./foundation.js";
import { IChannel, IServerChannel } from "./channels.js";

// ============================================================================
// ProxyChannel
// ============================================================================

export namespace ProxyChannel {
  /**
   * Server side: wrap a service object as an IServerChannel automatically
   *
   * Convention:
   * - props starting on + capital are events (e.g. onDidChange)
   * - props starting onDynamic + capital are dynamic events (methods returning an event)
   * - everything else is an RPC method
   */
  export function fromService<TContext>(
    service: unknown,
    disposables?: DisposableStore,
  ): IServerChannel<TContext> {
    const handler = service as { [key: string]: unknown };

    // Pre-cache and buffer all events
    const eventMap = new Map<string, Event<unknown>>();
    for (const key in handler) {
      if (isEvent(key) && !isDynamicEvent(key) && typeof handler[key] === "function") {
        // Buffer events: nothing is lost even with no subscriber
        eventMap.set(key, bufferEvent(handler[key] as Event<unknown>));
      }
    }

    return {
      listen<T>(_ctx: TContext, event: string, arg?: any): Event<T> {
        // Cache first
        const cached = eventMap.get(event);
        if (cached) {
          return cached as Event<T>;
        }

        const target = handler[event];
        if (typeof target === "function") {
          // Dynamic event: onDynamicXxx(arg) returns an Event
          if (isDynamicEvent(event)) {
            return target.call(handler, arg);
          }
          // Late-discovered event (Proxy services may not show up in for-in)
          if (isEvent(event)) {
            eventMap.set(event, bufferEvent(handler[event] as Event<unknown>));
            return eventMap.get(event) as Event<T>;
          }
        }

        throw new Error(`Event not found: ${event}`);
      },

      call<T>(_ctx: TContext, command: string, args?: any[]): Promise<T> {
        const target = handler[command];
        if (typeof target === "function") {
          let result = target.apply(handler, args || []);
          if (!(result instanceof Promise)) {
            result = Promise.resolve(result);
          }
          return result;
        }
        throw new Error(`Method not found: ${command}`);
      },
    };
  }

  /**
   * Client side: wrap an IChannel as a type-safe service object.
   *
   * An ES6 Proxy intercepts every property access:
   * - on* -> channel.listen(propKey)
   * - otherwise -> a function calling channel.call(propKey, args)
   */
  export function toService<T extends object>(
    channel: IChannel,
    options?: { context?: unknown },
  ): T {
    return new Proxy({} as T, {
      get(target: T, propKey: PropertyKey, receiver: object) {
        // React dev mode, loggers, and runtimes probe built-ins like Symbol/then on objects.
        // Every unknown prop used to be forced into an RPC member: reading Symbol.toStringTag
        // threw, and reading then misflagged plain services as thenable -- crashing remote
        // workspaces on re-render after a directory pick. Runtime probes must fall back to
        // plain object semantics, not RPC.
        if (typeof propKey === "symbol") {
          return Reflect.get(target as object, propKey, receiver);
        }

        if (typeof propKey === "string") {
          if (propKey === "then") {
            return undefined;
          }

          // Dynamic event
          if (isDynamicEvent(propKey)) {
            return (arg: unknown) => channel.listen(propKey, arg);
          }

          // Plain event
          if (isEvent(propKey)) {
            return channel.listen(propKey);
          }

          // Method call
          return async (...args: unknown[]) => {
            // Optional: inject context as the first argument
            const methodArgs = options?.context !== undefined ? [options.context, ...args] : args;
            return channel.call(propKey, methodArgs);
          };
        }

        return Reflect.get(target as object, propKey, receiver);
      },
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Matches the onXxx event naming convention */
function isEvent(name: string): boolean {
  return (
    name.length >= 3 &&
    name[0] === "o" &&
    name[1] === "n" &&
    name.charCodeAt(2) >= 65 && // A
    name.charCodeAt(2) <= 90
  ); // Z
}

/** Matches the onDynamicXxx dynamic-event naming convention */
function isDynamicEvent(name: string): boolean {
  return (
    name.length >= 10 &&
    name.startsWith("onDynamic") &&
    name.charCodeAt(9) >= 65 &&
    name.charCodeAt(9) <= 90
  );
}

/**
 * Buffered event: events fired before subscription are never lost.
 * While unsubscribed, events queue; the first subscriber flushes them.
 */
function bufferEvent<T>(event: Event<T>): Event<T> {
  let buffer: T[] = [];
  let flushing = false;
  let listener: IDisposable | undefined;

  const emitter = new Emitter<T>({
    onWillAddFirstListener: () => {
      listener = event((e) => {
        if (flushing) {
          emitter.fire(e);
        } else {
          buffer.push(e);
        }
      });
    },
    onDidRemoveLastListener: () => {
      listener?.dispose();
      listener = undefined;
      buffer = [];
    },
  });

  // Flush the buffer as soon as a subscriber exists
  const originalEvent = emitter.event;
  return (listener_fn) => {
    const disposable = originalEvent(listener_fn);
    if (!flushing) {
      flushing = true;
      for (const item of buffer) {
        emitter.fire(item);
      }
      buffer = [];
    }
    return disposable;
  };
}
