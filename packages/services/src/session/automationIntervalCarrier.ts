import type {
  ZCodeAutomationIntervalUnit,
  ZCodeAutomationScheduleRule,
  ZCodeAutomationUpdateParams,
} from "@zcode/shared";

/** Controlled cap of the session-side recurrence carrier; never tighten the management page's legacy scheduleRule domain cap. */
const MAX_SESSION_AUTOMATION_INTERVAL = 200;

/** Session recurrence carrier pairing/range/exclusivity validation failure. */
export class InvalidAutomationIntervalCarrierError extends Error {
  constructor(message: string) {
    super(`Invalid custom recurrence input: ${message}`);
    this.name = "InvalidAutomationIntervalCarrierError";
  }
}

/**
 * Validates the interval carrier shared by the session Cron tool and the UI.
 *
 * intervalUnit + interval is controlled input; the service layer must revalidate so legacy clients or internal
 * calls cannot bypass contract/protocol and persist beyond-UI intervals. \`scheduleRule: null\` is update's explicit-clear
 * semantic and also never combines with the carrier, else new-rule-vs-clear is undecidable.
 */
export function assertValidAutomationIntervalCarrier(input: {
  intervalUnit?: ZCodeAutomationIntervalUnit;
  interval?: number;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  relativeDelayMinutes?: number;
  recurring?: boolean;
  maxRuns?: number | null;
}): void {
  const { intervalUnit, interval, scheduleRule, relativeDelayMinutes, recurring, maxRuns } = input;
  if ((intervalUnit === undefined) !== (interval === undefined)) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit and interval must be submitted together or omitted together",
    );
  }
  if (
    interval !== undefined &&
    (!Number.isInteger(interval) || interval < 1 || interval > MAX_SESSION_AUTOMATION_INTERVAL)
  ) {
    throw new InvalidAutomationIntervalCarrierError("interval must be an integer 1-200");
  }
  if (intervalUnit !== undefined && relativeDelayMinutes !== undefined) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit is a recurrence carrier and excludes one-shot relativeDelayMinutes",
    );
  }
  if (intervalUnit !== undefined && scheduleRule !== undefined) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit carrier excludes a direct scheduleRule",
    );
  }
  // The carrier means loop-forever; allowing recurring=false or maxRuns would let the repository
  // end it as one-shot/finite after the first dispatch, leaving rule vs lifecycle contradictions.
  if (intervalUnit !== undefined && recurring === false) {
    throw new InvalidAutomationIntervalCarrierError("intervalUnit carrier requires recurring=true");
  }
  if (intervalUnit !== undefined && typeof maxRuns === "number") {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit carrier excludes a finite maxRuns",
    );
  }
}

/** Carrier updates must switch to infinite recurrence atomically, keeping rule and lifecycle in sync. */
export function forceIntervalCarrierRecurring(
  params: ZCodeAutomationUpdateParams,
): ZCodeAutomationUpdateParams {
  return { ...params, recurring: true, maxRuns: null };
}
