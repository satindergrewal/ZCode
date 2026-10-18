import { z } from "zod";

// Reasons ride Account State and must share the strict protocol's enum, or the whole snapshot is rejected.
// credential-failed means credential fetch/validate failed; never assert OAuth expiry from it.
export const accountProviderUnavailableReasonSchema = z.enum([
  "not-authenticated",
  "not-connected",
  "credential-failed",
  "not-entitled",
]);
export type AccountProviderUnavailableReason = z.infer<
  typeof accountProviderUnavailableReasonSchema
>;
