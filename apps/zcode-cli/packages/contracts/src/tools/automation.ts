// ============================================================
// Cron automation tools - session-level scheduled task management
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const nonEmptyString = z.string().trim().min(1);
// contracts still on Zod 3 while the shared protocol is on Zod 4; schema instances cannot compose across versions.
// Field contracts stay leaf-identical to shared ModelSelection; drop this local declaration once versions unify.
const cronModelSelectionSchema = z
  .object({
    providerId: nonEmptyString,
    modelId: nonEmptyString,
    options: z
      .object({
        reasoningLevel: nonEmptyString.optional(),
        maxOutputTokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** The only arbiter of relative-vs-absolute: a positive integer alone means a relative delay.
 * delayMinutes was required-nullable, forcing plain cron creations to pass null explicitly -
 * callers omitting the field or providers flakily keeping null would fail the parse, or under
 * an `!== null` test misroute undefined into the relative branch and build recurring tasks as one-shot.
 * Both undefined and null mean "not relative", back-compat with the { cron, prompt, title } wire. */
export function hasRelativeDelayMinutes(input: { delayMinutes?: number | null }): boolean {
  return typeof input.delayMinutes === "number";
}

export const CronCreateInputSchema = z
  .object({
    cron: nonEmptyString
      .optional()
      .describe(
        "Standard 5-field cron expression in the user's local timezone: minute hour day-of-month month day-of-week. Use it only for an absolute named date/time or a recurring schedule; required unless delayMinutes is set. For any relative delay such as 'in 8 minutes'/'8分钟后' or 'in 2 hours'/'2小时后', omit cron and use delayMinutes instead — never convert a relative phrase into a fixed clock time or calendar date, because a just-passed one-shot time silently rolls a full year forward. Examples: '*/20 * * * *' means every 20 minutes, '0 * * * *' means hourly, and '0 9 * * 1-5' means weekdays at 09:00. Do not convert to UTC.",
      ),
    delayMinutes: z
      .number()
      .int()
      .positive()
      .max(525_600)
      .nullable()
      .optional()
      .describe(
        "For any relative delay from now — 'in 3 minutes' (3), '8分钟后' (8), 'in 2 hours' (120), 'later'/'稍后' — set the exact positive delay in whole minutes and omit cron. The host calculates the future local schedule from its real current clock, so never compute an absolute time or cron yourself. For an absolute named date/time or a recurring schedule, omit it (or set null) and provide cron.",
      ),
    prompt: nonEmptyString.describe(
      "Complete prompt to send at every scheduled fire. Include all instructions needed when the automation runs. Describe the final work directly; do not ask it to create or schedule another automation or call CronCreate.",
    ),
    title: nonEmptyString.describe(
      "Concise automation title that preserves the user's natural-language schedule phrase verbatim. For example, for '每20分钟提醒我喝水', use '每20分钟喝水提醒', not '喝水提醒'.",
    ),
    recurring: z
      .boolean()
      .optional()
      .describe(
        "true (default) repeats until paused or deleted. false creates a finite automation; without maxRuns it runs once.",
      ),
    maxRuns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Maximum successful scheduled dispatch count. Use only with recurring=false; omit for a one-shot automation (defaults to 1).",
      ),
    // Session-side "custom recurrence" carrier. Every-N minutes/hours/days/weeks/months/years is
    // expressed as intervalUnit + interval, same as the UI; the true interval rides the host
    // scheduleRule; cron is a legal compat view only.
    // Never let cron field step caps (minute 59, hour 24, day-of-month 31, month 12) distort the
    // true frequency. Mutually exclusive with delayMinutes (one-shot).
    intervalUnit: z
      .enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"])
      .optional()
      .describe(
        "Custom recurring interval unit for every N minutes/hours/days/weeks/months/years. Pair with interval (1-200) for every N-unit request, even if cron can express N; submit a legal compatible cron whose time/day slots are used by the scheduleRule. Omit both for ordinary calendar cron schedules.",
      ),
    interval: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Integer interval from 1 to 200 paired with intervalUnit. The host carries the real interval via scheduleRule; the compatible cron is only a legal display expression. Must be set together with intervalUnit.",
      ),
  })
  .strict()
  .refine((input) => hasRelativeDelayMinutes(input) || input.cron !== undefined, {
    message: "cron is required when delayMinutes is not set",
    path: ["cron"],
  })
  .refine((input) => !hasRelativeDelayMinutes(input) || input.cron === undefined, {
    message: "a relative delay must omit cron; the host computes the schedule from its real clock",
    path: ["cron"],
  })
  .refine((input) => !hasRelativeDelayMinutes(input) || input.recurring !== true, {
    message: "a relative delay creates a one-shot automation and cannot use recurring=true",
    path: ["recurring"],
  })
  .refine((input) => !hasRelativeDelayMinutes(input) || input.maxRuns === undefined, {
    message: "a relative delay runs once and cannot use maxRuns",
    path: ["maxRuns"],
  })
  // intervalUnit+interval is the recurring carrier, semantically conflicting with the one-shot
  // relative delay delayMinutes (recurring vs once); sending both is a contradictory state and
  // must be refused at the contract layer (the service layer has its own domain defense).
  .refine((input) => input.intervalUnit === undefined || !hasRelativeDelayMinutes(input), {
    message: "intervalUnit is a recurring carrier and cannot combine with a relative delayMinutes",
    path: ["intervalUnit"],
  })
  // intervalUnit and interval must pair: one alone cannot fix the interval; refuse.
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  // A carrier is by definition an unbounded long-period loop; one-shot / finite counts conflict with its scheduling semantics.
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and requires recurring=true",
    path: ["recurring"],
  })
  .refine((input) => input.intervalUnit === undefined || input.maxRuns === undefined, {
    message: "intervalUnit is a recurring carrier and cannot combine with maxRuns",
    path: ["maxRuns"],
  });
