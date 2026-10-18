// ============================================================
// Automation Port - scheduled task management boundary
// ============================================================

import type {
  CronAutomation,
  CronCreateInput,
  CronDeleteInput,
  CronUpdateInput,
} from "../tools/automation.js";

export const AUTOMATION_CREATE_LIMIT_ERROR_CODE = "AUTOMATION_CREATE_LIMIT_REACHED";

export class AutomationCreateLimitError extends Error {
  readonly code = AUTOMATION_CREATE_LIMIT_ERROR_CODE;
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AutomationCreateLimitError";
    this.cause = cause;
  }
}

export function isAutomationCreateLimitError(error: unknown): error is AutomationCreateLimitError {
  if (error instanceof AutomationCreateLimitError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === AUTOMATION_CREATE_LIMIT_ERROR_CODE ||
    (typeof candidate.message === "string" &&
      candidate.message.includes(AUTOMATION_CREATE_LIMIT_ERROR_CODE))
  );
}

export interface AutomationCreateContext {
  /** Model of the runtime hosting this tool call; injected by the executor, never from model input. */
  model?: string;
  /** Session hosting this tool call; later in-session cron firings reuse it. */
  sessionId?: string;
}

export interface AutomationPort {
  create(input: CronCreateInput, context?: AutomationCreateContext): Promise<CronAutomation>;
  update(input: CronUpdateInput): Promise<CronAutomation>;
  list(): Promise<CronAutomation[]>;
  delete(input: CronDeleteInput): Promise<boolean>;
}
