import type { McpAppInstance } from "@zcode/shared/mcp-apps";
import { createHash, randomUUID } from "node:crypto";

export interface McpUiInstanceBinding {
  workspace: string;
  accountContext?: string;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  resourceUri: string;
  ownerWebContentsId: number;
}
type Source = { identity: string; generation: number };
interface InstanceRecord {
  lease: McpAppInstance;
  binding: McpUiInstanceBinding;
  source: Source;
  cancel: AbortController;
  watched?: boolean;
  pins: Set<string>;
  onActivity?: (callId: string, active: boolean) => void;
}
/** Single credential owner. Removal from the registry precedes cancellation; late results never regain execution. */
export class McpUiInstances {
  private readonly runtimeId = randomUUID();
  private generation = 0;
  private readonly records = new Map<string, InstanceRecord>();
  private readonly logical = new Map<string, string>();
  private key(b: McpUiInstanceBinding): string {
    return JSON.stringify([
      b.workspace,
      b.sessionId,
      b.pluginId,
      b.serverName,
      b.scopeId,
      b.resourceUri,
      b.ownerWebContentsId,
    ]);
  }
  open(binding: McpUiInstanceBinding, source: Source): McpAppInstance {
    const key = this.key(binding);
    const previous = this.records.get(this.logical.get(key) ?? "");
    if (
      previous &&
      previous.source.identity === source.identity &&
      previous.source.generation === source.generation &&
      previous.binding.accountContext === binding.accountContext
    )
      return previous.lease;
    if (previous) this.close(previous.lease);
    const lease: McpAppInstance = {
      runtimeId: this.runtimeId,
      generation: ++this.generation,
      token: randomUUID(),
      appIdentity: createHash("sha256")
        .update(
          JSON.stringify([
            binding.workspace,
            binding.serverName,
            source.identity,
            binding.accountContext ?? "",
          ]),
        )
        .digest("hex"),
    };
    this.records.set(lease.token, {
      lease,
      binding,
      source,
      cancel: new AbortController(),
      pins: new Set(),
    });
    this.logical.set(key, lease.token);
    return lease;
  }
  validate(
    lease: McpAppInstance,
    scope: {
      sessionId: string;
      pluginId: string;
      serverName: string;
      workspace?: { workspaceIdentity?: string; workspacePath: string };
    },
    source: Source | null,
  ): InstanceRecord {
    const record = this.records.get(lease.token);
    if (
      !record ||
      record.lease.runtimeId !== lease.runtimeId ||
      record.lease.generation !== lease.generation ||
      record.lease.appIdentity !== lease.appIdentity ||
      (scope.workspace &&
        record.binding.workspace !==
          (scope.workspace.workspaceIdentity?.trim() || scope.workspace.workspacePath)) ||
      record.binding.sessionId !== scope.sessionId ||
      record.binding.pluginId !== scope.pluginId ||
      record.binding.serverName !== scope.serverName
    )
      throw new Error("MCP App instance is no longer authorized");
    // Confirm the request belongs to this instance, then revoke via that connection's snapshot. Wrong-server / stale-generation requests never close a live page.
    if (
      !source ||
      source.identity !== record.source.identity ||
      source.generation !== record.source.generation
    ) {
      this.close(record.lease);
      throw new Error("MCP App instance is no longer authorized");
    }
    return record;
  }
  retain(token: string, callId: string) {
    const record = this.records.get(token);
    if (!record) throw new Error("MCP App instance is no longer authorized");
    const pin = `${callId}:${randomUUID()}`;
    record.pins.add(pin);
    record.onActivity?.(pin, true);
    return {
      signal: record.cancel.signal,
      release: () => {
        if (record.pins.delete(pin)) record.onActivity?.(pin, false);
      },
    };
  }
  isBusy(lease: McpAppInstance): boolean {
    return (this.records.get(lease.token)?.pins.size ?? 0) > 0;
  }
  find(token: string): InstanceRecord | undefined {
    return this.records.get(token);
  }
  close(lease: McpAppInstance): boolean {
    const record = this.records.get(lease.token);
    if (
      !record ||
      record.lease.runtimeId !== lease.runtimeId ||
      record.lease.generation !== lease.generation ||
      record.lease.appIdentity !== lease.appIdentity
    )
      return false;
    this.records.delete(lease.token);
    const key = this.key(record.binding);
    if (this.logical.get(key) === lease.token) this.logical.delete(key);
    record.cancel.abort();
    return true;
  }
  closeSession(sessionId: string): void {
    for (const record of this.records.values())
      if (record.binding.sessionId === sessionId) this.close(record.lease);
  }
}
export const mcpUiInstances = new McpUiInstances();
