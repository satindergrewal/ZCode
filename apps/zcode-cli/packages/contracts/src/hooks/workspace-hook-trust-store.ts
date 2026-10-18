/**
 * The trust store file schema moved down to `@zcode/shared/workspace-hook-trust-store-file`
 * as the single authority (the services layer cannot depend on contracts under apps, and the
 * hand-written local validator split UI/runtime verdicts on the same broken file).
 *
 * This re-export keeps contracts' existing import paths (adapters/bootstrap/core etc.) stable. shared and contracts
 * sit on zod4 / zod3 instances respectively; do not compose this re-export into contracts-internal zod3 schemas.
 */
export {
  WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
  workspaceHookTrustRecordSchema,
  workspaceHookTrustStoreFileSchema,
} from "@zcode/shared/workspace-hook-trust-store-file";
export type {
  WorkspaceHookTrustRecord,
  WorkspaceHookTrustStoreFile,
} from "@zcode/shared/workspace-hook-trust-store-file";

import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);

export const workspaceHookPolicySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("deny"),
      reason: nonEmptyStringSchema,
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("user_decides"),
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("allow_trusted_only"),
      reason: nonEmptyStringSchema.optional(),
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
]);
export type WorkspaceHookPolicy = z.infer<typeof workspaceHookPolicySchema>;
