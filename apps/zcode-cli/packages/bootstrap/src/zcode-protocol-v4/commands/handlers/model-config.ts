// Model config commands: switchModelConfig (semantics carried from legacy server-operations.switchModelConfig)
// + switchCollaborationMode (additive, the UI mode picker)
// + applyRequestedSessionConfig (the shared consumer of createSession.config).
// One file per command group: handlers are pure (host, envelope) -> CommandResult|undefined,
// decision logic drives core directly (app.setModel / app.setMode / runtime.emit*), never legacy protocol ops.
import type { CollaborationMode, ModelSelection } from "@zcode/contracts";
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { runSessionModelConfigMutation } from "../../model-config-mutation.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";

/** The noop reasonCode for same-value switches. */
const CONFIG_UNCHANGED = "config.unchanged";

/**
 * The target Provider is not in the current Environment Registry. The gateway maps it to a failed ACK;
 * callers must refresh the Environment's Provider Config, not re-push the Host Snapshot to the Worker.
 */
class V4ProviderNotInRegistryError extends Error {
  readonly reasonCode = "provider.notInRegistry";
  constructor(providerId: string) {
    super(`provider "${providerId}" is not in the workspace model registry`);
  }
}

/**
 * Before switching models, confirm the target Provider exists in the current Environment Registry. `applied:false` becomes
 * a structured domain error (gateway -> failed ACK). Without the injected capability, keep the legacy Entry behavior.
 */
async function ensureProviderClientReady(
  host: V4CommandCoreHost,
  sessionId: string,
  providerId: string,
): Promise<void> {
  if (!host.ensureProviderAvailable) return;
  const outcome = await host.ensureProviderAvailable(sessionId, providerId);
  if (!outcome.available && outcome.reason === "provider_not_in_registry") {
    throw new V4ProviderNotInRegistryError(providerId);
  }
  // session_not_found and the rest: requireRecord already validated handler-side; unreachable in theory.
  // The fallback does not throw (later setModel keeps its own path/error) -- never swallow the real cause.
}

function createModelSelection(provider: string, model: string, thought: string | undefined) {
  return {
    providerId: provider,
    modelId: model,
    ...(thought ? { options: { reasoningLevel: thought } } : {}),
  };
}

function readActualThought(
  record: V4SessionRecordView,
  fallbackSelection?: ModelSelection,
): string {
  const thought = record.app.getThoughtLevel();
  if (thought !== undefined) return thought;
  return fallbackSelection?.options?.reasoningLevel ?? "";
}

/** switchCollaborationMode's command value domain (same source as command.ts z.enum; auto is not user-switchable, excluded). */
const SWITCHABLE_MODES: ReadonlySet<string> = new Set(["build", "edit", "plan", "yolo", "guarded"]);

/**
 * switchModelConfig: switches the session's model selection. Across models, app.setModel swaps provider client + model;
 * same model means thought is the explicit thinking-depth switch; ModelSelected is then emitted -- the v4 projection's config section
 * and the mid-flight modelChange marker both feed on that event (reducer onModelSelected).
 *
 * Behavior note: the legacy path had no active-turn guard (switching while running allowed); kept identical here, nothing added.
 */