export type CronCreateInput = z.infer<typeof CronCreateInputSchema>;
export const CronCreateInputJsonSchema = toToolJsonSchema(CronCreateInputSchema);

const CronUpdateInputObjectSchema = z
  .object({
    id: nonEmptyString.describe("Automation id returned by CronCreate or CronList"),
    cron: nonEmptyString
      .optional()
      .describe(
        "Replacement standard 5-field cron expression in the user's local timezone. Omit to preserve the existing schedule. Do not convert to UTC.",
      ),
    prompt: nonEmptyString
      .optional()
      .describe(
        "Replacement prompt for future scheduled fires. Omit to preserve the existing prompt.",
      ),
    // With title optional, a model changing only cron/prompt would leave stale time or task
    // wording in the title. Session updates must submit the final title explicitly, so one
    // in-place update persists and echoes consistently.
    title: nonEmptyString.describe(
      "Required synchronized automation title describing the task after this update. Keep the user's natural-language schedule phrase consistent with cron (for example, changing every 5 minutes to every 6 minutes must also change the title), and update the title when the prompt meaning changes.",
    ),
    recurring: z
      .boolean()
      .optional()
      .describe(
        "Replacement recurrence mode. true repeats indefinitely and clears any old finite maxRuns limit; false is finite. Do not combine true with a numeric maxRuns.",
      ),
    maxRuns: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe(
        "Replacement maximum successful scheduled dispatch count for recurring=false. null clears the existing limit and is valid only when recurring=true is included in the same update; when recurring=true is supplied without maxRuns, the service clears the old limit automatically.",
      ),
    // Custom-recurrence carrier, semantics as create-side intervalUnit+interval (every-N always executes via scheduleRule).
    intervalUnit: z
      .enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"])
      .optional()
      .describe(
        "Switch this automation to a long recurring interval whose step exceeds a cron field ceiling (hourly N>24, daily N>31, etc.). Pair with interval and submit a legal compatible cron (omit cron to keep the existing schedule's minute).",
      ),
    interval: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Positive integer interval paired with intervalUnit. Must be set together with intervalUnit.",
      ),
  })
  .strict();

const CRON_UPDATE_FIELDS = [
  "cron",
  "prompt",
  "title",
  "recurring",
  "maxRuns",
  "intervalUnit",
  "interval",
] as const;
export const CronUpdateInputSchema = CronUpdateInputObjectSchema.refine(
  (input) => CRON_UPDATE_FIELDS.some((field) => input[field] !== undefined),
  { message: "CronUpdate requires at least one field to update" },
)
  .refine((input) => input.maxRuns !== null || input.recurring === true, {
    message: "Clearing maxRuns requires recurring=true in the same update",
    path: ["maxRuns"],
  })
  .refine((input) => input.recurring !== true || typeof input.maxRuns !== "number", {
    message: "recurring=true cannot be combined with a numeric maxRuns",
    path: ["maxRuns"],
  })
  // intervalUnit and interval must pair (create-side semantics).
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  // The carrier flips a legacy one-shot task into an infinite loop; callers must not also send contradictory finite-count semantics.
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine(
    (input) =>
      input.intervalUnit === undefined ||
      input.maxRuns === undefined ||
      (input.maxRuns === null && input.recurring === true),
    {
      message:
        "intervalUnit is a recurring carrier and only allows maxRuns=null with recurring=true",
      path: ["maxRuns"],
    },
  );
