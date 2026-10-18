/**
 * The facade's stream segment (docs/dynamic-workflow/authoring.md "Streams"): channel / future.
 *
 * A separate module only because dts.ts sits at the max-lines cap (prose inside template
 * literals counts as code lines); the contract is unchanged: dts.ts still concatenates this
 * segment into both `FACADE_DTS` and `SNIPPET_FACADE_DTS`, and tests/facade-dts.test.ts pins
 * the concatenations by sha256. The segment starts and ends with a single newline, like every
 * other segment.
 */

/**
 * Pipeline primitives: channel / future (docs/dynamic-workflow/authoring.md "Streams"). Present
 * in both facades — the snippet is exactly the workbench for rehearsing pipeline logic. Both are
 * pure in-sandbox promise machinery (kin to Promise.all): no sites, no journal lines, no
 * boundary crossing; lowering only rewrites the calls to `__host.channel` / `__host.future`,
 * and the implementation lives in the cell in child-source.ts.
 */
export const FACADE_STREAM_SEGMENT = String.raw`
/**
 * A stream of typed items between two stages: one stage send()s, another drains it with
 * for await. Unbounded, first-in-first-out, each item to exactly one receiver.
 */
declare interface Channel<T> extends AsyncIterable<T> {
  /** Enqueue one item; synchronous, never waits. Throws ChannelClosed after close(). */
  send(item: T): void;
  /**
   * End the stream: receivers get the remaining items, then their loops exit. Idempotent.
   * A channel nobody closes fails the run as ChannelDeadlock, naming it, once nothing in
   * flight could send to it again.
   */
  close(): void;
}

/**
 * Create a channel. The name labels the deadlock message; it is not an identity. A receiver
 * on an empty, open channel waits until a send or the close.
 */
declare function channel<T>(name?: string): Channel<T>;

/**
 * Run an async block as a concurrent stage. It starts immediately, not when awaited, and
 * returns its promise.
 */
declare function future<T>(body: () => Promise<T>): Promise<T>;
`;
