import type { ApiClient } from "@zcode/shared";
import { z } from "zod";
import { readApiJson } from "#src/providers/api/apiJson.js";
import type { BigModelTeamPlanBizContext } from "#src/bigmodel/teamPlanApiKey.js";

const envelopeSchema = z.object({
  code: z.number().optional(),
  success: z.boolean().optional(),
  data: z.unknown().optional(),
});
const personalSchema = z.object({
  productId: z.string().optional(),
  productName: z.string().optional(),
  status: z.string(),
  inCurrentPeriod: z.boolean(),
  autoRenew: z.union([z.number(), z.boolean()]).optional(),
  nextRenewTime: z.string().optional(),
  valid: z.string().optional(),
  billingCycle: z.string().optional(),
});
const teamSchema = z.object({
  hasSubscription: z.boolean(),
  status: z.string().nullish(),
  memberGrantStatus: z.string().nullish(),
  productId: z.string().nullish(),
  productName: z.string().nullish(),
  subscribeEndTime: z.string().nullish(),
  subscribePeriod: z.string().nullish(),
});
export type PersonalCodingPlanSubscription = z.infer<typeof personalSchema>;
export type TeamCodingPlanSubscription = z.infer<typeof teamSchema>;
export type CodingPlanEntitlement<T> =
  | { kind: "available"; subscription: T }
  | { kind: "unavailable"; reason?: "expired" | "unassigned" }
  | { kind: "unknown" };

function isCodingPlanProduct(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { productId, productName } = value as Record<string, unknown>;
  return [productId, productName].some(
    (field) => typeof field === "string" && field.toLowerCase().includes("coding"),
  );
}

export function isActivePersonalCodingPlan(subscription: {
  productId?: string;
  productName?: string;
  status?: string;
  inCurrentPeriod?: boolean;
}): boolean {
  return (
    isCodingPlanProduct(subscription) &&
    subscription.status === "VALID" &&
    subscription.inCurrentPeriod === true
  );
}

function readSuccessfulData(payload: unknown): unknown {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const envelope = parsed.data;
  // Optional-code contract matches availability; a missing success code is not a business failure.
  if (
    envelope.success === false ||
    (envelope.code !== undefined && ![0, 200].includes(envelope.code))
  )
    return undefined;
  return envelope.data;
}

export async function fetchPersonalCodingPlanEntitlement(params: {
  apiClient: ApiClient;
  authorization: string;
  url: string;
  timeoutMs: number;
}): Promise<CodingPlanEntitlement<PersonalCodingPlanSubscription>> {
  if (!params.authorization.trim()) return { kind: "unknown" };
  const payload = await readApiJson<unknown>(params.apiClient, params.url, {
    method: "GET",
    timeoutMs: params.timeoutMs,
    headers: { Authorization: params.authorization },
  });
  const list = z.array(z.unknown()).safeParse(readSuccessfulData(payload));
  if (!list.success) return { kind: "unknown" };
  let malformedCodingEntry = false;
  // The subscription list is heterogeneous: validate only the Coding entries in use, and never let
  for (const item of list.data) {
    const parsed = personalSchema.safeParse(item);
    if (parsed.success && isActivePersonalCodingPlan(parsed.data)) {
      return { kind: "available", subscription: parsed.data };
    }
    if (!parsed.success && isCodingPlanProduct(item)) malformedCodingEntry = true;
  }
  // unrelated items shadow a valid entitlement.
  return { kind: malformedCodingEntry ? "unknown" : "unavailable" };
}

export async function fetchTeamCodingPlanEntitlement(params: {
  apiClient: ApiClient;
  authorization: string;
  host: string;
  teamContext: BigModelTeamPlanBizContext;
  timeoutMs: number;
}): Promise<CodingPlanEntitlement<TeamCodingPlanSubscription>> {
  if (!params.authorization.trim()) return { kind: "unknown" };
  const payload = await readApiJson<unknown>(
    params.apiClient,
    `${params.host.replace(/\/$/, "")}/api/biz/team/subscribe/product/querySubscribeDetail`,
    {
      method: "GET",
      timeoutMs: params.timeoutMs,
      headers: {
        Authorization: params.authorization,
        "bigmodel-organization": params.teamContext.organizationId,
        "bigmodel-project": params.teamContext.projectId,
      },
    },
  );
  const parsed = teamSchema.safeParse(readSuccessfulData(payload));
  if (!parsed.success) return { kind: "unknown" };
  const subscription = parsed.data;
  if (!subscription.hasSubscription) return { kind: "unavailable" };
  // A stale plan still returns hasSubscription=true; a subscription record is not current validity.
  if (subscription.status === "EXPIRED") return { kind: "unavailable", reason: "expired" };
  if (subscription.status === "EFFECTIVE" && subscription.memberGrantStatus === "UNASSIGNED")
    return { kind: "unavailable", reason: "unassigned" };
  // Keep unknown new enums unknown; never interpret them as no-entitlement.
  if (subscription.status !== "EFFECTIVE" || subscription.memberGrantStatus !== "VALID") {
    return { kind: "unknown" };
  }
  return { kind: "available", subscription };
}
