import { isApiKeyAccess } from "@zcode/provider";
import type {
  ConfigValidationIssue,
  AccountProviderState,
  ModelConfigObject,
  ProviderConfigObject,
  ProviderSettingsProviderView,
} from "@zcode/provider";

/** Provider state for one settings editing session. */
export interface ProviderSettingsFormProvider extends Pick<
  ProviderSettingsProviderView,
  "providerName" | "templateId"
> {
  providerId: string;
  /** Patch for explicit renames only; other edits must not materialize inherited names into personal config. */
  providerNameUpdate?: string | null;
  /** Outer toggle patch for explicit flips only; ordinary field edits never copy inherited on/off values. */
  enabledUpdate?: boolean;
  enabled: boolean;
  /** Status derived by the registry from the current Official, Personal, and Account Facts. */
  executable: boolean;
  accountState?: AccountProviderState;
  issues?: readonly ConfigValidationIssue[];
  hasPersonalConfig: boolean;
  /** The single sparse Personal Overlay the renderer edits and submits. */
  personalConfig: ProviderConfigObject;
  /** Read-only inherited baseline and immediate form display values; never persisted directly. */
  config: ProviderConfigObject;
  models: ProviderSettingsFormModel[];
}

/** Model state for one settings editing session. */
export interface ProviderSettingsFormModel {
  kind: "candidate";
  modelId: string;
  builtin: boolean;
  /** Built-in rule resolution before the Personal Rule overlay; lets the editor express inheritance and sparse overrides. */
  inheritedConfig?: ModelConfigObject;
  personalConfig: ModelConfigObject;
  /** Default or true follows the Built-in recommendation; false pins the personal config. */
  useRecommendedConfig?: boolean;
  config: ModelConfigObject;
  hasPersonalConfig: boolean;
  executable: boolean;
  selectable: boolean;
  issues?: readonly ConfigValidationIssue[];
}

export function getProviderFormLabel(
  provider: Pick<ProviderSettingsFormProvider, "providerId" | "providerName">,
): string {
  return provider.providerName?.trim() || provider.providerId;
}

export function getProviderFormApiKey(
  provider: Pick<ProviderSettingsFormProvider, "config">,
): string {
  return isApiKeyAccess(provider.config.access) ? (provider.config.access.apiKey ?? "") : "";
}

export function getProviderFormApiKeyManagementUrl(
  provider: Pick<ProviderSettingsFormProvider, "config">,
): string | undefined {
  return isApiKeyAccess(provider.config.access)
    ? (provider.config.access.apiKeyManagementUrl ?? undefined)
    : undefined;
}
