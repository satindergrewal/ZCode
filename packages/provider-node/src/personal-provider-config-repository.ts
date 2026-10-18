import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ModelConfigRules,
  ProviderConfigMap,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "./provider-config-file-codec.js";

export interface NodePersonalProviderConfigRepositoryOptions {
  readonly filePath: string;
  readonly importLegacy?: () => Promise<ProviderConfigLayerUpdate | null>;
  readonly onRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPollingError?: (error: unknown) => void;
  readonly pollingIntervalMs?: number | false;
}

export interface PersonalProviderConfigRecoveryEvent {
  readonly error: unknown;
}

export class NodePersonalProviderConfigRepository implements PersonalProviderConfigRepository {
  readonly #filePath: string;
  readonly #importLegacy?: () => Promise<ProviderConfigLayerUpdate | null>;
  readonly #onRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly #onPollingError?: (error: unknown) => void;
  readonly #pollingIntervalMs: number | false;
  readonly #listeners = new Set<(reason: string) => void>();
  #pollingTimer: ReturnType<typeof setTimeout> | null = null;
  #pollingInFlight = false;
  #writeGeneration = 0;
  #pollingErrorActive = false;
  #observedRevision: string | null = null;
  #disposed = false;

  constructor(options: NodePersonalProviderConfigRepositoryOptions) {
    if (!options.filePath.trim())
      throw new Error("Personal provider config filePath must not be empty");
    this.#filePath = options.filePath;
    this.#importLegacy = options.importLegacy;
    this.#onRecovery = options.onRecovery;
    this.#onPollingError = options.onPollingError;
    this.#pollingIntervalMs = options.pollingIntervalMs ?? 1_000;
    if (this.#pollingIntervalMs !== false && this.#pollingIntervalMs <= 0) {
      throw new Error("Personal provider config pollingIntervalMs must be > 0");
    }
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    try {
      const snapshot = await this.#readCurrent();
      this.#observedRevision ??= snapshot.revision;
      return snapshot;
    } catch (error) {
      const snapshot = this.#recoverInvalidFile(error);
      this.#observedRevision ??= snapshot.revision;
      return snapshot;
    } finally {
      this.#ensurePolling();
    }
  }

