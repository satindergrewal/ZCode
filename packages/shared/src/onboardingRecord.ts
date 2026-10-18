import { z } from "zod";

/**
 * Onboarding completion record (three-step wizard: role / mode / preferences).
 *
 * Design constraints:
 * - a standalone local JSON (~/.zcode/v2/onboarding-record.json), never inside AppSettings;
 * - keyed by deviceMid; entries allow multiple userIds (multi-login) and null (apikey/anonymous);
 * - uploadState reserves the later server upload: pending -> uploaded;
 * - skipped is an explicit answer: a skipped page records null, distinct from a chosen value.
 */

/** occupation is a non-empty string, not an enum: the list evolves; legacy records must keep validating. */
export const onboardingOccupationSchema = z.string().min(1).nullable();

export const onboardingInterfaceModeSchema = z.enum(["coding", "office"]).nullable();

export const onboardingRecordEntrySchema = z.object({
  userId: z.string().min(1).nullable(),
  occupation: onboardingOccupationSchema,
  interfaceMode: onboardingInterfaceModeSchema,
  memoryEnabled: z.boolean().nullable(),
  proactiveSuggestionsEnabled: z.boolean().nullable(),
  completedAt: z.string().min(1),
  uploadState: z.literal("pending"),
});

export const onboardingDecisionSchema = z.object({
  userId: z.string().min(1).nullable(),
  status: z.enum(["dismissed", "existing_local_user"]),
  reason: z.enum(["user_closed", "existing_local_task"]),
  decidedAt: z.string().min(1),
});

const onboardingRecordFileV1Schema = z.object({
  version: z.literal(1),
  deviceMid: z.string().min(1),
  entries: z.array(onboardingRecordEntrySchema),
});

const onboardingRecordFileV2Schema = z.object({
  version: z.literal(2),
  deviceMid: z.string().min(1),
  entries: z.array(onboardingRecordEntrySchema),
  decisions: z.array(onboardingDecisionSchema),
});

/** v1 needs no startup migration; read backfills empty decisions, the next business write lands v2. */
export const onboardingRecordFileSchema = z
  .union([onboardingRecordFileV1Schema, onboardingRecordFileV2Schema])
  .transform((file) =>
    file.version === 1 ? { ...file, version: 2 as const, decisions: [] } : file,
  );

export type OnboardingRecordEntry = z.infer<typeof onboardingRecordEntrySchema>;
export type OnboardingDecision = z.infer<typeof onboardingDecisionSchema>;

/** appendRecord input: the server (host) fills userId; callers never pass it. */
export type OnboardingRecordEntryInput = Omit<OnboardingRecordEntry, "userId" | "uploadState">;

export type OnboardingRecordFile = z.infer<typeof onboardingRecordFileSchema>;
