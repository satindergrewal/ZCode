import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import { resolveWorkspaceTelemetryDetail, type IPlatformService } from "@zcode/shared";
import { createConversationTelemetryService, type IServiceAccessor } from "@zcode/services";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { ConversationTelemetrySupervisor } from "@/v4/telemetry/conversationTelemetrySupervisor.js";

interface ConversationTelemetryAttachmentScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface ConversationTelemetryAttachmentValue {
  scope: ConversationTelemetryAttachmentScope;
  supervisor: ConversationTelemetrySupervisor;
  foregroundEnabled: boolean;
}

interface SupervisorRegistryEntry {
  key: string;
  logicalScopeKey: string;
  supervisor: ConversationTelemetrySupervisor;
  refCount: number;
  subscription: { dispose(): void } | null;
  stale: boolean;
  workspaceDetached: boolean;
}

interface SupervisorLease {
  entry: SupervisorRegistryEntry;
  release(): void;
}

const serviceGenerationIds = new WeakMap<object, number>();
let nextServiceGenerationId = 1;
const supervisorRegistry = new Map<string, SupervisorRegistryEntry>();

function serviceGenerationId(service: object): number {
  const existing = serviceGenerationIds.get(service);
  if (existing !== undefined) return existing;
  const created = nextServiceGenerationId;
  nextServiceGenerationId += 1;
  serviceGenerationIds.set(service, created);
  return created;
}

function attachmentScopeKey(scope: ConversationTelemetryAttachmentScope, service: object): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return [scope.remoteSessionId ?? "__base__", workspaceKey, serviceGenerationId(service)].join(
    "\u0000",
  );
}

function logicalAttachmentScopeKey(scope: ConversationTelemetryAttachmentScope): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return [scope.remoteSessionId ?? "__base__", workspaceKey].join("\u0000");
}

function sameScope(
  left: ConversationTelemetryAttachmentScope,
  right: ConversationTelemetryAttachmentScope,
): boolean {
  return (
    (left.remoteSessionId ?? "__base__") === (right.remoteSessionId ?? "__base__") &&
    (left.workspaceIdentity?.trim() || left.workspacePath) ===
      (right.workspaceIdentity?.trim() || right.workspacePath)
  );
}

function acquireSupervisor(
  scope: ConversationTelemetryAttachmentScope,
  services: IServiceAccessor,
  platform: Pick<IPlatformService, "reportArmsCustomEvent" | "reportTelemetryEvent">,
): SupervisorLease {
  const logicalScopeKey = logicalAttachmentScopeKey(scope);
  const key = attachmentScopeKey(scope, services.zcodeAgentService);
  // On a service generation change, a zero-ref old supervisor dies at once; one still used by a pane marks stale
  // and cleans up when its last lease releases. Old/new generations must never both subscribe long-term.
  for (const [candidateKey, candidate] of supervisorRegistry) {
    if (candidate.logicalScopeKey !== logicalScopeKey || candidateKey === key) {
      continue;
    }
    supervisorRegistry.delete(candidateKey);
    candidate.stale = true;
    if (candidate.refCount === 0) disposeSupervisorEntry(candidate);
  }
  let entry = supervisorRegistry.get(key);
  if (entry) {
    entry.refCount += 1;
  } else {
    entry = {
      key,
      logicalScopeKey,
      supervisor: new ConversationTelemetrySupervisor({
        platform,
        workspaceScopeKey: key,
        workspaceTelemetryDetail: resolveWorkspaceTelemetryDetail(scope),
      }),
      refCount: 1,
      subscription: null,
      stale: false,
      workspaceDetached: false,
    };
    supervisorRegistry.set(key, entry);
  }
  let released = false;
  return {
    entry,
    release: () => {
      if (released) return;
      released = true;
      entry.refCount -= 1;
      if (entry.refCount > 0) return;
      if (entry.stale || entry.workspaceDetached) {
        disposeSupervisorEntry(entry);
      }
      // A ref=0 current generation still holds the live subscription. Closing a pane must not equal
      // workspace detach, or background terminals beyond the 30s keep-worm would drop.
    },
  };
}

function disposeSupervisorEntry(entry: SupervisorRegistryEntry): void {
  if (supervisorRegistry.get(entry.key) === entry) {
    supervisorRegistry.delete(entry.key);
  }
  entry.subscription?.dispose();
  entry.subscription = null;
  entry.supervisor.dispose();
}

/** Window/test teardown boundary; no orphan subscription survives production page death. */
export function disposeConversationTelemetrySupervisors(): void {
  for (const entry of supervisorRegistry.values()) {
    disposeSupervisorEntry(entry);
  }
  supervisorRegistry.clear();
}

