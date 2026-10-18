/**
 * zcode-plan / Coding Plan business error codes and frontend handling.
 *
 * | Scenario            | Code     | HTTP | Frontend handling                                 |
 * |---------------------|----------|------|---------------------------------------------------|
 * | Missing/invalid JWT | 1006     | 200  | Go to login or re-authorize                       |
 * | Quota exhausted     | 1005     | 200  | Disable entry, refresh quota                      |
 * | Model unavailable   | 3006     | 400  | Switch to another Built-in Provider model         |
 * | Bad parameters      | 3001     | 400  | Check request body                                |
 * | Safety check denied | 3007     | 403  | Client cannot pass check; suggest contacting support |
 * | Model concurrency   | 3010     | 429  | Upgrade banner under Start Plan                   |
 * | Too many requests   | 3002/429 | 429  | Rate-limit notice, retry later                    |
 * | Off-peak ticket N/A | 3102     | 400  | Segment runtime capped; start a new off-peak task |
 * | Upstream HTTP error | 2007     | 500  | Retryable; refresh quota, no local deduction      |
 */
import { isOffPeakTicketExpiredError } from "@zcode/shared";

const PROVIDER_BUSINESS_ERROR_CODES = [
  "1006",
  "1005",
  "3006",
  "3001",
  "3007",
  "3008",
  "3009",
  "3010",
  "3002",
  "3102",
  "2007",
  "429",
] as const;

type ProviderBusinessErrorCode = (typeof PROVIDER_BUSINESS_ERROR_CODES)[number];

export type ProviderBusinessErrorUiAction =
  | "login"
  | "refresh-quota"
  | "switch-model"
  | "retry-later"
  | "upgrade";

const PROVIDER_BUSINESS_ERROR_MESSAGE_IDS: Record<ProviderBusinessErrorCode, string> = {
  "1006": "zcode.error.providerBusiness.1006",
  "1005": "zcode.error.providerBusiness.1005",
  "3006": "zcode.error.providerBusiness.3006",
  "3002": "zcode.error.providerBusiness.3002",
  "3001": "zcode.error.providerBusiness.3001",
  "3007": "zcode.error.providerBusiness.3007",
  "3008": "zcode.error.providerBusiness.3008",
  "3009": "zcode.error.providerBusiness.3009",
  "3010": "zcode.error.providerBusiness.3010",
  "3102": "zcode.error.providerBusiness.3102",
  "2007": "zcode.error.providerBusiness.2007",
  "429": "zcode.error.providerBusiness.429",
};

const PROVIDER_BUSINESS_ERROR_UI_ACTIONS: Record<
  ProviderBusinessErrorCode,
  ProviderBusinessErrorUiAction | null
> = {
  "1006": "login",
  "1005": "refresh-quota",
  "3006": "switch-model",
  "3001": null,
  // 3007 safety-check rejection: the client cannot complete the check; no actionable recovery.
  "3007": null,
  // 3008/3009/3010 concurrency cap: upgrade banner under Start Plan, upgrade action otherwise
  "3008": "upgrade",
  "3009": "upgrade",
  "3010": "upgrade",
  "3002": "retry-later",
  // 3102 off-peak ticket unavailable: only a new off-peak task resumes it; banner retry/model-switch will not.
  "3102": null,
  "2007": "retry-later",
  "429": "retry-later",
};

export function isProviderBusinessErrorCode(
  code: string | undefined,
): code is ProviderBusinessErrorCode {
  if (!code) {
    return false;
  }
  return (PROVIDER_BUSINESS_ERROR_CODES as readonly string[]).includes(code);
}

export function getProviderBusinessErrorMessageId(code: string | undefined): string | undefined {
  if (!isProviderBusinessErrorCode(code)) {
    return undefined;
  }
  return PROVIDER_BUSINESS_ERROR_MESSAGE_IDS[code];
}

export function getProviderBusinessErrorUiAction(
  code: string | undefined,
): ProviderBusinessErrorUiAction | null {
  if (!isProviderBusinessErrorCode(code)) {
    return null;
  }
  return PROVIDER_BUSINESS_ERROR_UI_ACTIONS[code];
}

const START_PLAN_QUOTA_EXHAUSTED_WRAPPER_CODES = new Set([
  "PROVIDER_BUSINESS_ERROR",
  "SEND_FAILED",
  "unknown_error",
]);

export function resolveStartPlanQuotaExhaustedBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "1005" | undefined {
  if (code === "1005") {
    return "1005";
  }

  const normalizedCode = code?.trim();
  const normalizedMessage = message?.trim().toLowerCase();
  if (!normalizedMessage) {
    return undefined;
  }

  // Legacy running/history tasks keep only the outer error code: the real providerCode=1005 is
  // squashed into PROVIDER_BUSINESS_ERROR / SEND_FAILED / unknown_error + "exceed limit/exceed quota limit".
  // ChatView calls this only inside the Start Plan provider boundary, so other providers' same-named errors are unaffected.
  if (
    (normalizedMessage.includes("exceed limit") ||
      normalizedMessage.includes("exceed quota limit") ||
      normalizedMessage.includes("quota exceeded")) &&
    (!normalizedCode || START_PLAN_QUOTA_EXHAUSTED_WRAPPER_CODES.has(normalizedCode))
  ) {
    return "1005";
  }

  return undefined;
}

const CONCURRENT_LIMIT_WRAPPER_CODES = new Set([
  "PROVIDER_BUSINESS_ERROR",
  "SEND_FAILED",
  "unknown_error",
  "MODEL_RATE_LIMITED",
]);

const CONCURRENT_LIMIT_MESSAGE_PATTERNS = ["concurrent", "concurrency", "并发"];

const MODEL_SCOPED_CONCURRENT_LIMIT_MESSAGE_PATTERNS = ["model", "模型"];

export const START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE =
  "Start Plan is busy and automatic model stream recovery reached the maximum retry count.";

export type StartPlanConcurrentLimitBannerReason = "initial-busy" | "retry-exhausted-busy";

export const GLM_QUOTA_BANNER_BUSINESS_CODES = [
  "1308",
  "1309",
  "1310",
  "1311",
  "1313",
  "1314",
  "1315",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
] as const;

export type GlmQuotaBannerBusinessCode = (typeof GLM_QUOTA_BANNER_BUSINESS_CODES)[number];

const GLM_QUOTA_BANNER_BUSINESS_CODE_SET = new Set<string>(GLM_QUOTA_BANNER_BUSINESS_CODES);

/**
 * Whether this is a concurrency-cap business error (3008/3009/3010).
 * On Start Plan, hit means the concurrency upgrade banner instead of the plain error banner.
 */
export function resolveStartPlanConcurrentLimitBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3008" | "3009" | "3010" | undefined {
  if (code === "3008") {
    return "3008";
  }
  if (code === "3009") {
    return "3009";
  }
  if (code === "3010") {
    return "3010";
  }

  const normalizedCode = code?.trim();
  const normalizedMessage = message?.trim().toLowerCase();
  if (!normalizedMessage) {
    return undefined;
  }

  // Fallback: legacy paths may squash 3008/3009/3010 into a wrapper code plus concurrency wording.
  // Some historical tasks persist only unknown_error + "model concurrency limit exceeded";
  // those are model-level concurrency and must not degrade to blocking 3008, or the composer stays locked after recovery.
  if (
    CONCURRENT_LIMIT_MESSAGE_PATTERNS.some((pattern) => normalizedMessage.includes(pattern)) &&
    (!normalizedCode || CONCURRENT_LIMIT_WRAPPER_CODES.has(normalizedCode))
  ) {
    return MODEL_SCOPED_CONCURRENT_LIMIT_MESSAGE_PATTERNS.some((pattern) =>
      normalizedMessage.includes(pattern),
    )
      ? "3009"
      : "3008";
  }

  return undefined;
}

export function resolveGlmQuotaBannerBusinessCode(
  code: string | undefined,
): GlmQuotaBannerBusinessCode | undefined {
  const normalizedCode = code?.trim();
  if (normalizedCode && GLM_QUOTA_BANNER_BUSINESS_CODE_SET.has(normalizedCode)) {
    // GLM API 1308/1309/1310/1311/1313-1321 are all quota, plan, or account usage boundaries;
    // the upgrade entry must not be covered by the plain error banner.
    return normalizedCode as GlmQuotaBannerBusinessCode;
  }
  return undefined;
}

export function resolveStartPlanConcurrentLimitBannerReason(
  message: string | undefined,
): StartPlanConcurrentLimitBannerReason {
  return message?.trim() === START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE
    ? "retry-exhausted-busy"
    : "initial-busy";
}

/** Keep in sync with the anomaly-guard copy in core `model-errors.ts`. */
export const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

/**
 * Off-peak ticket unavailable (upstream 3102: ticket invalid or expired).
 * The adapter wraps the code as `off-peak-ticket-expired: <upstream message>` inside the turn error;
 * when the outer code is squashed into wrappers like PROVIDER_BUSINESS_ERROR, rely on the stable marker,
 * otherwise the banner surfaces the raw "off peak ticket is invaliad or expired" text.
 */
export function resolveOffPeakTicketExpiredBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3102" | undefined {
  if (code?.trim() === "3102") {
    return "3102";
  }
  return isOffPeakTicketExpiredError(message) ? "3102" : undefined;
}

export function isSuspiciousEmptyModelResultMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return (
    message.includes(SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE) ||
    message.includes("Model returned no text")
  );
}
