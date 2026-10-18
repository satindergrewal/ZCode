/* Usage quota reader for the official ZCode server MCP (`GET /api/v1/mcp/usage`).
 *
 * This single file owns every detail of the endpoint: path, envelope parsing and total-quota
 * mapping. **Auth is not implemented here** - the identity headers must be the same 5 headers used
 * by the server MCP endpoint, whose only producer is buildOfficialMcpAuthHeaders in
 * `official-mcp/officialMcpCredentials.ts`. This module only receives the injected credential
 * resolver and never assembles, augments or re-prefixes headers itself, otherwise its reading
 * would diverge from the server-side WithCodingPlan path.
 */
import { z } from "zod";
import {
  MCP_USAGE_QUOTA_LIMIT_TYPE,
  buildRuntimeZCodeApiUrl,
  type ApiClient,
  type UsageMcpQuotaScope,
  type UsageMcpQuotaSnapshot,
  type UsageQuotaLimit,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  buildOfficialMcpAuthHeaders,
  type OfficialMcpCredentialOutcome,
} from "#src/official-mcp/officialMcpCredentials.js";

const MCP_USAGE_PATH = "/api/v1/mcp/usage";
const REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("usage-stats");

/**
 * Injected official MCP credential source.
 *
 * The injection is the **credential resolver**, not createOfficialMcpAuthHeadersResolver's
 * resolveHeaders: ownership validation needs snapshot.providerFamily, which the identity headers
 * do not carry (only target-type / organization / project). The headers themselves are still built
 * by the shared buildOfficialMcpAuthHeaders, keeping a single source.
 */
export interface OfficialMcpCredentialSource {
  resolve(): Promise<OfficialMcpCredentialOutcome>;
}

const mcpUsageTotalSchema = z.object({
  used: z.number().finite(),
  limit: z.number().finite(),
  remaining: z.number().finite(),
});

const mcpUsageDataSchema = z.object({
  server_time: z.number().finite(),
  next_refresh_at: z.number().finite().optional(),
  level: z.string().optional(),
  /**
   * Server-aggregated total quota.
   *
   * Deliberately optional instead of required: when required, a missing field falls into the
   * generic "unexpected shape" warning and gets mixed with "everything is broken". A dedicated
   * branch logs one clear "response missing total_usage" record, instantly recognizable when the
   * API changes again - this line exists precisely because of the last incident: the server switched
   * the response from a `buckets` array to total_usage, client schema validation failed, and since
   * mcpQuota is an optional data plane (silent degradation on failure) the quota bar just
   * disappeared without a trace.
   */
  total_usage: mcpUsageTotalSchema.optional(),
});

const mcpUsageEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: mcpUsageDataSchema.optional().nullable(),
});

/** Connection ownership of this entitlement query, compared against the credential ownership. */
interface McpQuotaRequestScope {
  providerFamily: "zai" | "bigmodel";
  organizationId?: string | null;
  projectId?: string | null;
}

/**
 * Whether the credential ownership matches this entitlement query.
 *
 * Credentials come from the connection currently selected in settings, while entitlements are
 * queried per provider tab in the panel. A user holding both a Z.ai and a BigModel Coding Plan
 * (or Personal + Team) would otherwise see MCP quota that belongs to the other tab.
 */
function matchesMcpQuotaScope(scope: UsageMcpQuotaScope, request: McpQuotaRequestScope): boolean {
  if (scope.providerFamily !== request.providerFamily) {
    return false;
  }
  const requestOrganizationId = request.organizationId?.trim() ?? "";
  const requestProjectId = request.projectId?.trim() ?? "";
  const requestIsTeam = Boolean(requestOrganizationId && requestProjectId);
  if (!requestIsTeam) {
    return scope.targetType === "PERSONAL";
  }
  if (scope.targetType !== "TEAM") return false;
  return (
    (scope.organizationId?.trim() ?? "") === requestOrganizationId &&
    (scope.projectId?.trim() ?? "") === requestProjectId
  );
}

