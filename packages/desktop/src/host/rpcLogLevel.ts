import { ZCODE_AGENT_PROVIDER_NOT_READY_CODE } from "@zcode/shared";

type RpcLogLevel = "debug" | "info" | "warn";

/**
 * The host used to log every RPC at error level, making the main log look like all RPCs fail.
 * Grade minimally by message content: FAIL logs warn, high-frequency polling successes log debug, the rest info.
 */
export function resolveRpcLogLevel(message: string, ...args: unknown[]): RpcLogLevel {
  // The background detail panel polls every second and success logs would flood disk; lower only this query's success level, keep failure diagnostics.
  if (message.startsWith("[rpc:call] zcode-agent.backgroundBashOutputV4 OK (")) return "debug";

  // On first workspace attach, the provider registry syncs after the runtime identity query;
  // this coded failure is handshake state, not degradation; avoid one warn per workspace.
  if (
    message.includes("zcode-session.getWorkspaceRuntimeIdentity FAIL") &&
    args.some(
      (arg) =>
        typeof arg === "object" &&
        arg !== null &&
        "code" in arg &&
        (arg as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
    )
  ) {
    return "info";
  }

  return message.includes(" FAIL ") ? "warn" : "info";
}
