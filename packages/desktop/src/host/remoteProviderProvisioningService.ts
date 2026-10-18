import { randomUUID } from "node:crypto";
import {
  providerProvisioningErrorCodeSchema,
  type ProviderProvisioningResult,
  type ProviderProvisioningErrorCode,
} from "@zcode/shared";
import type { IProviderProvisioningTargetService, IServiceAccessor } from "@zcode/services";
import {
  getProviderProvisioningSource,
  type ProviderProvisioningSource,
} from "@zcode/services/node";
import type { ServiceCollection } from "@zcode/services";

export interface RemoteProviderProvisioningExecutor {
  syncLocalToRemote(): Promise<ProviderProvisioningResult>;
}

const executors = new WeakMap<ServiceCollection, RemoteProviderProvisioningExecutor>();

/** Window-Host-private execution capability; never exposed to renderer RPC via ServiceCollection. */
export function getRemoteProviderProvisioningExecutor(
  services: ServiceCollection,
): RemoteProviderProvisioningExecutor | undefined {
  return executors.get(services);
}

export function registerRemoteProviderProvisioningExecutor(
  services: ServiceCollection,
  executor: RemoteProviderProvisioningExecutor,
): void {
  executors.set(services, executor);
}

export function createRemoteProviderProvisioningExecutor(options: {
  source?: ProviderProvisioningSource;
  target?: IProviderProvisioningTargetService;
}): RemoteProviderProvisioningExecutor {
  const syncLocalToRemote = async (): Promise<ProviderProvisioningResult> => {
    const syncId = randomUUID();
    if (!options.source || !options.target) {
      return unsupportedResult(syncId, "Local/Remote Provider Provisioning capability unavailable");
    }
    let errorCode: ProviderProvisioningErrorCode = "source-read-failed";
    try {
      const envelope = await options.source.read(syncId);
      errorCode = "target-call-failed";
      const { errorCode: remoteErrorCode, ...result } = await options.target.apply(envelope);
      // Success results carry no diagnostic fields, so an unknown errorCode cannot make Main
      // discard an already-successful response.
      if (result.status === "applied" || result.status === "already-applied") return result;
      // Legacy targets have no stage codes and any remote may return free text; only the local
      // allowlist passes through.
      const parsedCode = providerProvisioningErrorCodeSchema.safeParse(remoteErrorCode);
      return { ...result, errorCode: parsedCode.success ? parsedCode.data : "target-apply-failed" };
    } catch (error) {
      return {
        syncId,
        status: "failed",
        personalProviderCount: 0,
        credentialCount: 0,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorCode,
        rolledBack: true,
      } satisfies ProviderProvisioningResult;
    }
  };

  return { syncLocalToRemote };
}

export function createRemoteProviderProvisioningExecutorFromWorkspace(options: {
  connectionServices: IServiceAccessor;
  sourceServices?: ServiceCollection;
}): RemoteProviderProvisioningExecutor {
  const source = options.sourceServices
    ? getProviderProvisioningSource(options.sourceServices)
    : undefined;
  const target = (
    options.connectionServices as IServiceAccessor & {
      providerProvisioningTargetService?: IProviderProvisioningTargetService;
    }
  ).providerProvisioningTargetService;
  return createRemoteProviderProvisioningExecutor({ source, target });
}

function unsupportedResult(syncId: string, errorMessage: string): ProviderProvisioningResult {
  return {
    syncId,
    status: "unsupported",
    personalProviderCount: 0,
    credentialCount: 0,
    errorMessage,
    errorCode: "capability-unavailable",
    rolledBack: false,
  };
}
