import { createHash } from "node:crypto";
import { buildRemoteEnvironmentKey, type RemoteTarget } from "@zcode/shared";

/** Never merge same-spec remote environments; pass only the canonical env identity hash, no raw addresses into the telemetry side-channel. */
export function resolveResourceTelemetryEnvironmentKey(
  target: RemoteTarget,
  serverId?: string,
): string {
  const environment = target.kind === "server" && serverId ? { ...target, serverId } : target;
  return createHash("sha256").update(buildRemoteEnvironmentKey(environment)).digest("hex");
}