async function switchModelConfig(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["switchModelConfig"];
  const record = requireRecord(host, envelope.sessionId);
  return runSessionModelConfigMutation(record.app, async () => {
    // `previous` must be snapshotted inside the serialized critical section, before setModel. The registry fallback may be queued
    // ahead of this command; reading before queueing yields a stale previous and splits noop/event order from runtime truth.
    const previousSelection = record.app.runtime.getSessionModelSelection();
    const previousModelSelection =
      previousSelection &&
      createModelSelection(
        previousSelection.providerId,
        previousSelection.modelId,
        previousSelection.options?.reasoningLevel,
      );
    const previousThought = readActualThought(record, previousSelection);
    const modelIdentityChanged =
      previousSelection?.providerId !== payload.provider ||
      previousSelection?.modelId !== payload.model;
    const requestedThought = payload.thought.trim();
    const thoughtChanged =
      Boolean(requestedThought) && requestedThought !== previousSelection?.options?.reasoningLevel;
    // Same-value switches close here: matching the runtime's current value -> noop ACK (config.unchanged),
    // never silently accepted -- once seeded, "UI display = runtime truth" holds,
    // letting clients distinguish "took effect" from "was already that value".
    if (!modelIdentityChanged && !thoughtChanged) {
      throw new V4CommandNoopError(CONFIG_UNCHANGED);
    }
    // The current Environment Registry confirms the target Provider before setModel.
    await ensureProviderClientReady(host, record.app.sessionId, payload.provider);
    let actualThought = previousThought;
    let nextModelSelection: ModelSelection;
    if (modelIdentityChanged) {
      const result = await record.app.setModel(`${payload.provider}/${payload.model}`);
      actualThought = result.thoughtLevel ?? readActualThought(record);
      if (requestedThought && record.app.listThoughtLevels().includes(requestedThought)) {
        // Even a tier explicitly equal to the default is a pin. Call the setter so
        // Session Selection stores the explicit leaf; never swallow the intent because the effective value matches.
        const thoughtResult = await record.app.setThoughtLevel(requestedThought);
        actualThought = thoughtResult.thoughtLevel;
      }
      nextModelSelection = createModelSelection(
        payload.provider,
        payload.model,
        requestedThought && record.app.listThoughtLevels().includes(requestedThought)
          ? requestedThought
          : undefined,
      );
    } else {
      // Same provider/model is what makes it an explicit thought switch; invalid values fail before any model change.
      const result = await record.app.setThoughtLevel(requestedThought);
      actualThought = result.thoughtLevel;
      nextModelSelection = createModelSelection(payload.provider, payload.model, actualThought);
    }
    await record.app.runtime.emitModelSelected({
      modelSelection: nextModelSelection,
      ...(actualThought ? { effectiveReasoningLevel: actualThought } : {}),
      previousModelSelection,
      supportedThoughtLevels: record.app.listThoughtLevels(),
      // The trace chain structure passes through from the record (session-root trace); no unrelated traceId at the command layer.
      traceContext: record.traceContext,
    });
    return undefined;
  });
}

/**
 * switchCollaborationMode: switches the agent collaboration mode (plan/build/edit/yolo).
 * app.setMode updates the standalone execution state, persists, and emits SessionModeChanged;
 * the command layer emits no second event,
 * and the v4 projection reducer onSessionModeChanged updates config.mode from it.
 * Same-value -> noop ACK: a silent undefined return reads as accepted; with the projection seed missing
 * it stacks into the visible "clicked full-access, nothing happened" -- the CLI believes yolo already
 * and returns early while the projection stays at seed build, indistinguishable client-side. Hence an explicit ACK.
 */
async function switchCollaborationMode(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["switchCollaborationMode"];
  const record = requireRecord(host, envelope.sessionId);
  const mode = payload.mode as CollaborationMode;
  const previousMode = record.app.getMode();
  if (previousMode === mode && !record.app.runtime.getPlanEnabled()) {
    throw new V4CommandNoopError(CONFIG_UNCHANGED);
  }
  await record.app.setMode(mode);
  return undefined;
}

/**
 * The shared consumer of createSession.config ("createSession.config must be consumed"):
 * merges as "requested config over runtime defaults", applying only parts differing from the runtime's current values,
 * and emits the same events as the switch commands (ModelSelected / SessionModeChanged) -- self-sufficient logs,
 * projection closed via the existing reducers, no second write path.
 *
 * Why events instead of editing the seed: the publisher exists before createSessionRecord's event wiring,
 * and the seed reads the runtime defaults prior to the requested config; the emitted events fix the projection and
 * put "which model the first send uses" into the log (cold-restore replay can reconstruct it). On a first-ever selection prev is empty,
 * so the reducer emits no modelChange marker (onModelSelected: first selection is not a switch) -- no noise row.
 *
 * Partial-failure semantics: the session exists; a config-apply failure must not fail createSession (leaking
 * the record for one failed ACK is not worth it) -- callers catch, degrade to warn, and the session keeps runtime defaults.
 */