  async update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    try {
      const snapshot = await withFileLock(this.#filePath, async () => {
        const current = await this.#readLocked();
        const next = transform(current);
        const update = Object.freeze({
          providers: next.providers,
          models: next.models,
          providerOrder: next.providerOrder,
          defaultModelSelection: next.defaultModelSelection,
        });
        const committed = await this.#writeLocked(update);
        const snapshot = snapshotFromUpdate(committed);
        // Atomic writes emit several fs events. Record the content version once the write
        // completes so a later poll of the same version does not re-publish invalidation.
        this.#observedRevision = snapshot.revision;
        return snapshot;
      });
      this.#emit("updated");
      return snapshot;
    } finally {
      this.#ensurePolling();
    }
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#pollingTimer) clearTimeout(this.#pollingTimer);
    this.#pollingTimer = null;
    this.#listeners.clear();
  }

  async #readCurrent(): Promise<ProviderConfigLayerSnapshot> {
    // Even read-only multi-process access contended on the exclusive lock, and slow IO turned
    // polling into lock timeouts. The real file is atomically replaced via a temp file in the
    // same dir, so plain reads observe the committed document directly.
    const file = await readJsonFileIfExists(this.#filePath);
    if (file === null && !this.#importLegacy) return snapshotFromUpdate(emptyUpdate());
    if (file !== null) {
      const update = decodeProviderConfigFile(file.value);
      if (JSON.stringify(file.value) === JSON.stringify(encodeProviderConfigFile(update))) {
        return snapshotFromUpdate(update);
      }
    }
    // Import/normalize still write. Re-read after taking the lock; never overwrite other
    // writers with the pre-lock snapshot.
    return withFileLock(this.#filePath, () => this.#readLocked());
  }

  async #readLocked(): Promise<ProviderConfigLayerSnapshot> {
    const file = await readJsonFileIfExists(this.#filePath);
    if (file === null) {
      const imported = await this.#importLegacy?.();
      const update = imported ?? emptyUpdate();
      if (imported) return snapshotFromUpdate(await this.#writeLocked(update));
      return snapshotFromUpdate(update);
    }

    const update = decodeProviderConfigFile(file.value);
    const encoded = encodeProviderConfigFile(update);
    if (JSON.stringify(file.value) !== JSON.stringify(encoded)) {
      await this.#writeLocked(update);
    }
    return snapshotFromUpdate(update);
  }

  async #writeLocked(update: ProviderConfigLayerUpdate): Promise<ProviderConfigLayerUpdate> {
    // Rules and default selection are written through one entry; validate the whole result
    // first so provenance violations or bad values never reach disk.
    // Hash the same canonical form the reader uses, or key order in outer rules would make a
    // successfully written version read back as changed.
    const canonical = decodeProviderConfigFile(encodeProviderConfigFile(update));
    const encoded = encodeProviderConfigFile(canonical);
    await atomicWritePrivateTextFile(this.#filePath, JSON.stringify(encoded, null, 2));
    this.#writeGeneration += 1;
    return canonical;
  }

  async #readPollingSnapshot(): Promise<ProviderConfigLayerSnapshot> {
    const file = await readJsonFileIfExists(this.#filePath);
    if (file === null) return snapshotFromUpdate(emptyUpdate());
    return snapshotFromUpdate(decodeProviderConfigFile(file.value));
  }

  #recoverInvalidFile(error: unknown): ProviderConfigLayerSnapshot {
    // An invalid real file is preserved as-is -- never backed up and overwritten with an empty
    // config. This process degrades to an in-memory empty overlay and waits for the user to
    // repair the file.
    this.#reportRecovery({ error });
    return snapshotFromUpdate(emptyUpdate());
  }

  #reportRecovery(event: PersonalProviderConfigRecoveryEvent): void {
    try {
      this.#onRecovery?.(Object.freeze(event));
    } catch {
      // Observer callbacks are not config facts; they must never block recovery.
    }
  }

  #ensurePolling(): void {
    // The timer is cleared while a poll is in flight; read/update finally blocks must not
    // schedule another round.
    if (
      this.#pollingIntervalMs === false ||
      this.#pollingTimer ||
      this.#pollingInFlight ||
      this.#disposed
    )
      return;
    this.#pollingTimer = setTimeout(() => {
      this.#pollingTimer = null;
      void this.#pollOnce();
    }, this.#pollingIntervalMs);
    this.#pollingTimer.unref?.();
  }

  async #pollOnce(): Promise<void> {
    this.#pollingInFlight = true;
    const writeGeneration = this.#writeGeneration;
    try {
      const snapshot = await this.#readPollingSnapshot();
      // Without the read lock, a stale poll may return after this process saved; drop it to
      // avoid version regressions and duplicate notifications.
      if (writeGeneration !== this.#writeGeneration) return;
      this.#pollingErrorActive = false;
      if (this.#disposed || snapshot.revision === this.#observedRevision) return;
      this.#observedRevision = snapshot.revision;
      this.#emit("poll-changed");
    } catch (error) {
      // A successful save also invalidates older poll failures; never publish an old read's
      // error after a newer version exists.
      if (this.#disposed || writeGeneration !== this.#writeGeneration) return;
      if (!this.#pollingErrorActive) {
        this.#pollingErrorActive = true;
        try {
          this.#onPollingError?.(error);
        } catch {
          // Observer callbacks must not block the next self-heal round.
        }
        this.#emit("poll-error");
      }
    } finally {
      this.#pollingInFlight = false;
      this.#ensurePolling();
    }
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodePersonalProviderConfigRepository disposed");
  }
}

export function createNodePersonalProviderConfigRepository(
  options: NodePersonalProviderConfigRepositoryOptions,
): NodePersonalProviderConfigRepository {
  return new NodePersonalProviderConfigRepository(options);
}

async function readJsonFileIfExists(filePath: string): Promise<{ readonly value: unknown } | null> {
  try {
    const text = await readFile(filePath, "utf8");
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function emptyUpdate(): ProviderConfigLayerUpdate {
  return Object.freeze({
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
    providerOrder: [],
  });
}

function snapshotFromUpdate(update: ProviderConfigLayerUpdate): ProviderConfigLayerSnapshot {
  const content = JSON.stringify(encodeProviderConfigFile(update));
  return Object.freeze({
    revision: createHash("sha256").update(content).digest("hex"),
    providers: update.providers,
    models: update.models,
    // The snapshot must match the disk content of its revision; padding empty arrays would
    // make files without declared ordering report spurious CAS changes.
    providerOrder: update.providerOrder,
    defaultModelSelection: update.defaultModelSelection,
  });
}
