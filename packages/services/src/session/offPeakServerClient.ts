/* Off-peak server five-endpoint client.
   Only quota snapshot/ticket/batch status/settle JSON endpoints - model messages never route here
   (the idle plan per-turn provider connects directly inside the agent process).
   No built-in retry: queue/backoff semantics belong to callers (offPeakTaskService poll / adapters). */
import { z } from "zod";
import type { OffPeakTakeNumberAvailability } from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import {
  withRequestIdHeader,
  REQUEST_ID_HEADER_NAME,
} from "#src/providers/api/requestIdHeaders.js";
import { buildZCodeSourceHeaders } from "#src/providers/sourceHeaders.js";
import {
  buildOffPeakPlanIdentityHeaders,
  type OffPeakCredentialSnapshot,
} from "./offPeakRuntimeModel.js";

/** Server-side admission state (the server axis of the two-axis state machine). */
export const offPeakTicketStateSchema = z.enum([
  "queued",
  "ready",
  "active",
  "expired",
  "settled",
  "not_found",
]);
export type OffPeakTicketState = z.infer<typeof offPeakTicketStateSchema>;

// Response fields snake_case per server v2; lenient parsing, unknown fields never error.
// next_poll_after is implemented in seconds (same convention as Retry-After).
const takeTicketResponseSchema = z
  .object({
    ticket_id: z.string().min(1),
    task_id: z.string().optional(),
    state: offPeakTicketStateSchema,
    accepted: z.boolean().optional(),
    // The server returns a number only while queued, and explicit null once ready/active;
    // accept null and normalize to field-absent in the domain mapping, so one bad field never kills the batch sync.
    position: z.number().int().nonnegative().nullish(),
    next_poll_after: z.number().nonnegative().optional(),
    queued_at: z.number().optional(),
    ready_deadline: z.number().optional(),
  })
  .passthrough();

const ticketStatusEntrySchema = z
  .object({
    ticket_id: z.string().min(1),
    task_id: z.string().optional(),
    state: offPeakTicketStateSchema,
    position: z.number().int().nonnegative().nullish(),
    active_deadline: z.number().optional(),
  })
  .passthrough();

const batchStatusResponseSchema = z
  .object({
    next_poll_after: z.number().nonnegative().optional(),
    tickets: z.array(ticketStatusEntrySchema).default([]),
  })
  .passthrough();

const settleResponseSchema = z
  .object({
    ticket_id: z.string().min(1).optional(),
    task_id: z.string().optional(),
    state: z.string().optional(),
    settled_at: z.number().optional(),
  })
  .passthrough();

const takeNumberAvailabilityResponseSchema = z
  .object({
    can_take_number: z.boolean(),
    next_take_at: z.number().int().positive().optional(),
  })
  .passthrough();

