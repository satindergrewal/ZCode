interface SuccessfulPluginEnabledChangeOptions {
  submit: () => Promise<boolean>;
  isCurrent: () => boolean;
  onSuccess: () => void | Promise<void>;
}

/**
 * Proceed to the grant flow or runtime refresh only once this enable/disable is server-confirmed.
 *
 * The old flow opened the grant dialog before the CUA RPC resolved; on failure or late response after navigation,
 * the user still saw a stale dialog offering to continue, leaving enabled-but-not-granted split state.
 */
export async function runAfterSuccessfulPluginEnabledChange({
  submit,
  isCurrent,
  onSuccess,
}: SuccessfulPluginEnabledChangeOptions): Promise<boolean> {
  const succeeded = await submit();
  if (!succeeded || !isCurrent()) {
    return false;
  }

  await onSuccess();
  return true;
}
