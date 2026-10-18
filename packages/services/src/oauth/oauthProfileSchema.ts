import {
  BIGMODEL_PROVIDER_ID,
  type OAuthProviderId,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import type { OAuthProviderAdapter } from "./providers/index.js";

const BIGMODEL_PROFILE_SCHEMA_VERSION = 2;
const BIGMODEL_PROFILE_MIGRATION_RETRY_DELAY_MS = 60 * 60 * 1000;

interface RefreshLegacyBigModelCachedProfileOptions {
  adapter: OAuthProviderAdapter;
  cachedProfile: OAuthUserProfile;
  loadTokenSet: () => Promise<OAuthTokenSet | null>;
  saveProfile: (profile: OAuthUserProfile) => Promise<void>;
  now: () => number;
  runWithAdapterError: <T>(run: () => Promise<T>) => Promise<T>;
}

function getCachedProfileSchemaVersion(profile: OAuthUserProfile): number | null {
  const rawProfile = profile.rawProfile;
  if (!rawProfile || typeof rawProfile !== "object") {
    return null;
  }

  const version = (rawProfile as { zcodeProfileSchemaVersion?: unknown }).zcodeProfileSchemaVersion;
  return typeof version === "number" ? version : null;
}

function getCachedProfileMigrationRetryAfter(profile: OAuthUserProfile): number | null {
  const rawProfile = profile.rawProfile;
  if (!rawProfile || typeof rawProfile !== "object") {
    return null;
  }

  const retryAfter = (rawProfile as { zcodeProfileMigrationRetryAfter?: unknown })
    .zcodeProfileMigrationRetryAfter;
  return typeof retryAfter === "number" ? retryAfter : null;
}

function isBigModelUserInfoFallback(profile: OAuthUserProfile): boolean {
  return profile.id === "unknown" && profile.username === "user" && profile.displayName === "User";
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function shouldCompleteMigrationAfterError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 401 || status === 403;
}

export function withProviderProfileSchema(
  provider: OAuthProviderId,
  profile: OAuthUserProfile,
): OAuthUserProfile {
  if (provider !== BIGMODEL_PROVIDER_ID) {
    return profile;
  }

  const rawProfile =
    profile.rawProfile && typeof profile.rawProfile === "object" ? profile.rawProfile : {};
  const nextRawProfile = { ...(rawProfile as Record<string, unknown>) };
  delete nextRawProfile.zcodeProfileMigrationRetryAfter;

  return {
    ...profile,
    rawProfile: {
      ...nextRawProfile,
      zcodeProfileSchemaVersion: BIGMODEL_PROFILE_SCHEMA_VERSION,
    },
  };
}

function withBigModelProfileMigrationRetryAfter(
  profile: OAuthUserProfile,
  now: number,
): OAuthUserProfile {
  const rawProfile =
    profile.rawProfile && typeof profile.rawProfile === "object" ? profile.rawProfile : {};

  return {
    ...profile,
    rawProfile: {
      ...(rawProfile as Record<string, unknown>),
      zcodeProfileMigrationRetryAfter: now + BIGMODEL_PROFILE_MIGRATION_RETRY_DELAY_MS,
    },
  };
}

export async function refreshLegacyBigModelCachedProfile(
  options: RefreshLegacyBigModelCachedProfileOptions,
): Promise<OAuthUserProfile> {
  const { adapter, cachedProfile, loadTokenSet, now, runWithAdapterError, saveProfile } = options;
  if (
    (getCachedProfileSchemaVersion(cachedProfile) ?? 0) >= BIGMODEL_PROFILE_SCHEMA_VERSION ||
    (getCachedProfileMigrationRetryAfter(cachedProfile) ?? 0) > now() ||
    !adapter.fetchUserInfo
  ) {
    return cachedProfile;
  }

  const tokenSet = await loadTokenSet();
  if (!tokenSet) {
    await saveProfile(withProviderProfileSchema(BIGMODEL_PROVIDER_ID, cachedProfile));
    return cachedProfile;
  }

  try {
    // Legacy BigModel caches kept nickName only; after upgrade restoreCachedSession bypasses
    // fetchUserInfo. Best-effort refresh for versionless caches; failure keeps the local login.
    const refreshedProfile = await runWithAdapterError(() =>
      adapter.fetchUserInfo!(tokenSet, {
        providerId: BIGMODEL_PROVIDER_ID,
        state: "",
        redirectUri: adapter.redirectUri,
        now,
      }),
    );
    if (isBigModelUserInfoFallback(refreshedProfile)) {
      // Old versions could write the zcode JWT into the BigModel access token.
      // The adapter then returns the unknown/User sentinel for BigModel user info;
      // migration must not overwrite trusted caches with the sentinel, or the version mark fixes a wrong display name forever.
      await saveProfile(withProviderProfileSchema(BIGMODEL_PROVIDER_ID, cachedProfile));
      return cachedProfile;
    }
    const migratedProfile = withProviderProfileSchema(BIGMODEL_PROVIDER_ID, refreshedProfile);
    await saveProfile(migratedProfile);
    return migratedProfile;
  } catch (error) {
    if (shouldCompleteMigrationAfterError(error)) {
      await saveProfile(withProviderProfileSchema(BIGMODEL_PROVIDER_ID, cachedProfile));
      return cachedProfile;
    }

    // Offline/timeout/5xx are transient; never permanently write schema version 2.
    // retry-after avoids a userinfo hit per startup while keeping the migration chance.
    await saveProfile(withBigModelProfileMigrationRetryAfter(cachedProfile, now()));
    return cachedProfile;
  }
}