export type CronUpdateInput = z.infer<typeof CronUpdateInputSchema>;
// The provider-visible schema once expressed the recurring/maxRuns combination as a top-level
// anyOf, directly clashing with core's cross-provider guard (no $ref/$defs/anyOf or other
// provider-internal keys) and causing "some providers read required only on branches, dropping
// top-level id/title". Providers now project a clean object schema (top-level required applies
// naturally); the combination invariant is enforced by runtime CronUpdateInputSchema's refine,
// the model is guided by the recurring/maxRuns descriptions, and illegal combinations are
// refused at execution with a precise error.
export const CronUpdateInputJsonSchema = toToolJsonSchema(CronUpdateInputObjectSchema);

export const CronListInputSchema = z.object({}).strict();
export type CronListInput = z.infer<typeof CronListInputSchema>;
export const CronListInputJsonSchema = toToolJsonSchema(CronListInputSchema);

export const CronDeleteInputSchema = z
  .object({
    id: nonEmptyString.describe("Automation id returned by CronCreate or CronList"),
  })
  .strict();
export type CronDeleteInput = z.infer<typeof CronDeleteInputSchema>;
export const CronDeleteInputJsonSchema = toToolJsonSchema(CronDeleteInputSchema);

/**
 * Contract-layer mirror schema of the custom-recurrence rule (zod v3).
 * Structurally synced with @zcode/shared's ZCodeAutomationScheduleRule - shared is not imported
 * here, avoiding a zod v3 (agent contracts) x zod v4 (shared) cross dependency (same mirror
 * convention as browser-control). `cronExpr` stays as a compat view; scheduling keys off this
 * field, which also carries the session-side long-interval carrier after normalization.
 */
export const CronAutomationScheduleRuleSchema = z
  .object({
    unit: z.enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().positive(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    anchorAt: z.number().int(),
    weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    monthDays: z.array(z.number().int().min(1).max(31)).optional(),
    /** yearly only: human months 1-12. Defaults to anchorAt's month (compat with records lacking the field). */
    months: z.array(z.number().int().min(1).max(12)).optional(),
    monthlyMode: z.enum(["date", "weekday"]).optional(),
  })
  .strict();
export type CronAutomationScheduleRule = z.infer<typeof CronAutomationScheduleRuleSchema>;

export const CronAutomationSchema = z
  .object({
    automationId: nonEmptyString,
    title: z.string(),
    cronExpr: nonEmptyString,
    prompt: nonEmptyString,
    enabled: z.boolean(),
    lifecycleStatus: z.enum(["active", "completed", "failed", "paused"]),
    nextRunAt: z.number().int().nonnegative().optional(),
    lastRunAt: z.number().int().nonnegative().optional(),
    runCount: z.number().int().nonnegative(),
    recurring: z.boolean(),
    maxRuns: z.number().int().positive().optional(),
    modelSelection: cronModelSelectionSchema.optional(),
    mode: z.enum(["build", "edit", "plan", "yolo", "guarded"]).optional(),
    // Custom-recurrence rule; scheduling falls back to parsing cronExpr when absent. Session
    // cards need it to show true intervals cron cannot express (every 50 hours, every 40 days -
    // compat cronExpr is merely 0 * * * *).
    scheduleRule: CronAutomationScheduleRuleSchema.optional(),
  })
  .strict();
export type CronAutomation = z.infer<typeof CronAutomationSchema>;

export const CronCreateOutputSchema = z
  .object({
    automation: CronAutomationSchema,
    message: nonEmptyString,
  })
  .strict();
export type CronCreateOutput = z.infer<typeof CronCreateOutputSchema>;
export const CronCreateOutputJsonSchema = toToolJsonSchema(CronCreateOutputSchema);

export const CronUpdateOutputSchema = z
  .object({
    automation: CronAutomationSchema,
    message: nonEmptyString,
  })
  .strict();
export type CronUpdateOutput = z.infer<typeof CronUpdateOutputSchema>;
export const CronUpdateOutputJsonSchema = toToolJsonSchema(CronUpdateOutputSchema);

export const CronListOutputSchema = z
  .object({
    automations: z.array(CronAutomationSchema),
  })
  .strict();
export type CronListOutput = z.infer<typeof CronListOutputSchema>;
export const CronListOutputJsonSchema = toToolJsonSchema(CronListOutputSchema);

export const CronDeleteOutputSchema = z
  .object({
    deleted: z.boolean(),
    id: nonEmptyString,
    message: nonEmptyString,
  })
  .strict();
export type CronDeleteOutput = z.infer<typeof CronDeleteOutputSchema>;
export const CronDeleteOutputJsonSchema = toToolJsonSchema(CronDeleteOutputSchema);
