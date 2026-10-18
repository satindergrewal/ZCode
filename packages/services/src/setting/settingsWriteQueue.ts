const SETTINGS_WRITE_QUEUE_TIMEOUT_MS = 30_000;
const SETTINGS_WRITE_QUEUE_TIMEOUT_ENV = "ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS";

export function getSettingsWriteQueueTimeoutMs(): number {
  const rawValue = process.env[SETTINGS_WRITE_QUEUE_TIMEOUT_ENV]?.trim();
  if (!rawValue) {
    return SETTINGS_WRITE_QUEUE_TIMEOUT_MS;
  }
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : SETTINGS_WRITE_QUEUE_TIMEOUT_MS;
}

export function buildSettingsTempFile(settingsFile: string): string {
  return `${settingsFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
      // This queue owns the real persistence order; providers cannot release the pending entry by awaiting elsewhere.
      // Timeouts apply only pre-commit; after the rename commit, wait out the critical section or a late old write clobbers new settings.
      reject(new Error(`settingService update timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  return Promise.race([runUpdate(enterCommitPhase), timeoutPromise]).finally(clearQueueTimeout);
}