/**
 * The Root tab source of truth decides workspace detach. Task/tab switches never remove the scope; closing the last
 * workspace tab marks detached - zero refs die at once, existing panes die after their release.
 */
export function reconcileConversationTelemetryWorkspaceScopes(
  scopes: readonly ConversationTelemetryAttachmentScope[],
): void {
  const attachedKeys = new Set(scopes.map(logicalAttachmentScopeKey));
  for (const entry of supervisorRegistry.values()) {
    entry.workspaceDetached = !attachedKeys.has(entry.logicalScopeKey);
    if (entry.workspaceDetached && entry.refCount === 0) {
      disposeSupervisorEntry(entry);
    }
  }
}

function ensureSupervisorSubscription(
  entry: SupervisorRegistryEntry,
  scope: ConversationTelemetryAttachmentScope,
  services: IServiceAccessor,
): void {
  if (entry.subscription) return;
  const telemetryService = createConversationTelemetryService(services.zcodeAgentService);
  const factEvent = telemetryService.onFact({
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
  });
  entry.subscription = factEvent((fact: ConversationTelemetryFact) =>
    entry.supervisor.handleFact(fact),
  );
}

const ConversationTelemetryAttachmentContext =
  createContext<ConversationTelemetryAttachmentValue | null>(null);

/**
 * The window workspace/service attachment: lifecycle above panes and the SessionDataLayer keep-warm.
 * Web/mobile create no supervisor and install no reporter/subscription.
 */
export function ConversationTelemetryWorkspaceAttachment({
  enabled,
  foregroundEnabled = true,
  services,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  children,
}: ConversationTelemetryAttachmentScope & {
  enabled: boolean;
  foregroundEnabled?: boolean;
  services: IServiceAccessor;
  children: ReactNode;
}) {
  const platform = useOptionalPlatform();
  const scope = useMemo<ConversationTelemetryAttachmentScope>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, workspaceIdentity, workspacePath],
  );
  const lease = useMemo(() => {
    const agentService = services.zcodeAgentService as object | null | undefined;
    if (!enabled || !platform || !agentService) return null;
    // Bug root cause: Root isolated rendering and remote-service preparation may lack PlatformProvider or the agent service.
    // Telemetry is a sidecar; never block the workspace main UI on missing deps. Create the lease by generation once deps land.
    return acquireSupervisor(scope, services, platform);
  }, [enabled, platform, scope, services]);
  const supervisor = lease?.entry.supervisor ?? null;

  useEffect(() => {
    if (!lease) return undefined;
    ensureSupervisorSubscription(lease.entry, scope, services);
    return () => {
      lease.release();
    };
  }, [lease, scope, services]);

  const value = useMemo<ConversationTelemetryAttachmentValue | null>(
    () => (supervisor ? { scope, supervisor, foregroundEnabled } : null),
    [foregroundEnabled, scope, supervisor],
  );
  return (
    <ConversationTelemetryAttachmentContext.Provider value={value}>
      {children}
    </ConversationTelemetryAttachmentContext.Provider>
  );
}

/** A pane overrides context with its own ready service/scope; the Web root attachment stays no-op while null. */
export function ConversationTelemetryPaneAttachment({
  services,
  scope,
  children,
}: {
  services: IServiceAccessor;
  scope: ConversationTelemetryAttachmentScope;
  children: ReactNode;
}) {
  const parentAttachment = useContext(ConversationTelemetryAttachmentContext);
  return (
    <ConversationTelemetryWorkspaceAttachment
      enabled={parentAttachment !== null}
      foregroundEnabled={parentAttachment?.foregroundEnabled ?? false}
      services={services}
      workspacePath={scope.workspacePath}
      workspaceIdentity={scope.workspaceIdentity}
      remoteSessionId={scope.remoteSessionId}
    >
      {children}
    </ConversationTelemetryWorkspaceAttachment>
  );
}

export function useScopedConversationTelemetrySupervisor(
  scope: ConversationTelemetryAttachmentScope,
): ConversationTelemetrySupervisor | null {
  const attachment = useContext(ConversationTelemetryAttachmentContext);
  return attachment && sameScope(attachment.scope, scope) ? attachment.supervisor : null;
}

export function useScopedConversationTelemetryForegroundEnabled(
  scope: ConversationTelemetryAttachmentScope,
): boolean {
  const attachment = useContext(ConversationTelemetryAttachmentContext);
  return Boolean(attachment && attachment.foregroundEnabled && sameScope(attachment.scope, scope));
}
