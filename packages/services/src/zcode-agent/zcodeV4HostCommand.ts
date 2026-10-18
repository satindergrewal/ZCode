// Host (services) side of v4 command envelopes and ACK settlement (send/interaction receipt convergence).
//
// Parallel to the renderer's packages/ui/src/v4/commandFactory.ts: the renderer persists clientId in
// browser localStorage while the host process uses a stable in-process id (host restart = new submitter,
// idempotency keyed by commandId unaffected). Not merged: services must not depend back on the ui package.
import { randomBytes } from "node:crypto";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  type CommandAck,
  type CommandEnvelope,
  type CommandPayloadMap,
  type CommandType,
} from "@zcode/shared/zcode-protocol-v4";

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** uuid v7 (RFC 9562): 48-bit Unix ms + 74 random bits; mirrors the renderer factory. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  let hex = "";
  for (const byte of bytes) hex += HEX[byte];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable host-services clientId; pendingCommands display and idempotency key submitters by it. */
const hostV4ClientId = `host-services-${uuidv7()}`;

export function getHostV4ClientId(): string {
  return hostV4ClientId;
}

export interface CreateHostCommandEnvelopeInput<T extends CommandType> {
  type: T;
  payload: CommandPayloadMap[T];
  /** Null for createSession. */
  sessionId: string | null;
  /**
   * Idempotency key. Phone-replayable send_prompt uses inputId (=traceId) as commandId so the CLI
   * sendText starts the turn with commandId=inputId and terminal events reconcile against the
   * host command queue's traceId (inputId aligned to commandId).
   * Defaults to a fresh uuid v7 (one-shot commands like stop/resolveInteraction).
   */
  commandId?: string;
  /** Phone-replayable keeps the original submitter clientId; default is the stable host id. */
  clientId?: string;
  baseRevision?: number;
  baseLogEpoch?: string;
}

/** Builds the host-side envelope; CAS commands without baseRevision throw here. */
export function createHostCommandEnvelope<T extends CommandType>(
  input: CreateHostCommandEnvelopeInput<T>,
): CommandEnvelope {
  if (COMMANDS_REQUIRING_BASE_REVISION.has(input.type) && input.baseRevision === undefined) {
    throw new Error(
      `command ${input.type} is CAS and requires baseRevision (10-protocol-spec section 6.4)`,
    );
  }
  if (ROW_TARGETING_COMMANDS.has(input.type) && !input.baseLogEpoch) {
    throw new Error(`command ${input.type} targets a row and requires baseLogEpoch`);
  }
  return {
    commandId: input.commandId ?? uuidv7(),
    clientId: input.clientId ?? hostV4ClientId,
    sessionId: input.sessionId,
    ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
    ...(input.baseLogEpoch ? { baseLogEpoch: input.baseLogEpoch } : {}),
    type: input.type,
    payload: input.payload,
    issuedAt: Date.now(),
  };
}

/** Server-rejected v4 command (rejected/stale/failed). code is for structured branching, never message matching. */
export class ZCodeV4CommandRejectedError extends Error {
  readonly code = "ZCODE_V4_COMMAND_REJECTED";

  constructor(
    readonly commandType: CommandType,
    readonly ack: CommandAck,
    contextMessage: string,
  ) {
    super(
      `v4 command ${commandType} ${ack.status}` +
        `${ack.reasonCode ? ` (${ack.reasonCode})` : ""}` +
        `${ack.message ? `: ${ack.message}` : ""} — ${contextMessage}`,
    );
    this.name = "ZCodeV4CommandRejectedError";
  }
}

/**
 * ACK error mapping (legacy op-throw semantics onto the six v4 states):
 * - accepted: settled; duplicate: replay of the same commandId, idempotent success;
 * - noop: late/already-settled answer, idempotent success (resolveInteraction first-wins);
 * - rejected/stale/failed: throw structured, passing reasonCode through to the caller.
 */
export function assertV4CommandAckOk(
  commandType: CommandType,
  ack: CommandAck,
  contextMessage: string,
): CommandAck {
  if (ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop") {
    return ack;
  }
  throw new ZCodeV4CommandRejectedError(commandType, ack, contextMessage);
}

/**
 * Host-side CAS commits (config writes sunk here): host services hold no local v4 projection,
 * so the current conversation revision is unreadable. The stale-ACK-carries-revisionAtDecision rule
 * is honored by retrying from the server-reported revision, mirroring the renderer's dispatchConfigCas
 * (packages/ui/src/v4/SessionPane.tsx). The first send probes with baseRevision=0; the common path hits
 * after one stale. Each attempt gets a fresh commandId (stale verdicts skip the idempotency table: equivalent and unambiguous).
 * Legacy facades never send expectedRevision (no CAS), so stale means concurrent progress, not conflict,
 * and retrying preserves the no-CAS-commit semantics; exhaustion only happens under pathological concurrency and throws.
 */
export async function sendHostCasCommandV4<T extends CommandType>(input: {
  send: (envelope: CommandEnvelope) => Promise<CommandAck>;
  type: T;
  payload: CommandPayloadMap[T];
  sessionId: string;
  contextMessage: string;
  maxAttempts?: number;
}): Promise<CommandAck> {
  const maxAttempts = input.maxAttempts ?? 4;
  let baseRevision = 0;
  let lastAck: CommandAck | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ack = await input.send(
      createHostCommandEnvelope({
        type: input.type,
        payload: input.payload,
        sessionId: input.sessionId,
        baseRevision,
      }),
    );
    if (ack.status === "stale") {
      lastAck = ack;
      baseRevision = ack.revisionAtDecision;
      continue;
    }
    return assertV4CommandAckOk(input.type, ack, input.contextMessage);
  }
  throw new ZCodeV4CommandRejectedError(
    input.type,
    lastAck ?? {
      commandId: "",
      status: "stale",
      revisionAtDecision: baseRevision,
    },
    `${input.contextMessage} (stale repeatedly; giving up retries)`,
  );
}
