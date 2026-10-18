import type { ZCodeApp } from "../app/types.js";

const modelConfigMutationTails = new WeakMap<ZCodeApp, Promise<void>>();

/**
 * A session App's model configuration has exactly one serialized critical section.
 *
 * The provider registry fallback and user `switchModelConfig` used to call `setModel` directly; the two async chains could
 * interleave so a later catalog fallback overwrote the user choice, and event order diverged from the runtime's final value.
 * All model/thought changes are therefore serialized per App identity; a failure ends only that operation and
 * never pollutes later tails. The WeakMap does not extend the session lifetime.
 */
export async function runSessionModelConfigMutation<T>(
  app: ZCodeApp,
  operation: () => Promise<T>,
): Promise<T> {
  const previousTail = modelConfigMutationTails.get(app) ?? Promise.resolve();
  const currentOperation = previousTail.catch(() => undefined).then(operation);
  const currentTail = currentOperation.then(
    () => undefined,
    () => undefined,
  );
  modelConfigMutationTails.set(app, currentTail);
  try {
    return await currentOperation;
  } finally {
    if (modelConfigMutationTails.get(app) === currentTail) {
      modelConfigMutationTails.delete(app);
    }
  }
}