export async function applyRequestedSessionConfig(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  config: NonNullable<CommandPayloadMap["createSession"]["config"]>,
): Promise<void> {
  await runSessionModelConfigMutation(record.app, async () => {
    const previousSelection = record.app.runtime.getSessionModelSelection();
    const previousModelSelection =
      previousSelection &&
      createModelSelection(
        previousSelection.providerId,
        previousSelection.modelId,
        previousSelection.options?.reasoningLevel,
      );
    const previousThought = readActualThought(record, previousSelection);
    const requestedSelection = config.modelSelection;
    const targetProvider =
      requestedSelection?.providerId ?? config.provider?.trim() ?? previousSelection?.providerId;
    const targetModel =
      requestedSelection?.modelId ?? config.model?.trim() ?? previousSelection?.modelId;
    const targetThought =
      requestedSelection?.options?.reasoningLevel ?? config.thought?.trim() ?? "";
    const modelIdentityChanged =
      targetProvider !== previousSelection?.providerId ||
      targetModel !== previousSelection?.modelId;
    const thoughtChanged =
      Boolean(targetThought) &&
      targetThought !==
        (requestedSelection ? previousSelection?.options?.reasoningLevel : previousThought);
    if (targetProvider && targetModel && (modelIdentityChanged || thoughtChanged)) {
      // A first-send Provider missing from the Registry throws provider.notInRegistry; createSession catches and degrades to
      // warn (session keeps runtime defaults, creation unaffected) -- the same semantics as any config-apply failure.
      await ensureProviderClientReady(host, record.app.sessionId, targetProvider);
      let actualThought = previousThought;
      if (modelIdentityChanged) {
        const result = await record.app.setModel(`${targetProvider}/${targetModel}`);
        actualThought = result.thoughtLevel ?? readActualThought(record);
      }
      if (targetThought && record.app.listThoughtLevels().includes(targetThought)) {
        const result = await record.app.setThoughtLevel(targetThought);
        actualThought = result.thoughtLevel;
      } else if (requestedSelection?.options?.reasoningLevel) {
        // Explicit options on formal structured Selections fail closed; only legacy flat config
        // keeps the published "fall back to default when unsupported" compat behavior.
        await record.app.setThoughtLevel(targetThought);
      }
      if (modelIdentityChanged || actualThought !== previousThought) {
        // Draft-warmup config may carry the previous model's thought. When the target lacks it, keep
        // the compat tier setModel resolved, still emitting the target-model event, avoiding a runtime/projection-split session.
        await record.app.runtime.emitModelSelected({
          modelSelection: createModelSelection(
            targetProvider,
            targetModel,
            targetThought && record.app.listThoughtLevels().includes(targetThought)
              ? targetThought
              : undefined,
          ),
          ...(actualThought ? { effectiveReasoningLevel: actualThought } : {}),
          previousModelSelection,
          supportedThoughtLevels: record.app.listThoughtLevels(),
          traceContext: record.traceContext,
        });
      }
    }
  });

  // mode: payload.config.mode is a wide string (schema-default compat); the value domain closes here.
  const mode = config.mode;
  if ((mode && SWITCHABLE_MODES.has(mode)) || config.planEnabled !== undefined) {
    await record.app.runtime.setExecutionState(
      {
        ...(mode && SWITCHABLE_MODES.has(mode) ? { mode } : {}),
        ...(config.planEnabled !== undefined ? { planEnabled: config.planEnabled } : {}),
      },
      record.traceContext,
    );
  }

  // followupMode: the runtime default is queue (projection initial likewise); only non-default values write explicitly --
  // runtime.setFollowupMode has no same-value guard (emits unconditionally), so an explicit "queue" would emit an idle delta.
  if (config.followupMode && config.followupMode !== "queue") {
    await record.app.setFollowupMode(config.followupMode);
  }
}

export const modelConfigHandlers = { switchModelConfig, switchCollaborationMode };
