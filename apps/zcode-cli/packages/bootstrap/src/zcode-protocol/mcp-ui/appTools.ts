import type { Logger, McpToolCallResult } from "@zcode/contracts";
import type { McpAppProvidedToolDefinition, McpAppProvidedToolExecutor } from "@zcode/core";
import {
  MCP_APPS_APP_TOOL_ARGUMENTS_MAX_BYTES,
  MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS,
  MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS,
  MCP_APPS_APP_TOOL_RESULT_MAX_BYTES,
  buildMcpAppsAppToolModelName,
  type McpAppsAppToolCallRequest,
  type McpAppsAppToolDescriptor,
} from "@zcode/shared/mcp-apps";
import { randomUUID } from "node:crypto";
import type {
  McpUiAppToolCallParams,
  McpUiAppToolInstance,
  McpUiRegisterAppToolsParams,
  McpUiRegisterAppToolsResult,
  McpUiResolveAppToolCallParams,
} from "./appToolsContract.js";

/**
 * The App-Provided Tools registry: the session's page instances, the exposed model-facing set, and the single owner of pending calls.
 // Memory only; cleared on session close, never persisted. Model calls travel the instance mailbox (`publishCall` -> live-only projection delta) to the
 // single instance; the renderer claims it, the page runs tools/call, and the result returns via resolve.
 */
export interface McpUiAppToolsHost {
  /** Sync the exposed set to the session runtime (wholesale replace); null when the session is gone. */
  applyTools(
    sessionId: string,
    definitions: readonly McpAppProvidedToolDefinition[],
    execute: McpAppProvidedToolExecutor,
  ): string[] | null;
  /** Mailbox delivery: one pending call -> the session's live projection (to that one instance only). */
  publishCall(
    sessionId: string,
    target: {
      pluginId: string;
      serverName: string;
      instance: McpUiAppToolInstance;
      credential: import("@zcode/shared/mcp-apps").McpAppInstance;
    },
    call: McpAppsAppToolCallRequest,
  ): void;
  logger?: Logger;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => () => void;
  createCallId?: () => string;
}

interface InstanceRecord {
  credential: import("@zcode/shared/mcp-apps").McpAppInstance;
  instance: McpUiAppToolInstance;
  pluginId: string;
  serverName: string;
  /** First-registered ordinal: per server only the highest ordinal exposes; re-registration keeps it. */
  seq: number;
  tools: McpAppsAppToolDescriptor[];
}

interface PendingCall {
  instanceKey: string;
  toolName: string;
  claimed: boolean;
  settle(outcome: { result: McpToolCallResult } | { error: Error }): void;
  cancelTimer: () => void;
}

interface SessionState {
  instances: Map<string, InstanceRecord>;
  nextSeq: number;
  pending: Map<string, PendingCall>;
}

/** Instance key = sandbox scope + generation; a new generation in the same scope replaces the old. */
export const buildMcpUiAppToolInstanceKey = (instance: McpUiAppToolInstance) =>
  `${instance.scopeId}|${instance.generation}`;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

export class McpUiAppToolRegistry {
  private readonly sessions = new Map<string, SessionState>();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;
  private readonly createCallId: () => string;

  constructor(private readonly host: McpUiAppToolsHost) {
    this.now = host.now ?? Date.now;
    this.setTimer =
      host.setTimer ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    this.createCallId = host.createCallId ?? randomUUID;
  }

