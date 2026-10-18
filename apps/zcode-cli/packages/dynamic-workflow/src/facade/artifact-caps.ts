/**
  * Artifact cap constants.
 *
  * ⚠ Terminology: artifact here is the **user-facing deliverable** -- the file /
  * markdown / preset boards a script publishes via the dot-family, not the engine-internal artifact (RunSettlement.artifact,
  * the typed output value in analysis/artifact-types.ts -- the model-facing top-level return).
 *
  * A separate module, like report-caps / world-read-caps, for the same reason: these numbers'
  * **enforcing sides split** -- id and version counts enforced by the engine core (only it knows how many versions an id has in the journal),
  * bytes and text lengths by the driver (only it reads files and writes the store). Either side's module would
  * suggest a single enforcing side; that the numbers are contract holds for both, so they live in the pure package, named,
  * with engine and driver tests asserting the same constants instead of copying each.
 *
  * Overflow policy **splits by member family** (error codes): content members (file / markdown) return
  * a promise the script can catch, so overflow is a **node-level rejection** (ArtifactTooLarge /
  * ArtifactVersionCapExceeded / ArtifactCapExceeded); preset members return void with no rejection channel,
  * so the same caps are failRun in that family. The same argument as the world-read / report boundary.
 */

/** Count, size, and text caps for artifacts. The numbers are the contract (see the module top). */
export const ARTIFACT_CAPS = {
    /** Max distinct artifact ids within one run. */
  maxArtifactsPerRun: 32,
    /** Max published versions per id (each successful content publish = one version). */
  maxVersionsPerArtifact: 16,
    /** Max bytes of artifact.file (same value as PROTOCOL_V4_LIMITS.attachmentMaxBytes). */
  maxFileBytes: 20 * 1024 * 1024,
    /** Max bytes of artifact.markdown (UTF-8). */
  maxMarkdownBytes: 256 * 1024,
    /** Max chars of opts.title. */
  maxTitleLength: 120,
    /** Max chars of opts.description. */
  maxDescriptionLength: 500,
    /** Max bytes of a preset spec's normalized JSON. */
  maxSpecSerializedBytes: 8 * 1024,
    /** Max chars of an artifact id. */
  maxIdLength: 64,
} as const;

/**
  * The legal artifact-id charset: alphanumerics, underscore, dot, dash; non-empty.
 *
  * Why so narrow: the id is a **cross-face identity** -- the journal's artifact-id column, the store's
  * toolCallId, v4 query params, and the side-panel tab key all key on it. A slash, space, or percent in any one
  * becomes an escaping debate; one debate solved four ways is four answers.
 *
  * No g flag: a global regex keeps lastIndex across tests; the same id tested twice would answer differently.
 */
export const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
