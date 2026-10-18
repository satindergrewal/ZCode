import { decodeCustomModelValue, encodeCustomModelValue } from "@zcode/shared";

// The provider refactor split execution identities, but legacy reports still bucket the old way; use only at
// event-construction sites, never flow back into business config. Legacy staging 790884b1ce Team connections also use the builtin:* former Coding Plan identity.
const legacyProviderIds: Readonly<Record<string, string>> = Object.freeze({
  "zai-api": "builtin:zai",
  "bigmodel-api": "builtin:bigmodel",
  "account:zai-individual-coding-plan": "builtin:zai-coding-plan",
  "account:zai-team-coding-plan": "builtin:zai-coding-plan",
  "account:bigmodel-individual-coding-plan": "builtin:bigmodel-coding-plan",
  "account:bigmodel-team-coding-plan": "builtin:bigmodel-coding-plan",
  "account:zai-start-plan": "builtin:zai-start-plan",
  "account:bigmodel-start-plan": "builtin:bigmodel-start-plan",
  "account:zai-offpeak-idle-plan": "offpeak-idle-plan",
  "account:bigmodel-offpeak-idle-plan": "offpeak-idle-plan",
});

export function legacyTelemetryProviderId(providerId: string): string {
  return Object.hasOwn(legacyProviderIds, providerId) ? legacyProviderIds[providerId]! : providerId;
}

/** Rewrite known provider prefixes only; plain model ids, unknown identities, and in-model encodings pass through. */
export function legacyTelemetryModelValue(value: string): string {
  const custom = decodeCustomModelValue(value);
  if (custom) {
    const providerId = legacyTelemetryProviderId(custom.providerId);
    return providerId === custom.providerId
      ? value
      : encodeCustomModelValue(providerId, custom.modelName);
  }
  const slash = value.indexOf("/");
  if (slash < 1) return value;
  const providerId = value.slice(0, slash);
  return legacyTelemetryProviderId(providerId) + value.slice(slash);
}

/** Project conversation events only after completion attribution; never alter raw request/child/seed facts. */
export function legacyTelemetryModelFields(detail: Record<string, string>): Record<string, string> {
  return {
    ...detail,
    ...(detail.model_provider !== undefined
      ? { model_provider: legacyTelemetryProviderId(detail.model_provider) }
      : {}),
    ...(detail.model_name !== undefined
      ? { model_name: legacyTelemetryModelValue(detail.model_name) }
      : {}),
  };
}
