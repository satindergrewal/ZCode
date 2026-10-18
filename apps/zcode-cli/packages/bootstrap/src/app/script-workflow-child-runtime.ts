import { join } from "node:path";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import type { ConfigResult } from "@zcode/adapters/config";
import {
  AgentRuntime,
  type AgentRuntimeConfig,
  type AgentRuntimeDeps,
  type ChildClientPortsContext,
  type PermissionService,
} from "@zcode/core";
import {
  type AgentExecutionTelemetryPort,
  type BrowserControlPort,
  type ContextSourcePort,
  type FileSystemPort,
  type HttpClientPort,
  type ImageProcessorPort,
  type JsonSchema,
  type PdfDocumentPort,
  type Logger,
  type McpPort,
  type ModelRequestAdmission,
  type SessionId,
  type SessionStorePort,
  type SkillPort,
  type SkillRoot,
  type ToolArtifactStorePort,
  type TraceContext,
  type WorkflowAgentCallInput,
  type WorkflowEscalatePort,
  type WorkflowSubmitPort,
} from "@zcode/contracts";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import { parseProviderQualifiedModelSelection } from "./provider-registry-selection.js";
import type { ZCodeAppOptions } from "./types.js";

export interface ScriptWorkflowAgentRuntimeDeps {
  agentTelemetry: AgentExecutionTelemetryPort;
  appOptions: ZCodeAppOptions;
  appVersion: string;
  artifactStore?: ToolArtifactStorePort;
  configResult: ConfigResult;
  contextSourcePort?: ContextSourcePort;
  fileSystemPort: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  logger: Logger;
  mcpPort?: McpPort;
  /** The parent session's model factory: child and main turn build Models from the same Registry view, no separate freezing. */
  modelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]>;
  permissionService: PermissionService;
  /**
   * Plugin skill roots (the main-session skill port's same `pluginOutcome.skillRoots`). Bundled roots excluded:
   // only dynamic-workflows lives there, and subagents must not start workflows.
   */
  pluginSkillRoots: readonly SkillRoot[];
  runtime: AgentRuntime;
  runtimeConfig: AgentRuntimeConfig;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  storageRoot: string;
  workingDirectory: string;
}