/**
 * Map the server-aggregated total quota onto one equivalent UsageQuotaLimit, reusing the existing
 * quota bar / quota card presentation as-is.
 *
 * percentage keeps the quota API semantic (**used** ratio); the presentation layer inverts it
 * into remaining.
 */
function buildMcpQuotaAggregateLimit(params: {
  totalUsage: { used: number; limit: number; remaining: number };
  nextResetTime?: number;
}): UsageQuotaLimit | null {
  const limit = Math.max(0, params.totalUsage.limit);
  if (limit <= 0) {
    // No usable quota: do not render an empty 0% bar.
    return null;
  }
  // The server already floors remaining at 0; clamp the upper bound again here: anomalous data
  // (remaining > limit) would produce a negative used ratio and push the inverted display past 100%.
  const remaining = Math.min(Math.max(0, params.totalUsage.remaining), limit);
  const used = Math.max(0, params.totalUsage.used);

  const usedPercentage = Math.max(0, Math.min(100, 100 - (remaining / limit) * 100));
  return {
    type: MCP_USAGE_QUOTA_LIMIT_TYPE,
    currentValue: used,
    usage: used,
    remaining,
    percentage: usedPercentage,
    ...(params.nextResetTime === undefined ? {} : { nextResetTime: params.nextResetTime }),
    // usageDetails stays empty: StatusCards renders that field as a model name, which does not fit
    // the quota dimension.
    usageDetails: [],
  };
}

function readScopeFromCredentialSnapshot(
  snapshot: Extract<OfficialMcpCredentialOutcome, { ok: true }>["snapshot"],
): UsageMcpQuotaScope | null {
  const scope = snapshot.planScope;
  if (!scope) return null;
  return scope.targetType === "TEAM"
    ? {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        providerFamily: snapshot.providerFamily,
        targetType: "TEAM",
      }
    : { providerFamily: snapshot.providerFamily, targetType: "PERSONAL" };
}

function readRequestId(headers: Headers): string | null {
  return headers.get("x-request-id")?.trim() || null;
}

/** Response body truncation length. A normal response is a couple hundred bytes; truncation only guards error pages (e.g. gateway HTML). */
const MAX_LOGGED_BODY_CHARS = 512;

/**
 * The response body is safe to log verbatim: this endpoint's data holds only server_time /
 * next_refresh_at / level / total_usage - non-sensitive counters, **no credentials**. Conversely,
 * not logging it is exactly why the last incident took long to debug: the server renamed a field
 * and the client only said "unexpected shape", with no record of what actually arrived.
 */
function truncateForLog(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_LOGGED_BODY_CHARS
    ? `${trimmed.slice(0, MAX_LOGGED_BODY_CHARS)}…(${trimmed.length} chars)`
    : trimmed;
}

/**
 * Read the MCP quota once. Optional data plane: any failure returns null with a warn log and
 * never affects the success/degradation semantics of the entitlement snapshot itself.
 */