  register(params: McpUiRegisterAppToolsParams): McpUiRegisterAppToolsResult {
    const session = this.sessionOf(params.sessionId);
    const key = buildMcpUiAppToolInstanceKey(params);
    // A new generation in the same sandbox scope (page reload / remount) replaces the old one.
    for (const [existingKey, record] of Array.from(session.instances)) {
      if (existingKey !== key && record.instance.scopeId === params.scopeId) {
        this.dropInstance(params.sessionId, session, existingKey, "App page was reloaded");
      }
    }
    const existing = session.instances.get(key);
    session.instances.set(key, {
      credential: params.instance,
      instance: { scopeId: params.scopeId, generation: params.generation },
      pluginId: params.pluginId,
      serverName: params.serverName,
      seq: existing?.seq ?? session.nextSeq++,
      tools: params.tools,
    });
    const exposed = this.sync(params.sessionId, session);
    const mine = exposed.filter(
      (item) => item.scopeId === params.scopeId && item.generation === params.generation,
    );
    this.host.logger?.info("MCP UI app tools registered", {
      event: "mcp.ui.app_tools.registered",
      mcpServerName: params.serverName,
      sessionId: params.sessionId,
      toolCount: params.tools.length,
      exposedCount: mine.length,
    });
    return { tools: mine.map((item) => ({ name: item.toolName, modelName: item.modelName })) };
  }

  unregister(sessionId: string, instance: McpUiAppToolInstance): number {
    const session = this.sessions.get(sessionId);
    const key = buildMcpUiAppToolInstanceKey(instance);
    const record = session?.instances.get(key);
    if (!session || !record) return 0;
    this.dropInstance(sessionId, session, key, "App page was closed");
    this.sync(sessionId, session);
    return record.tools.length;
  }

  claim(params: McpUiAppToolCallParams): boolean {
    const session = this.sessions.get(params.sessionId);
    const pending = session?.pending.get(params.callId);
    const key = buildMcpUiAppToolInstanceKey(params);
    if (!session || !pending || pending.instanceKey !== key) return false;
    // callId idempotency: a replayed claim on the same instance returns true without resetting timers; the renderer dedupes by callId, never executing twice.
    if (pending.claimed) return true;
    pending.cancelTimer();
    pending.claimed = true;
    pending.cancelTimer = this.setTimer(
      () =>
        pending.settle({
          error: new Error(
            `App tool ${pending.toolName} timed out after ${MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS} ms`,
          ),
        }),
      MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS,
    );
    return true;
  }

  resolve(params: McpUiResolveAppToolCallParams): boolean {
    const session = this.sessions.get(params.sessionId);
    const pending = session?.pending.get(params.callId);
    if (
      !pending ||
      !pending.claimed ||
      pending.instanceKey !== buildMcpUiAppToolInstanceKey(params)
    ) {
      return false;
    }
    if (params.error) {
      pending.settle({ error: new Error(params.error.message || "App tool failed") });
      return true;
    }
    const result = params.result as McpToolCallResult;
    if (jsonBytes(result) > MCP_APPS_APP_TOOL_RESULT_MAX_BYTES) {
      pending.settle({
        error: new Error(`App tool result exceeds ${MCP_APPS_APP_TOOL_RESULT_MAX_BYTES} bytes`),
      });
      return true;
    }
    pending.settle({ result });
    return true;
  }

