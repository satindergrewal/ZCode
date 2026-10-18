/** UI remote images allow HTTPS only; on failure each presentational component falls back to a local icon. */
export function isTrustedImageUrl(url: string | undefined): url is string {
  return typeof url === "string" && url.startsWith("https://");
}
