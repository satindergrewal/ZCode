/**
 * IDs, URLs, keys, and JSON in Provider/Model config are technical fields, not natural language.
 * Disable spellcheck and autocorrect uniformly so model ids never get misleading red squiggles or system rewrites.
 */
export const TECHNICAL_INPUT_ATTRIBUTES = {
  autoCapitalize: "none",
  autoComplete: "off",
  autoCorrect: "off",
  spellCheck: false,
} as const;
