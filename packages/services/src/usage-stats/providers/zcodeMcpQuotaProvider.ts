/* Official ZCode server MCP usage read (GET /api/v1/mcp/usage).
 * One file for every detail of it: path, envelope parsing, total mapping. Auth lives elsewhere:
 * identity headers must match the server MCP endpoint's five, produced only by
 * buildOfficialMcpAuthHeaders in official-mcp/officialMcpCredentials.ts.
 * This file only consumes the injected resolver; assembling or altering headers here
 * would fork the server's WithCodingPlan reading. */
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
 * Injected official-MCP credential source.
 *
 * Inject the resolver, not resolveHeaders from createOfficialMcpAuthHeadersResolver:
 * attribution needs snapshot.providerFamily and headers carry no family (only target-type /
 * organization / project). Headers still come from the shared builder: one source.
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
   * Deliberately optional: required fields collapse into the generic schema warning, blending
   * with total breakage. A dedicated missing-total_usage branch is instantly recognizable;
   * the last incident was the server moving buckets to total_usage, failing client schema
   * while the optional quota degraded silently: the bar just vanished.
   */
  total_usage: mcpUsageTotalSchema.optional(),
});

const mcpUsageEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: mcpUsageDataSchema.optional().nullable(),
});

/** Connection attribution of this entitlement query, checked against the credential's. */
export interface McpQuotaRequestScope {
  providerFamily: "zai" | "bigmodel";
  organizationId?: string | null;
  projectId?: string | null;
}

/**
 * Whether credential attribution matches this entitlement query.
 *
 * Credentials follow the selected connection; entitlement queries run per provider tab.
 * Without the check, users holding both Z.ai and BigModel plans (or personal+team)
 * would see foreign MCP quota under the other tab.
 */
export function matchesMcpQuotaScope(
  scope: UsageMcpQuotaScope,
  request: McpQuotaRequestScope,
): boolean {
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
 * Maps the server total onto one equivalent UsageQuotaLimit, reusing existing quota bars/cards.
 *
 * percentage keeps the quota semantic (used); displays invert to remaining.
 */
export function buildMcpQuotaAggregateLimit(params: {
  totalUsage: { used: number; limit: number; remaining: number };
  nextResetTime?: number;
}): UsageQuotaLimit | null {
  const limit = Math.max(0, params.totalUsage.limit);
  if (limit <= 0) {
    // No quota: render no empty 0% bar.
    return null;
  }
  // Server floors remaining at 0; clamp the top too, since remaining>limit yields negative
  // used ratios that invert past 100%.
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
    // Leave usageDetails empty: StatusCards renders it as model names, wrong for quota.
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

/** Body truncate cap. Real responses are ~100s of bytes; this catches error pages (gateway HTML). */
const MAX_LOGGED_BODY_CHARS = 512;

/**
 * The body is log-safe: data holds only server_time/next_refresh_at/level/total_usage,
 * all non-sensitive counts, no credentials. Not logging it is why the last incident dragged:
 * the server renamed a field and clients could only say schema-mismatch.
 */
function truncateForLog(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_LOGGED_BODY_CHARS
    ? `${trimmed.slice(0, MAX_LOGGED_BODY_CHARS)}…(${trimmed.length} chars)`
    : trimmed;
}

/**
 * One quota read. Optional surface: any failure returns null with a warn,
 * never touching entitlement success/degrade semantics.
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
    // official_auth_plan_required (no plan/API-key mode) and
    // official_auth_unavailable (signed out, missing creds, selection races) skip the request.
    log.info(undefined, "Official MCP quota unavailable; skipping request", {
      reason: outcome.reason,
    });
    return null;
  }

  const scope = readScopeFromCredentialSnapshot(outcome.snapshot);
  if (!scope) {
    log.info(undefined, "Official MCP quota lacks attributable plan scope; skipping request", {
      credentialFamily: outcome.snapshot.providerFamily,
    });
    return null;
  }
  if (!matchesMcpQuotaScope(scope, params.requestScope)) {
    log.info(undefined, "Official MCP quota attribution mismatches this query; skipping request", {
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
  // One info each for request/response (not debug): prod floors at Info, so debug-only
  // means silence during incidents. TTL-tied to entitlement, single-digit calls per session: no spam.
  // Log header names only, never values: they carry JWTs and plan credentials.
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
      // Use the shared headers verbatim: no edits, no additions, no prefix changes.
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
    log.warn(undefined, "Official MCP quota request threw", {
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
    // Attach body and zod issue paths: a bare schema-mismatch hides what changed.
    log.warn(undefined, "Official MCP quota response schema mismatch", {
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
    // Business failures (1000 usage-store) clear this quota only, never throw.
    log.warn(undefined, "Official MCP quota business failure", {
      code: envelope.data.code,
      msg: envelope.data.msg ?? null,
      "x-request-id": requestId,
    });
    return null;
  }

  const data = envelope.data.data;
  if (!data.total_usage) {
    // Separate from schema mismatch: this is specifically a moved/renamed total field.
    log.warn(undefined, "Official MCP quota response missing total_usage", {
      body,
      url,
      "x-request-id": requestId,
    });
    return null;
  }
  const aggregate = buildMcpQuotaAggregateLimit({
    totalUsage: data.total_usage,
    // The API uses Unix seconds; nextResetTime is ms end to end.
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
