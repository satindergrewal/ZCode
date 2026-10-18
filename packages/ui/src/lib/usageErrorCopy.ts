import type { IntlInstance } from "@/i18n/IntlProvider.js";

type UsageErrorSurface = "chatPlan" | "entitlement" | "stats";

const CREDENTIAL_ERROR_PATTERNS = [
  /token\s+(expired|incorrect)/i,
  /expired.*token/i,
  /incorrect.*token/i,
  /invalid.*(?:api\s*)?key/i,
  /(?:api\s*)?key.*invalid/i,
  /unauthorized/i,
  /forbidden/i,
  /\b40[13]\b/,
  /认证|鉴权|授权|密钥|无效|过期/i,
];

// Team-plan business errors (enterprise-admin-only notices, missing team-plan authorization when
// creating API keys, etc.) are explicit remote rejections and must be shown verbatim. The
// authorization-record wording contains the credential keyword, so running the credential check
// first would misroute it to translated copy + a check-key button; business errors match first.
const TEAM_PLAN_BUSINESS_ERROR_PATTERNS = [
  /企业主账号/,
  /团队套餐/,
  /无法创建API\s*Key/i,
  /授权记录/,
];

export function isUsageTeamPlanBusinessError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return TEAM_PLAN_BUSINESS_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function isUsageCredentialError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return CREDENTIAL_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatUsageErrorMessage(
  intl: IntlInstance,
  surface: UsageErrorSurface,
  error: string | null | undefined,
): string {
  // Team-plan business errors are explicit remote rejections; generic copy would hide the real
  // cause and leave users guessing permission vs network. This must run before the credential
  // check: the team-plan authorization message contains the credential keyword and would be misrouted.
  if (isUsageTeamPlanBusinessError(error) && error?.trim()) {
    return error.trim();
  }

  // Provider APIs return auth errors that give users no next step. Translate recoverable
  // key/OAuth problems into actionable checks here; callers still log the original error.
  if (isUsageCredentialError(error)) {
    return intl.formatMessage({ id: `usage.error.${surface}.credential` });
  }

  return intl.formatMessage({ id: `usage.error.${surface}.generic` });
}
