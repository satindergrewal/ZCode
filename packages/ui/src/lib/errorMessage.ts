export function getErrorMessage(error: unknown): string {
  const rawMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

  // Some errors on the remote-connection path already carry an "Error: ..." prefix;
  // wrapping them in Error again or String(error) for display stacks into
  // "Error: Error: ...". Strip the duplicated prefix, keeping only the meaningful part.
  return rawMessage.replace(/^(Error:\s*)+/i, "").trim();
}
