import type { ProviderFamilyDomain, ProjectAccessTokenMaterial } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";

const log = createServiceLogger("account-project-token");
interface AccountProviderCredentialServiceOptions {
  readonly loadOAuthAccessToken: (family: ProviderFamilyDomain) => Promise<string | null>;
  readonly resolveProviderMaterial: (
    family: ProviderFamilyDomain,
    accessToken: string,
    accountIdentity: string,
    rejectedProjectTokenFingerprint?: string,
  ) => Promise<ProjectAccessTokenMaterial | null>;
}
interface LoadCodingPlanApiKeyInput {
  readonly providerId: string;
  readonly family: ProviderFamilyDomain;
  readonly accountIdentity: string;
  readonly forceRefresh?: boolean;
  readonly rejectedProjectTokenFingerprint?: string;
}
export interface AccountProviderCredentialService {
  loadCodingPlanApiKey(input: LoadCodingPlanApiKeyInput): Promise<string | null>;
  loadCodingPlanMaterial(
    input: LoadCodingPlanApiKeyInput,
  ): Promise<ProjectAccessTokenMaterial | null>;
}

/** Legacy name kept for the private call contract; returns request-time tokens only, never the long-term key cache. */
export function createAccountProviderCredentialService(
  options: AccountProviderCredentialServiceOptions,
): AccountProviderCredentialService {
  const pending = new Map<string, Promise<ProjectAccessTokenMaterial | null>>();
  return {
    async loadCodingPlanApiKey(input) {
      return (await this.loadCodingPlanMaterial(input))?.token ?? null;
    },
    async loadCodingPlanMaterial(input) {
      const loginToken = (await options.loadOAuthAccessToken(input.family))?.trim();
      if (!loginToken) return null;
      // The Map holds in-flight state only; an auth change must not join the old account's request.
      const key = JSON.stringify([
        input.family,
        input.accountIdentity,
        loginToken,
        input.rejectedProjectTokenFingerprint,
      ]);
      const existing = pending.get(key);
      if (existing) return existing;
      const operation = (async () => {
        const token = await options.resolveProviderMaterial(
          input.family,
          loginToken,
          input.accountIdentity,
          input.rejectedProjectTokenFingerprint,
        );
        if ((await options.loadOAuthAccessToken(input.family))?.trim() !== loginToken) {
          log.warn(undefined, "Auth changed while issuing the project token; discarding result", {
            family: input.family,
          });
          throw new Error("project_token_scope_invalidated");
        }
        return token ?? null;
      })();
      pending.set(key, operation);
      try {
        return await operation;
      } finally {
        if (pending.get(key) === operation) pending.delete(key);
      }
    },
  };
}
