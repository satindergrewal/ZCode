// MCP tool bridge - projects MCP descriptors into core tool entries

import {
  modelMessageContentToText,
  resolveMcpToolVisibility,
  SessionEventType,
  ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
  ZCODE_MCP_ERROR_PRESENTATION_META_KEY,
  type JsonSchema,
  type McpPort,
  type McpToolCallResult,
  type McpToolDescriptor,
  type ModelMessageContent,
  type ModelMessageContentBlock,
  type ModelToolSideEffectScope,
  type PermissionCapabilityGroup,
  type RiskLevel,
  type SessionEvent,
  type ToolCallProgressPayload,
} from "@zcode/contracts";
import { ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME as ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME } from "@zcode/shared";
import { OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION } from "@zcode/zcode-cua/frame-contract";
import { randomUUID } from "node:crypto";
import type { ToolRegistry } from "../tool/registry.js";
import { createToolRuleNameSet } from "../tool/tool-visibility.js";
import type { ToolEntry } from "../tool/types.js";
import {
  asDataUrl,
  base64PayloadFromMcpImageData,
  normalizeMcpToolResultForModel,
} from "./image-normalization.js";
import { toMcpToolName, toModelVisibleMcpNamePart } from "./name.js";

export {
  createMcpAppProvidedToolEntry,
  MCP_APP_PROVIDED_TOOL_ENTRY_TIMEOUT_MS,
  type McpAppProvidedToolDefinition,
  type McpAppProvidedToolExecutor,
} from "./app-tools.js";
export { toMcpToolName } from "./name.js";

export {
  HOST_NODE_REPL_IMAGE_MAX_DIMENSION,
  MCP_IMAGE_INLINE_BASE64_BYTES,
  MCP_IMAGE_INLINE_RAW_BYTES,
} from "./image-normalization.js";

const MCP_TOOL_TIMEOUT_MS = 30_000;
const OFFICIAL_CUA_PERMISSION_CAPABILITY_GROUP = "official_cua" satisfies PermissionCapabilityGroup;
const CUA_USER_TITLE_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  description:
    "Required short user-facing title in the user's language that describes why the app interface is being read without implementation terms such as CUA, MCP, or get_app_state",
} satisfies JsonSchema;
const ZCODE_CUA_CANONICAL_MODEL_PREFIX = "mcp__computer-use__";
const ZCODE_CUA_PROVIDER_SPELLING_ALIAS_PREFIX = "mcp__computer_use__";

export interface RegisterMcpToolsOptions {
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  /**
   * The official CUA server, verified by the runtime with unforgeable product-authority credentials.
   * The name alone is not trust; when omitted we fail closed: every MCP is treated as a plain tool,
   * with no official-CUA canonical naming and no provider spelling aliases.
   */
  officialCuaServerNames?: ReadonlySet<string>;
  /**
   * namespaced server name -> plugin stable id, from the session-frozen PluginReferenceCatalog.
   * Used only for display.ui attribution; when missing, that server's tools are not projected to the UI.
   */
  pluginIdByServerName?: ReadonlyMap<string, string>;
}

export function registerMcpTools(
  registry: ToolRegistry,
  mcpPort: McpPort,
  descriptors: readonly McpToolDescriptor[],
  options: RegisterMcpToolsOptions = {},
): string[] {
  const allowed = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const disallowed = createToolRuleNameSet(options.disallowedTools);
  const registered: string[] = [];

  for (const descriptor of descriptors) {
    const officialCuaAuthorityVerified =
      options.officialCuaServerNames?.has(descriptor.serverName) === true;
    const descriptorName = toMcpToolName(descriptor);
    const name = toRegisteredMcpToolName(descriptor, officialCuaAuthorityVerified);
    // Once the official CUA projects its primary model name, matching rules by the new name only would silently strand
    // namespaced denylists saved before the upgrade. Deny on a hit under either name; allow on a hit under either name.
    if (allowed && !allowed.has(name) && !allowed.has(descriptorName)) continue;
    if (disallowed?.has(name) || disallowed?.has(descriptorName)) continue;
    registry.register(
      createMcpToolEntry(name, descriptor, mcpPort, officialCuaAuthorityVerified, {
        pluginId: options.pluginIdByServerName?.get(descriptor.serverName),
      }),
    );
    registered.push(name);
  }

  return registered;
}

function toRegisteredMcpToolName(
  descriptor: McpToolDescriptor,
  officialCuaAuthorityVerified: boolean,
): string {
  if (
    officialCuaAuthorityVerified &&
    descriptor.serverName === ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME
  ) {
    // Adapters namespace official plugin serverNames, so descriptor.name is
    // mcp__plugin_zcode-cua_computer-use__*; reusing it verbatim would leave the provider-contracted computer-use
    // tools nonexistent. Once the trust gate passes, project only the model-visible name; handlers keep routing by descriptor.
    return `${ZCODE_CUA_CANONICAL_MODEL_PREFIX}${toModelVisibleMcpNamePart(descriptor.toolName)}`;
  }
  return toMcpToolName(descriptor);
}

