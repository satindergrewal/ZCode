import type { z } from "zod";
import type { ConfigValidationIssue } from "../config-overlay.js";

/** Translates the existing issue protocol; keeps no second field/content validation list. */
export function validateConfigSchema(
  schema: z.ZodType,
  value: unknown,
  path: readonly string[],
  optionSpec = false,
): readonly ConfigValidationIssue[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue): ConfigValidationIssue => {
    const issuePath = [...path, ...issue.path.map(String)];
    let fieldValue: unknown = value;
    for (const key of issue.path) {
      fieldValue =
        fieldValue !== null && typeof fieldValue === "object"
          ? Reflect.get(fieldValue, key)
          : undefined;
    }
    // Zod reports missing literal/enum as invalid_value; keep the legacy 'missing field'
    // issue classification.
    const missing =
      ((issue.code === "invalid_type" || issue.code === "invalid_value") && fieldValue == null) ||
      (issue.code === "custom" && issue.params?.configIssueCode === "required-field-missing");
    const invalidUrl = issue.code === "invalid_format" && issue.format === "url";
    return {
      code: missing
        ? "required-field-missing"
        : invalidUrl
          ? "invalid-url"
          : optionSpec || issue.path.includes("optionSpecs")
            ? "invalid-option-spec"
            : "invalid-config",
      path: issuePath,
      message: missing
        ? `Missing required config ${issuePath.join(".")}`
        : invalidUrl
          ? `Config ${issuePath.join(".")} must be a valid URL`
          : issue.message,
    };
  });
}
