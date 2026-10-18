import {
  AutomationCreateLimitError,
  hasRelativeDelayMinutes,
  isAutomationCreateLimitError,
  type AutomationPort,
  type CronAutomation,
} from "@zcode/contracts";
import {
  parseModelPickerValue,
  zcodeAutomationCheckTaskBindingResultSchema,
  zcodeAutomationCreateResultSchema,
  zcodeAutomationDeleteResultSchema,
  zcodeAutomationListResultSchema,
  zcodeAutomationUpdateResultSchema,
  zcodeProtocolMethods,
  type ZCodeAutomationProtocol,
} from "@zcode/shared";
import {
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";

const AUTOMATION_CREATE_FROM_AUTOMATION_RUN_ERROR =
  "Cannot create a scheduled task while running a scheduled task.";

const AUTOMATION_CREATE_IN_BOUND_SESSION_ERROR =
  "Cannot create a scheduled task inside a session that already belongs to a scheduled task. " +
  "Ask the user to start a new chat to create another scheduled task.";

const AUTOMATION_CREATE_BOUND_SESSION_CHECK_ERROR =
  "Cannot verify whether this session belongs to a scheduled task. Try again later.";

export function createProtocolAutomationPort(
  context: ZCodeProtocolAgentServerContext,
    // Owning-session resolver: the port is constructed per session, so bind directly to the session record it serves.
    // Never depend on context.sessions lookups -- V4/desktop sessions may be absent from that legacy map, which used to make
    // activeSession miss and drop permission/thinking levels (only the model's createContext fallback saved it).
  resolveOwnSession?: () => ZCodeProtocolSessionRecord | undefined,
): AutomationPort {
  return {
    async create(input, createContext) {
            // Prefer the owning session (the one this tool runs in); fall back to the legacy map by createContext.sessionId.
      const activeSession =
        resolveOwnSession?.() ??
        (createContext?.sessionId ? context.sessions.get(createContext.sessionId) : undefined);
      if (activeSession?.activeAutomationId?.trim()) {
                // This turn was already dispatched by an automationId; another CronCreate would start a recursive scheduled chain.
                // Checked here in the port; on a hit, protocol automation/create is never called.
        throw new Error(AUTOMATION_CREATE_FROM_AUTOMATION_RUN_ERROR);
      }
            // Desktop interactive input reaches the CLI directly (bypassing the host adapter's toolDenylist injection), so when a plain user
            // keeps typing in a session already bound to a scheduled task, CronCreate is still registered with no per-turn filter and can bypass
            // every earlier guard. This is an entry-agnostic backstop at the creation entrance, by targetTaskId:
            // if this session is already some automation's bound session (= a scheduled-task session), reject; a plain
            // session has no binding at first creation and passes. The ownership check must use the dedicated EXISTS protocol, never the full list; else
            // corrupted display fields of any historical task would make this session report "cannot verify".
      const ownSessionId = createContext?.sessionId ?? activeSession?.app.sessionId;
      if (ownSessionId) {
        let bound: boolean;
        try {
          try {
            const result = await context.requestClient(
              zcodeProtocolMethods.automationCheckTaskBinding,
              { targetTaskId: ownSessionId },
              zcodeAutomationCheckTaskBindingResultSchema,
            );
            bound = result.bound;
          } catch (error) {
            if (!(error instanceof ProtocolRequestError && error.code === -32601)) {
              throw error;
            }
                        // Protocol version still 1: while the connection predates the upgrade or the remote Host is old, the dedicated
                        // ownership method returns -32601. Only "method not found" proves a capability gap -- then fall back to legacy list filtering;
                        // database/transport/protocol errors still fail closed outside, never misread as unbound.
            const legacyResult = await context.requestClient(
              zcodeProtocolMethods.automationList,
              {},
              zcodeAutomationListResultSchema,
            );
            bound = legacyResult.automations.some(
              (automation) => automation.targetTaskId === ownSessionId,
            );
          }
        } catch (error) {
          context.logger?.warn("Failed to check bound automations before CronCreate", {
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "automation.create.bound_session_check.failed",
            sessionId: ownSessionId,
          });
                    // The ownership query is the authorization boundary against recursive CronCreate; unknown must not mean unbound,
                    // or a transient host/database failure reopens creation. Query failure must fail closed.
          throw new Error(AUTOMATION_CREATE_BOUND_SESSION_CHECK_ERROR);
        }
        if (bound) {
          throw new Error(AUTOMATION_CREATE_IN_BOUND_SESSION_ERROR);
        }
      }
            // CronCreate's tool context carries only part of the config, losing permission/thinking levels across layers.
            // The protocol boundary reads the live runtime by sessionId, saving exactly what the user saw when triggering the tool.
      const runtimeModelSelection =
        activeSession?.app.runtime.getSessionModelSelection() ??
        (() => {
          try {
            return createContext?.model ? parseModelPickerValue(createContext.model) : undefined;
          } catch {
            return undefined;
          }
        })();
      const runtimeMode = activeSession?.app.getMode();
      const hasIntervalCarrier = input.intervalUnit !== undefined && input.interval !== undefined;
      let result;
      try {
        result = await context.requestClient(
          zcodeProtocolMethods.automationCreate,
          {
                        // Relative times are never converted by the model; the compat protocol still demands cronExpr, and the service layer overwrites the placeholder with the real clock.
                        // A `!== null` check would send plain cron calls without delayMinutes down the relative branch,
                        // forcing recurring=false; the only relative-task signal is hasRelativeDelayMinutes (an explicit number).
            cronExpr: input.cron ?? "* * * * *",
            ...(hasRelativeDelayMinutes(input) ? { relativeDelayMinutes: input.delayMinutes } : {}),
            prompt: input.prompt,
            title: input.title,
            recurring: hasRelativeDelayMinutes(input)
              ? false
              : hasIntervalCarrier
                ? true
                : (input.recurring ?? true),
                        // Workspace is still injected by the protocol server from the current session.
            ...(runtimeModelSelection ? { modelSelection: runtimeModelSelection } : {}),
            ...(runtimeMode ? { mode: runtimeMode === "auto" ? "build" : runtimeMode } : {}),
            ...(createContext?.sessionId ? { targetTaskId: createContext.sessionId } : {}),
            ...(activeSession?.activeBotDeliveryTarget
              ? { botDeliveryTarget: activeSession.activeBotDeliveryTarget }
              : {}),
            ...(hasIntervalCarrier
              ? {
                                    // Never pass the finite cap through for new carriers; the create protocol has no maxRuns=null clearing semantics.
                  intervalUnit: input.intervalUnit,
                  interval: input.interval,
                }
              : input.maxRuns !== undefined
                ? { maxRuns: input.maxRuns }
                : {}),
          },
          zcodeAutomationCreateResultSchema,
        );
      } catch (error) {
        if (!isAutomationCreateLimitError(error)) throw error;
                // Protocol errors used to enter the tool loop as plain Errors, the model treating deletion hints inside as
                // executable recovery steps and looping CronList/CronDelete/CronCreate. Map to stable domain errors so
                // core can close the turn's tool-recovery boundary without depending on shared's implementation.
        throw new AutomationCreateLimitError(
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
      const automation = toCronAutomation(result.automation);
      const title = automation.title.trim();
      if (activeSession && title.length > 0) {
        try {
                    // An in-session CronCreate creates the automation in the first reply, but the
                    // session_title sidecar may arrive late and title it from the assistant's prose ("I cannot...").
                    // Once CronCreate succeeds, pin the session title to the automation's, blocking generated overrides.
          await activeSession.app.setCustomSessionTitle({
            title,
            traceContext: activeSession.traceContext,
          });
        } catch (error) {
          context.logger?.warn("Failed to freeze session title after CronCreate", {
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "automation.session_title_freeze.failed",
            sessionId: createContext?.sessionId,
          });
        }
      }
      return automation;
    },
    async update(input) {
      const hasIntervalCarrier = input.intervalUnit !== undefined && input.interval !== undefined;
      const result = await context.requestClient(
        zcodeProtocolMethods.automationUpdate,
        {
          automationId: input.id,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.cron !== undefined ? { cronExpr: input.cron } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(hasIntervalCarrier
            ? {
                                // Legacy one-shot carriers passed through keep recurring=false and get marked completed by the
                                // repository after the first dispatch. The carrier must atomically flip to endless at the protocol boundary.
                recurring: true,
                maxRuns: null,
                intervalUnit: input.intervalUnit,
                interval: input.interval,
              }
            : {
                ...(input.recurring !== undefined ? { recurring: input.recurring } : {}),
                ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
              }),
        },
        zcodeAutomationUpdateResultSchema,
      );
      return toCronAutomation(result.automation);
    },
    async list() {
      const result = await context.requestClient(
        zcodeProtocolMethods.automationList,
        {},
        zcodeAutomationListResultSchema,
      );
      return result.automations.map(toCronAutomation);
    },
    async delete(input) {
      const result = await context.requestClient(
        zcodeProtocolMethods.automationDelete,
        { automationId: input.id },
        zcodeAutomationDeleteResultSchema,
      );
      return result.deleted;
    },
  };
}

function normalizeCronAutomationMode(
  mode: ZCodeAutomationProtocol["mode"],
): CronAutomation["mode"] {
  switch (mode) {
    case undefined:
      return undefined;
    case "plan":
    case "edit":
    case "yolo":
    case "build":
      return mode;
    case "auto":
    case "autoEdit":
      return "build";
    default: {
      const exhaustiveMode: never = mode;
      return exhaustiveMode;
    }
  }
}

function toCronAutomation(input: ZCodeAutomationProtocol): CronAutomation {
  return {
    automationId: input.automationId,
    title: input.title,
    cronExpr: input.cronExpr,
    prompt: input.prompt,
    enabled: input.enabled,
    lifecycleStatus: input.lifecycleStatus,
    nextRunAt: input.nextRunAt,
    lastRunAt: input.lastRunAt,
    runCount: input.runCount,
    recurring: input.recurring,
    maxRuns: input.maxRuns,
    modelSelection: input.modelSelection,
        // Degrade explicitly per existing session-permission semantics; future modes get forced switch handling via exhaustiveness.
    mode: normalizeCronAutomationMode(input.mode),
        // Pass the authoritative scheduleRule through; session cards need it to show intervals cron cannot express
        // (every 50 hours, every 40 days), else they infer wrong views like "at :00 every hour" from the compat cronExpr.
    scheduleRule: input.scheduleRule,
  };
}
