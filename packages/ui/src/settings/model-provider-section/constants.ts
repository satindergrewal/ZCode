import {
  BIGMODEL_PROVIDER_ID,
  buildBigModelApiUrl,
  buildBigModelCodingPlanPersonalManageUrl,
  BUILTIN_MODEL_PROVIDER_IDS,
  createUuid,
  type OAuthProviderId,
  ZCODE_ENV,
  ZAI_PROVIDER_ID,
  type BuiltinModelProviderId,
  type UsageQuotaLimit,
  type UsageEntitlementSubscriptionDetail,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";

export function generateId(): string {
  return createUuid();
}

export const PRESET_SUBSCRIPTION_TIMEOUT_MS = 2 * 60 * 1000;
export const BIGMODEL_REGISTRATION_URL = buildBigModelApiUrl({ ZCODE_ENV }, "/login");
export const BIGMODEL_CODING_PLAN_PERSONAL_MANAGE_URL = buildBigModelCodingPlanPersonalManageUrl({
  ZCODE_ENV,
});

export interface PresetProviderSpec {
  id: BuiltinModelProviderId;
  displayName: string;
  oauthProviderId?: OAuthProviderId;
}

export const PRESET_PROVIDER_SPECS: PresetProviderSpec[] = [
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    displayName: "Z.ai",
    oauthProviderId: ZAI_PROVIDER_ID,
  },
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    displayName: "BigModel",
    oauthProviderId: BIGMODEL_PROVIDER_ID,
  },
];

export const PRESET_PROVIDER_SPEC_BY_ID = new Map<BuiltinModelProviderId, PresetProviderSpec>(
  PRESET_PROVIDER_SPECS.map((item) => [item.id, item]),
);

export type CodingPlanProviderId =
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;

export type CodingPlanStatus =
  | "disconnected"
  | "checking"
  | "notPurchased"
  | "purchased"
  | "unavailable"
  | "unsupported";

export type TeamPlanAvailabilityReason = "not-allocated" | "expired" | "credential-unavailable";

interface CodingPlanProviderSpec {
  id: CodingPlanProviderId;
  oauthProviderId: OAuthProviderId;
  label: string;
  providerName: string;
  purchaseUrl?: string;
}

export const CODING_PLAN_PROVIDER_SPECS: CodingPlanProviderSpec[] = [
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    oauthProviderId: ZAI_PROVIDER_ID,
    label: "Z.ai - Coding Plan",
    providerName: "Z.ai",
    purchaseUrl: "https://z.ai/manage-apikey/subscription",
  },
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    oauthProviderId: ZAI_PROVIDER_ID,
    label: "Z.ai - Coding Plan",
    providerName: "Z.ai",
    purchaseUrl: "https://z.ai/manage-apikey/subscription",
  },
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    oauthProviderId: BIGMODEL_PROVIDER_ID,
    label: "BigModel - Coding Plan",
    providerName: "BigModel",
    purchaseUrl: BIGMODEL_CODING_PLAN_PERSONAL_MANAGE_URL,
  },
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    oauthProviderId: BIGMODEL_PROVIDER_ID,
    label: "BigModel- Coding Plan",
    providerName: "BigModel",
    purchaseUrl: BIGMODEL_CODING_PLAN_PERSONAL_MANAGE_URL,
  },
];

export interface CodingPlanEntitlementState {
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
  error: string | null;
}

export function resolveModelProviderDisplayName(
  provider: Pick<ProviderSettingsFormProvider, "providerId" | "config">,
): string {
  if (
    provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  ) {
    return "Z.ai - Coding Plan";
  }

  if (provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan) {
    return "Start Plan";
  }

  if (provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan) {
    return "Start Plan";
  }

  return getProviderFormLabel(provider);
}

export type ModelProviderNavItem =
  | {
      key: string;
      type: "preset";
      /** Brand entry icon is independent of the item's legacy Start navigation identity. */
      logo?: ProviderSettingsFormProvider["config"]["logo"];
      /** The account-group dot reflects only the current concrete connection's public execution result. */
      statusProvider?: ProviderSettingsFormProvider | null;
      presetId: BuiltinModelProviderId;
      label: string;
      provider: ProviderSettingsFormProvider | null;
      displayName: string;
      statusActive: boolean;
    }
  | {
      key: string;
      type: "codingPlan";
      presetId: CodingPlanProviderId;
      oauthProviderId: OAuthProviderId;
      label: string;
      providerName: string;
      provider: ProviderSettingsFormProvider | null;
      /** Whether the Account Overlay has enabled this provider. */
      accountEntitled?: boolean;
      status: CodingPlanStatus;
      planLevel?: string | null;
      currentProductId?: string | null;
      subscriptionBillingCycle?: string | null;
      subscriptionRenewTime?: string | null;
      subscriptionExpireTime?: string | null;
      subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
      quotaLimits?: UsageQuotaLimit[];
      /** Official Server MCP quota (server-delivered total). Not in quota.limits[]; passed to the quota card separately. */
      mcpQuotaLimit?: UsageQuotaLimit | null;
      purchaseUrl?: string;
      /** The entitlement query explicitly demands re-login; the copy never drives action branching. */
      accountLoginRequired?: boolean;
      statusLabelId?: string;
      statusMessage?: string | null;
      inactivePlanTitle?: string | null;
      statusActive: boolean;
    }
  | {
      key: string;
      type: "teamPlan";
      presetId: CodingPlanProviderId;
      oauthProviderId: OAuthProviderId;
      label: string;
      providerName: string;
      teamPlanName: string;
      organizationId?: string | null;
      projectId?: string | null;
      provider: ProviderSettingsFormProvider | null;
      /** Whether the Account Overlay has enabled this provider. */
      accountEntitled?: boolean;
      status: CodingPlanStatus;
      planLevel?: string | null;
      currentProductId?: string | null;
      subscriptionBillingCycle?: string | null;
      subscriptionRenewTime?: string | null;
      subscriptionExpireTime?: string | null;
      subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
      quotaLimits?: UsageQuotaLimit[];
      /** Official Server MCP quota (server-delivered total). Not in quota.limits[]; passed to the quota card separately. */
      mcpQuotaLimit?: UsageQuotaLimit | null;
      purchaseUrl?: string;
      statusLabelId?: string;
      statusMessage?: string | null;
      /** Business reason for the team status; interaction must no longer infer it from i18n copy. */
      availabilityReason?: TeamPlanAvailabilityReason;
      inactivePlanTitle?: string | null;
      statusActive: boolean;
    }
  | {
      key: string;
      type: "codingPlanLoading";
      label: string;
      providerName: string;
      oauthProviderId?: OAuthProviderId;
    }
  | {
      key: string;
      type: "custom";
      label: string;
      provider: ProviderSettingsFormProvider;
      statusActive: boolean;
    };

export type ModelProviderNavGroupId = "preset" | "custom";

export interface ModelProviderNavGroup {
  id: ModelProviderNavGroupId;
  title: string;
  items: ModelProviderNavItem[];
}