export function createScriptWorkflowAgentRuntime(input: {
  childSessionId: SessionId;
  deps: ScriptWorkflowAgentRuntimeDeps;
  request: WorkflowAgentCallInput;
  traceContext: TraceContext;
  /**
   * Overrides the child runtime's config slice. dwf actors land the tool surface through it: `workflowActorToolPolicy` yields a
   * `toolDisallowlist` (subtraction of the full set) while `request.opts.tools` can only express an allowlist -- not
   * the same degree of freedom.
   */
  configOverrides?: Partial<AgentRuntimeConfig>;
  /**
   * Session-level submit port. Injecting it registers the submit_result tool for that session (core's registration gate keys on the port's presence);
   * it is the termination channel for dwf typed asks.
   */
  workflowSubmitPort?: WorkflowSubmitPort;
  /**
   * The mono subagent's typed `submit_result` declaration:
   * when present, core registers `{ result: <schema> }` instead of arbitrary JSON. Meaningful only alongside workflowSubmitPort.
   */
  workflowSubmitSchema?: JsonSchema;
  /**
   * Session-level escalation port. Injecting it registers the `escalate` tool
   * (the registration gate again keys on presence) -- the actor's only help channel when truly blocked.
   */
  workflowEscalatePort?: WorkflowEscalatePort;
  /**
   * Model-request admission port. Provided by the driver for dwf actors
   * (every model-request attempt passes the process-wide gate first); legacy `Workflow`-tool subagents omit it --
   * ungated and signal-free. Enters runtime deps alongside the two tool ports.
   */
  modelRequestAdmission?: ModelRequestAdmission;
  /**
   * The `description` on the interaction request's origin (permission-dialog source badge text). For dwf actors the factory supplies
   `<persona name> (<siteId>@<ordinal>)` (workflow-actor-permission.ts); on absence fall back to
   `request.opts.label` / agentType (legacy workflow child's existing behavior).
   */
  interactionDescription?: string;
  /**
   * The **parent session's** browser port (the one the main runtime uses). Present = the subagent gets Browser Use: derive a child via
   `forChildSession` — tab ownership is the child session's own id, workspace/clientMode from the parent,
   // and runtime shutdown closes the tabs and revokes registration. Only the dwf actor passes it: its runtime always
   // closeBrowserSession on run dispose; the legacy workflow child has no shutdown path and passes nothing.
   * （apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Subagent sessions」）。
   */
  browserControlPort?: BrowserControlPort;
}): AgentRuntime {
  // A dwf actor goes through configOverrides.workflowActor, the builder's overlay path, where systemPrompt must
  // be absent (the builder throws when both are set) -- the parent's custom system prompt must still reach the child, so
  // strip it from the inherited config rather than relying on a later override.
  const { systemPrompt: inheritedSystemPrompt, ...inheritedConfig } = input.deps.runtimeConfig;
  const systemPrompt =
    input.configOverrides?.workflowActor === undefined
      ? (input.request.opts?.systemPrompt ?? inheritedSystemPrompt)
      : undefined;
  const parentSelection = input.deps.runtime.getSessionModelSelection();
  const requestedSelection = input.request.opts?.model
    ? parseProviderQualifiedModelSelection(input.request.opts.model)
    : undefined;
  if (input.request.opts?.model && !requestedSelection) {
    throw new Error(`Workflow child model must be provider-qualified: ${input.request.opts.model}`);
  }
  const modelSelection = requestedSelection ?? parentSelection;
  return new AgentRuntime(
    input.childSessionId,
    {
      ...inheritedConfig,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      agentName: input.request.opts?.agentType ?? "zcode-workflow",
      maxTurns: input.request.opts?.maxTurns ?? input.deps.runtimeConfig.maxTurns,
      // Baseline YOLO; the parent task keeps its own Guarded. The legacy script workflow child stops here; the dwf actor
      // overrides via configOverrides to the mode recorded on the run (docs/dynamic-workflow/launch.md
      // 「Permissions inside a run」）。
      mode: "yolo",
      modelSelection,
      parentSessionId: input.deps.sessionId,
      subagents: { enabled: false },
      taskType: "workflow_child",
      // An actor exists only under one run, hence born activated (launch.md "On demand: activation", Children):
      // never inherit the parent's onDemand flag, or the spread carries onDemand into a child with no activation entrypoint.
      dynamicWorkflowToolsOnDemand: false,
      toolAllowlist: input.request.opts?.tools,
      workingDirectory: input.deps.workingDirectory,
      ...input.configOverrides,
    },
    {
      ...createRuntimeDeps(input.deps, input.traceContext, input.childSessionId, {
        // Outbound interaction ports can only be minted by the parent runtime: child sessions are not identities the client knows.
        // This used to pass `appOptions.providerRuntimeHeadersPort` /
        // `deps.permissionBroker` straight through, so the actor asked the desktop as `sess_dwf-...`, the desktop's
        // requireSession threw, the response never went out, and the child hung before its first model request.
        agentId: input.childSessionId,
        agentType: input.request.opts?.agentType ?? "zcode-workflow",
        childSessionId: input.childSessionId,
        description:
          input.interactionDescription ??
          input.request.opts?.label ??
          input.request.opts?.agentType ??
          "workflow agent",
        ...(input.traceContext.turnId === undefined
          ? {}
          : { parentTurnId: input.traceContext.turnId }),
      }),
      ...(input.browserControlPort === undefined
        ? {}
        : {
            browserControlPort:
              input.browserControlPort.forChildSession?.({
                childSessionId: input.childSessionId,
                parentSessionId: input.deps.sessionId,
              }) ?? input.browserControlPort,
          }),
      ...(input.workflowSubmitPort ? { workflowSubmitPort: input.workflowSubmitPort } : {}),
      ...(input.workflowSubmitPort && input.workflowSubmitSchema
        ? { workflowSubmitSchema: input.workflowSubmitSchema }
        : {}),
      ...(input.workflowEscalatePort ? { workflowEscalatePort: input.workflowEscalatePort } : {}),
      ...(input.modelRequestAdmission
        ? { modelRequestAdmission: input.modelRequestAdmission }
        : {}),
    },
  );
}

