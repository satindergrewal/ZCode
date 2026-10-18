/** Ignores a late failure from another path once this login round has succeeded or its success callback is completing. */
export function shouldApplyOAuthPollingFailure(
  loginSucceeded: boolean,
  loginSuccessInFlight = false,
): boolean {
  return !loginSucceeded && !loginSuccessInFlight;
}
