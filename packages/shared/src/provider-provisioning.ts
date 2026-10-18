import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";
import { providerFamilyConnectionSelectionSettingsSchema } from "./provider-family-connection-selection.js";

const nonEmptyString = z.string().trim().min(1);

export const providerProvisioningTriggerSchema = z.enum([
  "environment-online",
  "personal-config",
  "configured-default",
  "account-settings",
  "credential",
]);
export type ProviderProvisioningTrigger = z.infer<typeof providerProvisioningTriggerSchema>;

/** Credential classes allowed to cross environments during provisioning. */
export const providerProvisioningCredentialScopeSchema = z.enum([
  "oauth-session",
  "account-provider",
]);

export type ProviderProvisioningCredentialScope = z.infer<
  typeof providerProvisioningCredentialScopeSchema
>;

/** For validating legacy schema v1 envelopes only; new sources do not export and new targets do not apply these historical keys. */
export function isProviderProvisioningAccountCredentialKey(key: string): boolean {
  const normalized = key.trim();
  return normalized === key && /^account-provider:.+:api-key$/.test(normalized);
}

/** Personal config envelope; fields are re-validated by @zcode/provider in the target environment. */
export const providerProvisioningPersonalConfigSchema = z
  .object({
    providerConfigRules: z.object({ providerRules: z.array(z.unknown()) }).strict(),
    modelConfigRules: z
      .object({
        providerModelRules: z.array(z.unknown()),
        manualProviderModelRules: z.array(z.unknown()),
      })
      .strict(),
    providerOrder: z.array(nonEmptyString).optional(),
    defaultModelSelection: modelSelectionSchema.optional(),
  })
  .strict();

export type ProviderProvisioningPersonalConfig = z.infer<
  typeof providerProvisioningPersonalConfigSchema
>;

export const providerProvisioningAccountSettingsSchema = z
  .object({
    providerFamilyDomain: z.enum(["zai", "bigmodel"]).nullable(),
    providerFamilyConnectionSelections: providerFamilyConnectionSelectionSettingsSchema,
  })
  .strict();

export type ProviderProvisioningAccountSettings = z.infer<
  typeof providerProvisioningAccountSettingsSchema
>;

export const providerProvisioningCredentialEntrySchema = z
  .object({
    scope: providerProvisioningCredentialScopeSchema,
    key: nonEmptyString,
    value: z.string(),
  })
  .strict();

export type ProviderProvisioningCredentialEntry = z.infer<
  typeof providerProvisioningCredentialEntrySchema
>;

export const providerProvisioningEnvelopeSchema = z
  .object({
    // In v2 a missing account key no longer means deletion; legacy targets must reject the envelope before any write.
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    syncId: nonEmptyString,
    personalConfig: providerProvisioningPersonalConfigSchema,
    accountSettings: providerProvisioningAccountSettingsSchema,
    credentials: z.array(providerProvisioningCredentialEntrySchema).max(256),
  })
  .strict()
  .refine(
    (value) =>
      value.schemaVersion === 1 ||
      value.credentials.every((entry) => entry.scope === "oauth-session"),
    { message: "Provisioning v2 only accepts OAuth credentials", path: ["credentials"] },
  );

export type ProviderProvisioningEnvelope = z.infer<typeof providerProvisioningEnvelopeSchema>;

/** Only fixed stage codes cross processes; remote free text must never become publicly visible diagnostics. */
export const providerProvisioningErrorCodeSchema = z.enum([
  "source-read-failed",
  "target-call-failed",
  "target-write-failed",
  "target-refresh-failed",
  "target-commit-failed",
  "target-apply-failed",
  "capability-unavailable",
  "session-unavailable",
  "host-execution-failed",
]);
export type ProviderProvisioningErrorCode = z.infer<typeof providerProvisioningErrorCodeSchema>;

export const providerProvisioningResultSchema = z
  .object({
    syncId: nonEmptyString,
    status: z.enum(["applied", "already-applied", "unsupported", "failed", "rollback_failed"]),
    personalProviderCount: z.number().int().nonnegative(),
    credentialCount: z.number().int().nonnegative(),
    configRevision: nonEmptyString.optional(),
    errorMessage: z.string().optional(),
    errorCode: providerProvisioningErrorCodeSchema.optional(),
    rolledBack: z.boolean(),
  })
  .strict();

export type ProviderProvisioningResult = z.infer<typeof providerProvisioningResultSchema>;