function createRuntimeDeps(
  deps: ScriptWorkflowAgentRuntimeDeps,
  traceContext: TraceContext,
  childSessionId: SessionId,
  clientPortsContext: ChildClientPortsContext,
): ConstructorParameters<typeof AgentRuntime>[2] {
  return {
    agentTelemetry: deps.agentTelemetry,
    agentTelemetryCausation: deps.agentTelemetry.captureCausation(),
    // Script workflow children own their lifecycle; a Link keeps the origin relationship.
    agentTelemetryCausationMode: "linked_root",
    appVersion: deps.appVersion,
    artifactStore: deps.artifactStore,
    contextSourcePort:
      deps.contextSourcePort ??
      deps.appOptions.contextSourcePort ??
      createNodeContextSourceAdapter({ env: deps.appOptions.env }),
    // Live channel (mirroring subagents): raw child events only **notify** the parent runtime's external sink set;
    // the child sessionId is kept so the protocol routes it as a detached live session; the parent no longer appends,
    // so each event exists exactly once in the shared store.
    //
    // Must be installed at **construction**: `ensureSessionPersistedForExternalActivity` writes SessionTitleUpdated
    // as sequenceNumber 1, and the v4 gateway drains only contiguous seq -- a subscription attached later starts at seq 2
    // and waits forever for a seq 1 that never comes (why the legacy subscribeEvents channel never lived-streamed).
    eventSink: {
      onSessionEvent: async (event) => {
        await deps.runtime.notifyExternalChildSessionEvent({
          childSessionId,
          event,
          traceContext,
          // Interaction events mirror to the parent session too: the confirm dialog comes only from the parent's projection (same
          // attribution as createChildClientPorts, docs/dynamic-workflow/launch.md "Permissions inside a run").
          interactionOrigin: clientPortsContext,
        });
      },
    },
    // Share the parent runtime's event store: child events land in the same store under the child's own sessionId,
    // so v4's `loadPersistedEvents(childSessionId)` hits. With a private in-memory store it would read nothing
    // and the transcript stays blank forever (as in subagent.ts's `eventStore: this.eventStore`).
    eventStore: deps.runtime.getSessionEventStore(),
    executionPort:
      deps.appOptions.executionPort ??
      createNodeExecutionAdapter({
        onToolExecResource: deps.appOptions.onToolExecResource,
        network: {
          httpProxy: deps.configResult.config.network.httpProxy,
          noProxy: deps.configResult.config.network.noProxy,
          caCertFile: deps.configResult.config.network.caCertFile,
        },
        outputRootDir: join(deps.storageRoot, "cli", "exec"),
        processEnv: deps.appOptions.env ?? process.env,
      }),
    fileSystemPort: deps.appOptions.fileSystemPort ?? createNodeFileSystemAdapter(),
    httpClientPort:
      deps.httpClientPort ??
      deps.appOptions.httpClientPort ??
      createNodeWebFetchHttpClientAdapter({
        env: deps.appOptions.env ?? process.env,
        proxyUrl: deps.configResult.config.network.httpProxy,
        noProxy: deps.configResult.config.network.noProxy,
        caCertFile: deps.configResult.config.network.caCertFile,
        timeoutMs: deps.configResult.config.network.timeout,
      }),
    imageProcessorPort: deps.imageProcessorPort,
    pdfDocumentPort: deps.pdfDocumentPort,
    logger: deps.logger,
    mcpPort: deps.mcpPort,
    modelFactory: deps.modelFactory,
    resolveEffectiveModelSelection: deps.appOptions.resolveEffectiveModelSelection,
    // permissionBroker + providerRuntimeHeadersPort live in there: parent-runtime derived, routing identity rewritten to the parent session.
    ...deps.runtime.createChildClientPorts(clientPortsContext),
    permissionService: deps.permissionService,
    sessionStore: deps.sessionStore,
    skillPort: createWorkflowChildSkillPort(deps),
    traceContext,
  };
}

/**
 * The workflow child's skill ports: user config roots + plugin skill roots; disabled paths mirror the main session.
 *
 * Root cause (2026-09-30): this used to carry only user-config roots; plugin skill roots were later added to the main session's copy and
 // the child drifted — dwf subagents could not see browser-use's control-browser and had to forage the plugin dirs.
 */
export function createWorkflowChildSkillPort(
  deps: Pick<ScriptWorkflowAgentRuntimeDeps, "appOptions" | "configResult" | "pluginSkillRoots">,
): SkillPort | undefined {
  if (!deps.configResult.config.features.skill || !deps.configResult.config.skills.enabled) {
    return undefined;
  }
  return (
    deps.appOptions.skillPort ??
    createNodeSkillAdapter({
      extraRoots: deps.configResult.config.skills.roots,
      extraResolvedRoots: [...deps.pluginSkillRoots],
      // Script workflow child runtimes must not bypass user-disabled SKILL.md paths.
      disabledPaths: collectDisabledPaths(deps.configResult.config.skillOverrides),
    })
  );
}
