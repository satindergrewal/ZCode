// Host (services) side builder/ACK sink for v4 command envelopes (send/interaction receipts).
//
// Mirrors packages/ui/src/v4/commandFactory.ts: the renderer persists its clientId in
// localStorage while the host process uses a stable in-process id (host restart = new submitter,
// harmless to the commandId-keyed idempotency table). Not merged: ui must not be a services dep.
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

/** uuid v7 (RFC 9562): 48-bit Unix ms timestamp + 74 random bits; mirrors the renderer factory. */
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

/** Stable host-services clientId; pendingCommands display and the idempotency table key on it. */
const hostV4ClientId = `host-services-${uuidv7()}`;

interface CreateHostCommandEnvelopeInput<T extends CommandType> {
  type: T;
  payload: CommandPayloadMap[T];
  /** Null at createSession. */
  sessionId: string | null;
  /**
   * Idempotency key. Phone-replayable send_prompt uses inputId (=traceId) as commandId:
   // the CLI starts the turn keyed by commandId=inputId so the terminal event's inputId
   // reconciles with the host command queue's traceId (inputId->commandId alignment).
   * Defaults to a fresh uuid v7 (one-shot commands like stop/resolveInteraction).
   */
  commandId?: string;
  /** Phone replayable keeps the original submitter clientId; default is the stable host id. */
  clientId?: string;
  baseRevision?: number;
  baseLogEpoch?: string;
}

/** Builds the host-side command envelope; CAS commands throw inline without baseRevision. */
export function createHostCommandEnvelope<T extends CommandType>(
  input: CreateHostCommandEnvelopeInput<T>,
): CommandEnvelope {
  if (COMMANDS_REQUIRING_BASE_REVISION.has(input.type) && input.baseRevision === undefined) {
    throw new Error(`command ${input.type} is a CAS command and requires baseRevision`);
  }
  if (ROW_TARGETING_COMMANDS.has(input.type) && !input.baseLogEpoch) {
    throw new Error(`command ${input.type} is a row-target command and requires baseLogEpoch`);
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

/** A v4 command was rejected server-side (rejected/stale/failed); code routes structurally. */
class ZCodeV4CommandRejectedError extends Error {
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
 * ACK error mapping (legacy op throw semantics -> the six v4 states):
 * - accepted: normal; duplicate: replayed retry, idempotent success;
 * - noop: late answer/already settled, idempotent success (first resolveInteraction wins);
 * - rejected/stale/failed: throw structured errors with reasonCode passed through.
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
 * Host-side CAS commit (config writes). Host services keep no local v4 projection and cannot
 // know the current conversation revision, so on stale ACK (always carrying revisionAtDecision)
 // retry converges on the server-reported revision, mirroring the renderer's dispatchConfigCas
 // (packages/ui/src/v4/SessionPane.tsx). The first attempt probes with baseRevision=0 and
 // typically succeeds after one stale; every attempt uses a fresh commandId (stale verdicts stay
 // out of the idempotency table). Legacy facades never send expectedRevision, so stale means
 // concurrent progress, not conflict; retrying preserves no-CAS semantics. Exhaustion is pathological.
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
    `${input.contextMessage} (stale repeatedly; giving up on retries)`,
  );
}