/** Business error body (best-effort parse on non-2xx; zai gateway code/msg convention, tolerant of missing fields). */
const errorBodySchema = z
  .object({
    code: z.number().optional(),
    msg: z.string().optional(),
    message: z.string().optional(),
    next_take_at: z.number().optional(),
    data: z
      .object({ next_take_at: z.number().int().positive().optional() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export interface OffPeakTakeTicketResult {
  ticketId: string;
  state: OffPeakTicketState;
  position?: number;
  /** Next poll interval (ms; the server sends seconds, converted here). */
  nextPollAfterMs?: number;
  registeredAt: number;
}

export interface OffPeakTicketStatusEntry {
  ticketId: string;
  state: OffPeakTicketState;
  position?: number;
  activeDeadline?: number;
}

export interface OffPeakBatchStatusResult {
  nextPollAfterMs?: number;
  tickets: OffPeakTicketStatusEntry[];
}

/** Typed server error; callers branch on bizCode (3101 ineligible / 3103 ticket cap / rest). */
export class OffPeakServerError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly bizCode?: number,
    readonly nextTakeAt?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "OffPeakServerError";
  }
}

interface OffPeakServerClientDeps {
  /** API origin (real server or mock gateway; the ZCODE_OFFPEAK_MOCK switch lives in assembly); lazy gateway start allows a promise. */
  resolveOrigin: () => string | Promise<string>;
  /** Credential snapshot: all four ticket endpoints carry the same selected credential snapshot. */
  resolveCredentials: () => Promise<OffPeakCredentialSnapshot>;
  fetchImpl?: typeof fetch;
  logger: ServiceLogger;
}

const REQUEST_TIMEOUT_MS = 10_000;

export interface OffPeakServerClient {
  getTakeNumberAvailability(): Promise<OffPeakTakeNumberAvailability>;
  takeTicket(taskId: string): Promise<OffPeakTakeTicketResult>;
  batchStatus(ticketIds: string[]): Promise<OffPeakBatchStatusResult>;
  settle(ticketId: string): Promise<void>;
}

export function createOffPeakServerClient(deps: OffPeakServerClientDeps): OffPeakServerClient {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const credentials = await deps.resolveCredentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const origin = await deps.resolveOrigin();
      // This client uses fetch directly, historically bypassing NodeApiClient source headers and request ids;
      // the test server saw only user_agent=node and client logs could not correlate 2007/bare-429 server requests.
      // Add only standard non-sensitive origin headers and trace ids; JWT/API keys never enter logs.
      const headers = withRequestIdHeader({
        ...buildZCodeSourceHeaders(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        authorization: `Bearer ${credentials.jwt}`,
        "x-coding-plan-api-key": credentials.codingPlanApiKey,
        ...buildOffPeakPlanIdentityHeaders(credentials),
      });
      const response = await fetchImpl(`${origin}/api/v1/off-peak${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      const json: unknown = text ? safeJsonParse(text) : {};
      if (!response.ok) {
        const parsed = errorBodySchema.safeParse(json);
        const errorBody = parsed.success ? parsed.data : {};
        const requestId =
          response.headers.get(REQUEST_ID_HEADER_NAME)?.trim() ||
          headers.get(REQUEST_ID_HEADER_NAME)?.trim() ||
          undefined;
        // Recoverable server rejections warn; log contract metadata only, never credential values/fingerprints/bodies.
        deps.logger.warn(undefined, "off-peak request rejected", {
          bizCode: errorBody.code,
          credentialKind: credentials.kind,
          httpStatus: response.status,
          method,
          path,
          requestId,
        });
        throw new OffPeakServerError(
          `off-peak ${path} failed: HTTP ${response.status}${errorBody.code ? ` code=${errorBody.code}` : ""}${(errorBody.msg ?? errorBody.message) ? ` ${errorBody.msg ?? errorBody.message}` : ""}`,
          response.status,
          errorBody.code,
          errorBody.next_take_at ?? errorBody.data?.next_take_at,
          requestId,
        );
      }
      // Compat both bare bodies and the {code:0,data} envelope (v2 docs bare; gateways may wrap).
      if (
        json &&
        typeof json === "object" &&
        "data" in json &&
        (json as { code?: number }).code === 0
      ) {
        return (json as { data: unknown }).data;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getTakeNumberAvailability() {
      const raw = await request("GET", "/ticket/availability");
      const parsed = takeNumberAvailabilityResponseSchema.parse(raw);
      // A false snapshot without retry time leaves the UI unable to schedule rechecks, a permanent gray state.
      // The contract requires false to carry next_take_at; dirty responses count as query failure - UI fails open, POST /ticket as backstop.
      if (!parsed.can_take_number && parsed.next_take_at === undefined) {
        throw new Error("off-peak availability missing next_take_at while unavailable");
      }
      return {
        canTakeNumber: parsed.can_take_number,
        ...(parsed.next_take_at !== undefined ? { nextTakeAt: parsed.next_take_at } : {}),
      };
    },
    async takeTicket(taskId) {
      const raw = await request("POST", "/ticket", { task_id: taskId });
      const parsed = takeTicketResponseSchema.parse(raw);
      deps.logger.info(
        undefined,
        `off-peak take ticket ok task=${taskId} ticket=${parsed.ticket_id} state=${parsed.state} position=${parsed.position ?? "-"}`,
      );
      return {
        ticketId: parsed.ticket_id,
        state: parsed.state,
        ...(parsed.position != null ? { position: parsed.position } : {}),
        ...(parsed.next_poll_after !== undefined
          ? { nextPollAfterMs: parsed.next_poll_after * 1000 }
          : {}),
        registeredAt: Date.now(),
      };
    },
    async batchStatus(ticketIds) {
      if (ticketIds.length === 0) return { tickets: [] };
      // Contract cap <=100; listNonTerminal is far smaller, so truncate+warn beyond it, never split requests.
      // Long before 100 non-terminal tasks per user, the server ticket cap kicks in first.
      const limited = ticketIds.slice(0, 100);
      if (limited.length < ticketIds.length) {
        deps.logger.warn(`off-peak batch status truncated ${ticketIds.length} -> 100`);
      }
      const raw = await request("POST", "/ticket/status", {
        ticket_ids: limited,
      });
      const parsed = batchStatusResponseSchema.parse(raw);
      return {
        ...(parsed.next_poll_after !== undefined
          ? { nextPollAfterMs: parsed.next_poll_after * 1000 }
          : {}),
        tickets: parsed.tickets.map((entry) => ({
          ticketId: entry.ticket_id,
          state: entry.state,
          ...(entry.position != null ? { position: entry.position } : {}),
          ...(entry.active_deadline !== undefined ? { activeDeadline: entry.active_deadline } : {}),
        })),
      };
    },
    async settle(ticketId) {
      // Idempotent: repeated reports/unknown tickets all 2xx; no body.
      const raw = await request("POST", `/ticket/${encodeURIComponent(ticketId)}/settle`);
      settleResponseSchema.parse(raw);
      deps.logger.info(undefined, `off-peak settle acked ticket=${ticketId}`);
    },
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