export async function fetchMcpQuotaSnapshot(params: {
  apiClient: ApiClient;
  credentialSource: OfficialMcpCredentialSource;
  env: NodeJS.ProcessEnv;
  requestScope: McpQuotaRequestScope;
}): Promise<UsageMcpQuotaSnapshot | null> {
  let outcome: OfficialMcpCredentialOutcome;
  try {
    outcome = await params.credentialSource.resolve();
  } catch (error) {
    log.warn(undefined, "Failed to resolve official MCP quota credentials; skipping quota", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!outcome.ok) {
    // official_auth_plan_required (no Coding Plan / Start Plan / API Key mode) and
    // official_auth_unavailable (logged out, missing credentials, selection race) send no request.
    log.info(undefined, "Official MCP quota unavailable; skipping request", {
      reason: outcome.reason,
    });
    return null;
  }

  const scope = readScopeFromCredentialSnapshot(outcome.snapshot);
  if (!scope) {
    log.info(
      undefined,
      "Official MCP quota has no precisely attributable plan scope; skipping request",
      {
        credentialFamily: outcome.snapshot.providerFamily,
      },
    );
    return null;
  }
  if (!matchesMcpQuotaScope(scope, params.requestScope)) {
    log.info(undefined, "Official MCP quota ownership mismatch for this query; skipping request", {
      credentialFamily: scope.providerFamily,
      credentialTargetType: scope.targetType ?? null,
      requestFamily: params.requestScope.providerFamily,
      requestOrganizationId: params.requestScope.organizationId ?? null,
      requestProjectId: params.requestScope.projectId ?? null,
    });
    return null;
  }

  const url = buildRuntimeZCodeApiUrl(params.env, MCP_USAGE_PATH);
  const headers = buildOfficialMcpAuthHeaders(outcome.snapshot);
  let payload: unknown;
  let requestId: string | null = null;
  let body = "";
  // Log one info each for request and response (not debug): the production minimum level is Info,
  // debug-only logging means seeing nothing when it breaks. This endpoint fires on the entitlement
  // TTL cache, a handful of times per session - no log flooding. Log header **names** only, never
  // values - they carry the JWT and Coding Plan credentials.
  log.info(undefined, "Official MCP quota request", {
    credentialFamily: scope.providerFamily,
    credentialTargetType: scope.targetType ?? null,
    headerNames: Object.keys(headers).sort(),
    method: "GET",
    timeoutMs: REQUEST_TIMEOUT_MS,
    url,
  });
  const startedAt = Date.now();
  try {
    const response = await params.apiClient.request(url, {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      // Use the shared header builder result verbatim: all 5 headers unchanged, none added, no re-prefix.
      headers,
    });
    requestId = readRequestId(response.headers);
    const text = await response.text();
    body = truncateForLog(text);
    log.info(undefined, "Official MCP quota response", {
      body,
      durationMs: Date.now() - startedAt,
      status: response.status,
      url,
      "x-request-id": requestId,
    });
    if (!response.ok) {
      log.warn(undefined, "Official MCP quota request failed", {
        body,
        status: response.status,
        url,
        "x-request-id": requestId,
      });
      return null;
    }
    payload = JSON.parse(text) as unknown;
  } catch (error) {
    log.warn(undefined, "Official MCP quota request error", {
      body,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      url,
      "x-request-id": requestId,
    });
    return null;
  }

  const envelope = mcpUsageEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    // Include the body and zod issue paths: with only "unexpected shape" you cannot tell which
    // field the server changed.
    log.warn(undefined, "Unexpected official MCP quota response shape", {
      body,
      issues: envelope.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`,
      ),
      url,
      "x-request-id": requestId,
    });
    return null;
  }
  if (envelope.data.code !== 0 || !envelope.data.data) {
    // Business failure (e.g. 1000 usage-storage error) only clears this quota, never throws.
    log.warn(undefined, "Official MCP quota business failure", {
      code: envelope.data.code,
      msg: envelope.data.msg ?? null,
      "x-request-id": requestId,
    });
    return null;
  }

  const data = envelope.data.data;
  if (!data.total_usage) {
    // Logged separately from "unexpected shape": this entry specifically means the API moved or
    // renamed the total-quota field.
    log.warn(undefined, "Official MCP quota response missing total_usage", {
      body,
      url,
      "x-request-id": requestId,
    });
    return null;
  }
  const aggregate = buildMcpQuotaAggregateLimit({
    totalUsage: data.total_usage,
    // The API uses Unix seconds; client nextResetTime is milliseconds end to end.
    ...(data.next_refresh_at === undefined ? {} : { nextResetTime: data.next_refresh_at * 1000 }),
  });
  if (!aggregate) {
    return null;
  }

  return {
    aggregate,
    level: data.level?.trim() || null,
    scope,
    serverTime: data.server_time * 1000,
  };
}
