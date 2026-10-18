import type {
  OnboardingRecordEntry,
  OnboardingRecordEntryInput,
  OnboardingRecordFile,
  OnboardingDecision,
} from "@zcode/shared";
import { ServiceChannels, type AppSettings } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Fields written back to settings from the record on login-state change (settings stays the runtime source of truth). */
export interface OnboardingSettingsSyncPatch {
  onboardingOccupation?: AppSettingsPatchOccupation;
  proactiveSuggestionsEnabled?: boolean;
  memoryEnabled?: boolean;
}

type AppSettingsPatchOccupation = NonNullable<AppSettings["onboardingOccupation"]>;

export interface IOnboardingRecordService {
  /**
   * Appends an onboarding-completed record. Creates the file and pins deviceMid when absent
   * (the file's value is authoritative afterwards); userId is filled by the service, never passed.
   */
  appendRecord(deviceMid: string, entry: OnboardingRecordEntryInput): Promise<void>;
  /** Should-trigger: true when the current user (login->userId; apikey/anonymous->null) has no record or the file is missing. */
  shouldOnboard(deviceMid: string): Promise<boolean>;
  /** Persists dismissed when the user closes onboarding; no-op if answers exist. */
  dismissOnboarding(deviceMid: string): Promise<void>;
  /**
   * Login claim: when the current userId has no entry but an anonymous (null) one exists, reassign
   * that entry by rewrite, never copy, so one onboarding cannot double-count uploads. The same
   * person going anonymous->answered->login is not onboarded again; losing the anon record and
   * re-triggering is expected. No-op when anonymous (userId=null) or an entry already exists.
   */
  claimAnonymousRecord(): Promise<void>;
  /** Latest answers for the current user (prefill on reopen); null when none. */
  getLatestEntry(): Promise<OnboardingRecordEntry | null>;
  /**
   * Copies the user's latest record answers back into settings (restores occupation/preferences on
   * account switch, swapping the recommender pool). Null-recorded fields backfill conservative
   * defaults (occupation other, toggles off) like the skip path; no record means no settings change.
   */
  syncSettingsFromRecord(): Promise<OnboardingSettingsSyncPatch | null>;
  /**
   * Writes manual preference edits back into the record (kept as the user's latest preferences,
   * matching the manual settings path so account sync cannot revive dismissed toggles).
   */
  updateRecordPreferences(
    patch: Partial<
      Pick<OnboardingRecordEntryInput, "memoryEnabled" | "proactiveSuggestionsEnabled">
    >,
  ): Promise<void>;
  /** Reads the whole record file for server upload; null when missing. */
  getRecords(): Promise<OnboardingRecordFile | null>;
  /** Deletes the record file (debugging aid). */
  clearRecords(): Promise<void>;
}

/** Factory args: injected userId resolver (oauthCredentialRepo in prod, stubs in tests). */
export interface CreateOnboardingRecordServiceOptions {
  loadUserId: () => Promise<string | null>;
  hasExistingLocalTask: () => Promise<boolean>;
}

export type OnboardingRecordServiceFactory = (
  options: CreateOnboardingRecordServiceOptions,
) => IOnboardingRecordService;

export const IOnboardingRecordService = createServiceDescriptor<IOnboardingRecordService>(
  ServiceChannels.OnboardingRecord,
);

export type {
  OnboardingDecision,
  OnboardingRecordEntry,
  OnboardingRecordEntryInput,
  OnboardingRecordFile,
};
