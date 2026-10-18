/**
  * world-read cap constants.
 *
  * **Enforced by the driver, constants in the pure package** -- separated on purpose: only the driver side can not-produce --
  * stopping ripgrep at 2000 beats materializing a million rows and measuring afterwards. But the constants are contract, not driver
  * private: engine- and compile-side tests assert against them, and a number living only in the driver would get copied into tests,
  * and someday the copies would disagree.
 *
  * Overflow policy: **reject the node** (WorldReadCapExceeded, catchable), never truncate-and-flag.
  * A truncation hands the script a quietly incomplete world view, which it will then fan out over -- and the fan-out is the expensive step.
 */

/** Caps for grep / git.diff / git.log. The numbers are the contract (see the module top). */
export const WORLD_READ_CAPS = {
  /**
      * Max matched files for files.glob. glob had no cap of its own, so the filesystem
      * port's UI-facing default (100, mtime descending) silently applied -- exactly the silent clamping this registry forbids.
      // Every world-read cap must have a name here.
   */
  globMaxFiles: 2000,
    /** Max hits for files.grep. */
  grepMaxMatches: 2000,
    /** Max serialized bytes of the files.grep result (whichever cap hits first rejects). */
  grepMaxSerializedBytes: 256 * 1024,
    /** Max bytes of git.diff output. */
  gitDiffMaxBytes: 512 * 1024,
    /** Max requestable count for git.log; beyond it a structured rejection, never silent clamping. */
  gitLogMaxCount: 100,
    /** Count used when git.log gets no count. */
  gitLogDefaultCount: 20,
    /** Max stdout bytes of world.run (reject, not truncate; cap+1 probe). */
  runStdoutMaxBytes: 256 * 1024,
    /** Max stderr bytes of world.run (as above). */
  runStderrMaxBytes: 256 * 1024,
    /** Wall clock (ms) when world.run gets no timeoutMs. **No ceiling clamp**: designed for genuinely long tests. */
  runDefaultTimeoutMs: 300_000,
} as const;
