/**
 * The MCP resource-subscription registry (pure memory, no IO).
 // Keys = (serverName, uri) -> subscriberKey set; a connection shared by sessions subscribes once,
 // so add flags "subscribe on the server" at 0 -> 1 and remove flags "unsubscribe" at 1 -> 0.
 // The actual server requests, reconnect replay, and logging live in the adapter; here only counts and snapshots.
 */
export class McpResourceSubscriptionRegistry {
  private readonly byServer = new Map<string, Map<string, Set<string>>>();

  /** Registers a subscriber; returns whether this is the (server, uri) pair's first. */
  add(serverName: string, uri: string, subscriberKey: string): { first: boolean } {
    const byUri = this.byServer.get(serverName) ?? new Map<string, Set<string>>();
    this.byServer.set(serverName, byUri);
    const subscribers = byUri.get(uri) ?? new Set<string>();
    const first = subscribers.size === 0;
    subscribers.add(subscriberKey);
    byUri.set(uri, subscribers);
    return { first };
  }

  /** Removes a subscriber; null when unregistered, else whether it was the last (the uri left the table). */
  remove(serverName: string, uri: string, subscriberKey: string): { last: boolean } | null {
    const byUri = this.byServer.get(serverName);
    const subscribers = byUri?.get(uri);
    if (!byUri || !subscribers || !subscribers.delete(subscriberKey)) return null;
    if (subscribers.size > 0) return { last: false };
    byUri.delete(uri);
    return { last: true };
  }

  /** Sweeps by subscriberKey prefix (session close); returns (server, uri) pairs that dropped to zero and need unsubscribing. */
  removeByPrefix(subscriberKeyPrefix: string): Array<{ serverName: string; uri: string }> {
    const released: Array<{ serverName: string; uri: string }> = [];
    for (const [serverName, byUri] of this.byServer) {
      for (const [uri, subscribers] of byUri) {
        for (const key of [...subscribers]) {
          if (key.startsWith(subscriberKeyPrefix)) subscribers.delete(key);
        }
        if (subscribers.size === 0) {
          byUri.delete(uri);
          released.push({ serverName, uri });
        }
      }
    }
    return released;
  }

  /** A uri's subscribers (attached to resources/updated notices). */
  subscribers(serverName: string, uri: string): string[] {
    return [...(this.byServer.get(serverName)?.get(uri) ?? [])];
  }

  /** A server's deduped subscribers (attached to resources/list_changed notices). */
  allSubscribers(serverName: string): string[] {
    const out = new Set<string>();
    for (const keys of this.byServer.get(serverName)?.values() ?? []) {
      for (const key of keys) out.add(key);
    }
    return [...out];
  }

  /** A server's registered uris (replayed after reconnect). */
  uris(serverName: string): string[] {
    return [...(this.byServer.get(serverName)?.keys() ?? [])];
  }

  /** Snapshot (tests / diagnostics): serverName -> uri -> subscriber count. */
  counts(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [serverName, byUri] of this.byServer) {
      out[serverName] = Object.fromEntries(
        [...byUri].map(([uri, subscribers]) => [uri, subscribers.size]),
      );
    }
    return out;
  }
}
