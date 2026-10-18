import { validateServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";

/**
 * Reads the installation-level server identity. A real Supervisor start must
 * provide the server root; when absent, keep the HTTP factory embeddable/unit
 * testable and let the caller decide whether to use the hostname fallback.
 */
export async function resolveCoreServerId(
  serverRoot = process.env.ZCODE_SERVER_ROOT?.trim(),
): Promise<string | undefined> {
  if (!serverRoot) return undefined;
  const ownership = await validateServerInstallOwnership(resolveServerLayout(serverRoot));
  return ownership.installationId;
}