  /** Session close: fail every pending call and drop registrations (the runtime dies with the session; no more tool sync). */
  clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    for (const pending of Array.from(session.pending.values())) {
      pending.settle({ error: new Error("Session was closed") });
    }
  }

  private readonly execute = (sessionId: string): McpAppProvidedToolExecutor => {
    return (call, options) => {
      const session = this.sessions.get(sessionId);
      const instanceKey = buildMcpUiAppToolInstanceKey(call.definition);
      const instance = session?.instances.get(instanceKey);
      if (!session || !instance) {
        return Promise.reject(
          new Error(`The ${call.definition.serverName} app page is not running`),
        );
      }
      if (jsonBytes(call.arguments) > MCP_APPS_APP_TOOL_ARGUMENTS_MAX_BYTES) {
        return Promise.reject(new Error("App tool arguments are too large"));
      }
      if (options.signal.aborted) return Promise.reject(new Error("App tool call was cancelled"));
      return new Promise<McpToolCallResult>((resolve, reject) => {
        const callId = this.createCallId();
        let settled = false;
        const onAbort = () => pending.settle({ error: new Error("App tool call was cancelled") });
        const pending: PendingCall = {
          instanceKey,
          toolName: call.definition.toolName,
          claimed: false,
          settle: (outcome) => {
            if (settled) return;
            settled = true;
            pending.cancelTimer();
            options.signal.removeEventListener("abort", onAbort);
            session.pending.delete(callId);
            if ("result" in outcome) resolve(outcome.result);
            else {
              this.host.publishCall(
                sessionId,
                {
                  pluginId: instance.pluginId,
                  serverName: instance.serverName,
                  instance: instance.instance,
                  credential: instance.credential,
                },
                { callId, toolName: call.definition.toolName, arguments: {}, cancelled: true },
              );
              reject(outcome.error);
            }
          },
          // Claim deadline: no renderer claim means the page is not running (the mailbox does not retry); end the call and deregister the instance.
          cancelTimer: this.setTimer(() => {
            pending.settle({
              error: new Error(`The ${instance.serverName} app page is not running`),
            });
            if (session.instances.has(instanceKey)) {
              this.dropInstance(sessionId, session, instanceKey, "App page is not running");
              this.sync(sessionId, session);
            }
          }, MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS),
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        session.pending.set(callId, pending);
        this.host.publishCall(
          sessionId,
          {
            pluginId: instance.pluginId,
            serverName: instance.serverName,
            instance: instance.instance,
            credential: instance.credential,
          },
          { callId, toolName: call.definition.toolName, arguments: call.arguments },
        );
      });
    };
  };

  private sessionOf(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { instances: new Map(), nextSeq: 1, pending: new Map() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private dropInstance(
    sessionId: string,
    session: SessionState,
    instanceKey: string,
    reason: string,
  ): void {
    session.instances.delete(instanceKey);
    for (const pending of Array.from(session.pending.values())) {
      if (pending.instanceKey === instanceKey) pending.settle({ error: new Error(reason) });
    }
    this.host.logger?.debug?.("MCP UI app tool instance dropped", {
      event: "mcp.ui.app_tools.dropped",
      sessionId,
      reason,
    });
  }

  /** Compute the exposed set (per server, only the latest registered instance) and sync; returns the exposed definitions. */
  private sync(sessionId: string, session: SessionState): McpAppProvidedToolDefinition[] {
    const latestByServer = new Map<string, InstanceRecord>();
    for (const record of session.instances.values()) {
      const current = latestByServer.get(record.serverName);
      if (!current || record.seq > current.seq) latestByServer.set(record.serverName, record);
    }
    const definitions: McpAppProvidedToolDefinition[] = [];
    const seen = new Set<string>();
    const servers = Array.from(latestByServer.values()).sort((a, b) =>
      a.serverName.localeCompare(b.serverName),
    );
    for (const record of servers) {
      for (const tool of record.tools) {
        const modelName = buildMcpAppsAppToolModelName(record.serverName, tool.name);
        if (seen.has(modelName)) continue;
        seen.add(modelName);
        definitions.push({
          modelName,
          serverName: record.serverName,
          pluginId: record.pluginId,
          scopeId: record.instance.scopeId,
          generation: record.instance.generation,
          toolName: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          ...(tool.annotations?.readOnlyHint !== undefined
            ? { readOnlyHint: tool.annotations.readOnlyHint }
            : {}),
          ...(tool.annotations?.destructiveHint !== undefined
            ? { destructiveHint: tool.annotations.destructiveHint }
            : {}),
          ...(tool.annotations?.idempotentHint !== undefined
            ? { idempotentHint: tool.annotations.idempotentHint }
            : {}),
        });
      }
    }
    const applied = this.host.applyTools(sessionId, definitions, this.execute(sessionId));
    if (applied === null) {
      this.clearSession(sessionId);
      return [];
    }
    const appliedNames = new Set(applied);
    return definitions.filter((definition) => appliedNames.has(definition.modelName));
  }
}