export function createMcpToolEntry(
  name: string,
  descriptor: McpToolDescriptor,
  mcpPort: McpPort,
  officialCuaAuthorityVerified: boolean,
  presentation: { pluginId?: string } = {},
): ToolEntry {
  const readOnly = descriptor.annotations?.readOnlyHint === true;
  const destructive = descriptor.annotations?.destructiveHint === true;
  // Plugin UI: tools whose visibility excludes "model" exist for UI callbacks only (mcp/uiCallTool);
  // they still enter the registry to reuse metadata but stay out of provider contracts (registry.toContracts already filters providerVisible=false).
  // Fix: previously only ui.visibility was consulted, so app-only data tools without resourceUri counted as model-visible.
  const providerVisible = resolveMcpToolVisibility(descriptor).includes("model");
  const isHostNodeReplExecution =
    descriptor.serverName === "node_repl" && descriptor.toolName === "js";
  const isCuaAppObservation = isZCodeCuaGetAppState(descriptor);
  // The host node_repl js tool runs local Node code, so the plain-unknown-MCP medium/network
  // defaults do not apply; otherwise the permission UI would describe file/process capabilities as mere network calls.
  const sideEffectScope: ModelToolSideEffectScope = isHostNodeReplExecution ? "system" : "network";
  const riskLevel: RiskLevel = isHostNodeReplExecution
    ? "high"
    : destructive
      ? "high"
      : readOnly
        ? "low"
        : "medium";
  const needsApproval = true;
  const timeoutMs = descriptor.timeoutMs ?? MCP_TOOL_TIMEOUT_MS;
  const resultBudget = officialCuaAuthorityVerified
    ? {
        // Image-block base64 does not count against the model text budget, but tree text can still exceed the plain-MCP
        // 50 KiB. Give the official CUA a generous bounded text budget so generic truncation cannot degrade structured
        // image/image_ref blocks into plain strings or reorder neighbors.
        maxInlineBytes: 256 * 1024,
        maxModelBytes: 256 * 1024,
        strategy: "truncate" as const,
        preview: { direction: "head" as const },
      }
    : isHostNodeReplExecution
      ? {
          maxInlineBytes: 1_000_000,
          maxModelBytes: 64 * 1024,
          strategy: "artifact" as const,
          preview: { direction: "tail" as const, maxBytes: 64 * 1024 },
          artifact: { enabled: true, retention: "session" as const },
        }
      : {
          maxInlineBytes: 100_000,
          maxModelBytes: 50_000,
          strategy: "truncate" as const,
          preview: { direction: "head" as const },
        };

  return {
    // Exact lookup returns Tool not found directly. Mount the one-way alias only while the unforgeable official authority gate
    // holds and the internal serverName is still the official namespaced one; providers keep seeing only canonical names.
    aliases: officialCuaProviderSpellingAliases(name, descriptor, officialCuaAuthorityVerified),
    capability: `MCP tool exposed by ${descriptor.serverName}: ${descriptor.toolName}`,
    // Project-level CUA grants must reuse the unforgeable official authority gate.
    // Server/tool names can be spoofed, so never express this grant via name wildcards.
    ...(officialCuaAuthorityVerified
      ? {
          permissionCapabilityGroup: OFFICIAL_CUA_PERMISSION_CAPABILITY_GROUP,
          // The final raster plus the image_ref right after it define the only pixel coordinate space available to the model.
          // modelContentProtection is the sole host authority; generic resultBudget/hook
          // projection must not truncate, drop, or reorder these blocks, avoiding parallel boolean drift.
          modelContentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
        }
      : {}),
    inputSchema: createModelFacingMcpInputSchema(descriptor, isCuaAppObservation),
    outputSchema: McpToolOutputJsonSchema,
    metadata: {
      concurrentSafe: readOnly || descriptor.annotations?.idempotentHint === true,
      destructive,
      // The MCP tool description must be forwarded into metadata so the registry carries it into model input;
      // otherwise the model sees only name + inputSchema with no basis for calling the tool.
      description: descriptor.description,
      name,
      mcpPresentation: {
        serverName: descriptor.serverName,
        toolName: descriptor.toolName,
        ...(descriptor.description ? { description: descriptor.description } : {}),
        // Only official-MCP results may carry client-trusted structured markers (quota exhausted / no plan).
        ...(descriptor.official ? { official: true } : {}),
        ...(presentation.pluginId ? { pluginId: presentation.pluginId } : {}),
        ...(descriptor.ui ? { ui: descriptor.ui } : {}),
      },
      needsApproval,
      ...(providerVisible ? {} : { providerVisible: false }),
      readOnly,
      riskLevel,
      sideEffectScope,
      timeoutMs,
    },
    permission: {
      permission: "mcp",
      reason: `MCP tool ${descriptor.serverName}/${descriptor.toolName} executes through an external server`,
      riskLevel,
      sideEffectScope,
      needsApproval,
      patternSources: ["toolName", "input", "network"],
      denyPriority: "beforeAsk",
    },
    resultBudget,
    timeout: {
      defaultMs: timeoutMs,
      allowCallOverride: false,
    },
    cancellation: {
      supported: true,
      cleanup: "bestEffort",
      userVisibleMessage: `MCP tool ${name} was cancelled`,
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
    handler: async (input, context) => {
      const startedAt = Date.now();
      const result = await mcpPort.callTool(
        {
          serverName: descriptor.serverName,
          toolName: descriptor.toolName,
          arguments: toMcpRuntimeArguments(input, isCuaAppObservation),
          trace: {
            traceId: context.traceId,
            spanId: context.spanId,
            parentSpanId: context.parentSpanId,
            sessionId: context.sessionId,
            turnId: context.turnId,
          },
          runtimeScope: context.runtimeScope ?? "main",
          workspacePath: context.workingDirectory,
          ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
          ...(context.workspaceIdentity?.trim()
            ? {
                workspaceIdentity: context.workspaceIdentity.trim(),
                workspaceKey: context.workspaceIdentity.trim(),
              }
            : { workspaceKey: context.workingDirectory }),
          ...(context.turnId ? { turnId: context.turnId } : {}),
          clientMode: context.clientMode ?? "desktop-continuous",
          deliveryKind: context.deliveryKind ?? "desktop-continuous",
        },
        {
          signal: context.abortSignal,
          timeoutMs,
          // MCP progress notification (A8) -> ToolCallProgress: same event as Bash output progress; the UI reuses the existing tool-row progress path.
          ...(context.emitEvent
            ? {
                onProgress: (progress: { progress: number; total?: number; message?: string }) => {
                  void context.emitEvent?.(
                    createMcpProgressEvent(context, name, startedAt, progress),
                  );
                },
              }
            : {}),
        },
      );
      // MCP servers return large base64 images; resultBudget only sees the placeholder text,
      // so the handler must stash a copy and swap the model-visible content, keeping provider request bodies sane.
      return normalizeMcpToolResultForModel({
        compressOversizedImages: isHostNodeReplExecution,
        context,
        descriptor,
        preserveOfficialCuaFrames: officialCuaAuthorityVerified,
        result,
        toolName: name,
      });
    },
    formatModelContent: (output) => formatMcpToolResult(output),
  };
}

function createMcpProgressEvent(
  context: Parameters<ToolEntry["handler"]>[1],
  toolName: string,
  startedAt: number,
  progress: { progress: number; total?: number; message?: string },
): SessionEvent {
  const payload: ToolCallProgressPayload = {
    toolCallId: context.toolCallId as ToolCallProgressPayload["toolCallId"],
    toolName,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    progress: progress.progress,
    ...(progress.total !== undefined ? { total: progress.total } : {}),
    ...(progress.message !== undefined ? { message: progress.message } : {}),
  };
  return {
    id: randomUUID() as SessionEvent["id"],
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.ToolCallProgress,
    timestamp: new Date(),
    traceId: context.traceId,
    sequenceNumber: 0,
    payload,
  };
}

function officialCuaProviderSpellingAliases(
  name: string,
  descriptor: McpToolDescriptor,
  officialCuaAuthorityVerified: boolean,
): readonly string[] | undefined {
  if (
    !officialCuaAuthorityVerified ||
    descriptor.serverName !== ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME ||
    !name.startsWith(ZCODE_CUA_CANONICAL_MODEL_PREFIX)
  ) {
    return undefined;
  }
  const toolName = name.slice(ZCODE_CUA_CANONICAL_MODEL_PREFIX.length);
  return toolName.length > 0
    ? [`${ZCODE_CUA_PROVIDER_SPELLING_ALIAS_PREFIX}${toolName}`]
    : undefined;
}

export const McpToolOutputJsonSchema = {
  type: "object",
  required: ["content"],
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
      },
    },
    structuredContent: {},
    isError: {
      type: "boolean",
    },
    _meta: {
      type: "object",
      additionalProperties: true,
    },
  },
  additionalProperties: false,
} satisfies JsonSchema;

