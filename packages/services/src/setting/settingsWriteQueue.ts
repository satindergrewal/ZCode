const SETTINGS_WRITE_QUEUE_TIMEOUT_MS = 30_000;
const SETTINGS_WRITE_QUEUE_TIMEOUT_ENV = "ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS";

function getSettingsWriteQueueTimeoutMs(): number {
  const rawValue = process.env[SETTINGS_WRITE_QUEUE_TIMEOUT_ENV]?.trim();
  if (!rawValue) {
    return SETTINGS_WRITE_QUEUE_TIMEOUT_MS;
  }
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : SETTINGS_WRITE_QUEUE_TIMEOUT_MS;
}

export function withSettingsWriteQueueTimeout(
  runUpdate: (enterCommitPhase: () => void) => Promise<void>,
  expireCurrentWrite: () => void,
): Promise<void> {
  const timeoutMs = getSettingsWriteQueueTimeoutMs();
  let timeoutHandle: NodeJS.Timeout | undefined;
  let commitPhaseEntered = false;

  const clearQueueTimeout = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };

  const enterCommitPhase = () => {
    commitPhaseEntered = true;
    clearQueueTimeout();
  };

  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      if (commitPhaseEntered) {
        return;
      }
      expireCurrentWrite();
      // The write queue owns the real persistence order; providers not awaiting cannot clear pending.
      // Timeouts apply only before commit; once the rename commits, wait out the critical section so
      reject(new Error(`settingService update timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  return Promise.race([runUpdate(enterCommitPhase), timeoutPromise]).finally(clearQueueTimeout);
}
