import { Cron } from "croner";

/** Validate a cron expression (5 fields, local timezone). */
export function isValidCronExpr(cronExpr: string): boolean {
  try {
    // croner parses at construction; invalid expressions throw.
    new Cron(cronExpr);
    return true;
  } catch {
    return false;
  }
}
