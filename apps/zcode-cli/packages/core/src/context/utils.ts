// ============================================================
// Token Estimation
// ============================================================

import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";

/**
 * Estimate the token count of a text.
 * Uses the shared character-estimate divisor; CJK characters keep extra weight.
 * This is a rough estimate, good enough for debugging and monitoring.
 */
export function estimateTokens(text: string): number {
  // CJK chars usually cost more tokens than Latin ones, so count each as two estimate chars.
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const otherChars = text.length - chineseChars;

  return Math.ceil((chineseChars * 2 + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}
