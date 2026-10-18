// ============================================================
// run-launched: host metadata of the run-spawning turn, as an event
// ============================================================
// The engine reads none of this metadata (anchor, phase table, alongside table, subagent model); it transcribes it verbatim once,
// right after the first run-started, in the run's birth epoch (engine.ts). A separate module keeps engine.ts and types.ts
// under the 400-line lint cap -- both grow on both sides.

import type { RunEvent } from "./types.js";

/**
  * Host metadata riding run-launched (EngineConfig.launch): the anchor inputId,
  * the script-declared phase table phaseNames, the position-aligned phaseAlongside, this run's subagent model
  * subagentModel, and the script's source file scriptPath. The engine reads none of the five -- field semantics in the
  * run-launched comment in types.ts.
 */
export interface RunLaunchConfig {
  inputId: string;
  phaseNames?: string[];
  subagentModel?: string;
    /** Absolute path of this run's script file. */
  scriptPath?: string;
  phaseAlongside?: number[][];
}

/**
  * Transcribe the launch metadata into run-launched. Unset keys are **absent**, never undefined-valued: readers
  * (AmendWorkflow's tri-state, the projections) treat unset and set-to-empty as different things.
 */
export function runLaunchedEvent(
  launch: RunLaunchConfig,
  origin: { toolCallId?: string | undefined; parentSessionId?: string | undefined },
): RunEvent {
  const { inputId, phaseNames, subagentModel, scriptPath, phaseAlongside } = launch;
  return {
    type: "run-launched",
    inputId,
    ...(origin.toolCallId === undefined ? {} : { toolCallId: origin.toolCallId }),
    ...(origin.parentSessionId === undefined ? {} : { parentSessionId: origin.parentSessionId }),
    ...(phaseNames === undefined ? {} : { phaseNames }),
    ...(subagentModel === undefined ? {} : { subagentModel }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
  };
}