function normalizeInputSchema(schema: JsonSchema | undefined): JsonSchema {
  if (!schema || typeof schema !== "object") {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }

  return {
    ...schema,
    type: "object",
    properties:
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? schema.properties
        : {},
  };
}

function createModelFacingMcpInputSchema(
  descriptor: McpToolDescriptor,
  isCuaAppObservation: boolean,
): JsonSchema {
  const schema = normalizeInputSchema(descriptor.inputSchema);
  if (!isCuaAppObservation) return schema;

  const properties = schema.properties as Record<string, unknown>;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];

  // Why: title is the user-facing intent summary ZCode shows, not an upstream zcode-cua parameter. Layer it into the model contract
  // as required and strip it during runtime dispatch — the model emits a stable readable title while upstream keeps a strict schema.
  return {
    ...schema,
    properties: {
      ...properties,
      title: CUA_USER_TITLE_SCHEMA,
    },
    required: [...new Set([...required, "title"])],
  };
}

function isZCodeCuaGetAppState(
  descriptor: Pick<McpToolDescriptor, "serverName" | "toolName">,
): boolean {
  if (descriptor.toolName.trim().toLowerCase().replace(/-/g, "_") !== "get_app_state") {
    return false;
  }

  const serverName = descriptor.serverName.trim().toLowerCase().replace(/_/g, "-");
  return (
    descriptor.serverName === ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME ||
    serverName === "zcode-cua" ||
    serverName === "computer-use" ||
    (serverName.includes("zcode-cua") && serverName.includes("computer-use"))
  );
}

function hasInformativeStructuredContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function formatMcpToolResult(output: unknown): ModelMessageContent {
  if (!isMcpToolCallResult(output)) {
    return stringify(output);
  }

  const blocks = output.content.flatMap(formatContentBlock);
  // Production adapters keep empty keys in structuredContent; undefined, null, empty objects, and
  // empty arrays carry no model information, so never append a fabricated "Structured content" block. Error details with content
  // are still kept: permission guidance relies on that structured channel.
  if (hasInformativeStructuredContent(output.structuredContent)) {
    blocks.push({
      type: "text",
      text: `Structured content:\n${stringify(output.structuredContent)}`,
    });
  }

  const content = blocks.length > 0 ? collapseModelBlocks(blocks) : stringify(output);
  if (!output.isError) return content;
  // Display policy is declared by the MCP result itself; the generic bridge must not recognize specific servers
  // or guess stack membership by parsing error strings.
  const errorPresentation = output._meta?.[ZCODE_MCP_ERROR_PRESENTATION_META_KEY];
  return typeof errorPresentation === "string" &&
    errorPresentation === ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY
    ? content
    : `MCP tool returned an error:\n${modelMessageContentToText(content)}`;
}

function formatContentBlock(block: Record<string, unknown>): ModelMessageContentBlock[] {
  if (block.type === "text" && typeof block.text === "string") {
    return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];
  }
  if (block.type === "image") {
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
    if (typeof block.data === "string" && typeof block.mimeType === "string") {
      return [
        {
          type: "image",
          mediaType: block.mimeType,
          dataUrl: asDataUrl(block.data, block.mimeType),
          source: {
            id: "mcp-image",
            kind: "inline",
            mimeType: block.mimeType,
            placeholder: "MCP image",
            sizeBytes: estimateBase64Bytes(block.data),
          },
        },
      ];
    }
    return [{ type: "text", text: `[MCP image content omitted: ${mimeType}]` }];
  }
  if (block.type === "audio") {
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
    return [{ type: "text", text: `[MCP audio content omitted: ${mimeType}]` }];
  }
  if (block.type === "resource") {
    return [{ type: "text", text: `MCP resource content:\n${stringify(block.resource ?? block)}` }];
  }
  return [{ type: "text", text: stringify(block) }];
}

function collapseModelBlocks(blocks: ModelMessageContentBlock[]): ModelMessageContent {
  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n");
  }
  return blocks;
}

function estimateBase64Bytes(value: string): number | undefined {
  const data = base64PayloadFromMcpImageData(value);
  if (data.length === 0) return undefined;
  return Math.floor((data.replace(/=+$/, "").length * 3) / 4);
}

function isMcpToolCallResult(value: unknown): value is McpToolCallResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as McpToolCallResult).content)
  );
}

function toRecordInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function toMcpRuntimeArguments(
  input: unknown,
  stripCuaUserTitle: boolean,
): Record<string, unknown> {
  const argumentsRecord = toRecordInput(input);
  if (!stripCuaUserTitle || !("title" in argumentsRecord)) return argumentsRecord;

  const runtimeArguments = { ...argumentsRecord };
  delete runtimeArguments.title;
  return runtimeArguments;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
