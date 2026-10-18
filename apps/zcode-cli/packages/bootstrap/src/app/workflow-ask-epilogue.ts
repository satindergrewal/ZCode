// ============================================================
// The dwf ask's quality epilogue
// ============================================================
//
// A separate file: workflow-driver.ts is far past max-lines, and this piece is pure copy + one schema probe,
// unrelated to the driver's state machine.
//
// The epilogue used to branch on persona tool tiers -- zero-tool GLM subagents read "every finding
// cites what you read or ran" and went hunting for tools they did not have, emitting `escalate("placeholder")`.
// Tool tiers are gone entirely: every subagent
// has the full work toolset, and the epilogue is one text again.

/**
  * Every ask's quality epilogue: the content bar for results -- evidence,
  * the ran-vs-believed distinction, honest gaps, escalate when blocked. Added to typed and untyped alike; for typed,
  * a schema epilogue follows. When the schema's top-level properties include `evidence` / `confidence`, name those
  * fields; otherwise stay generic.
  * Format (this comment is the contract): two blank lines + divider + title line + bullet list.
 */
export function qualityEpilogue(schema: unknown): string {
  const fields = topLevelSchemaProperties(schema);
  return [
    "",
    "",
    "---",
    "Standard for this result:",
    "- Every finding cites what you read or ran: path and line for code; the exact command and its output for a check; the part of the ask for material the ask itself gave you.",
    "- A check counts as passed only if you ran it during this ask. Otherwise report it as not run.",
        // Subagents pick the fastest-greening command and call it "tests ran" -- the ask meant the whole suite, they ran one file;
        // the ask meant e2e, they ran unit tests. The contract only demands honesty; this line sets the scale: report the stand-in as a stand-in, naming what ran.
    "- Run the check the ask names, at the scale it names. A narrower or faster substitute — one test file for the suite, a build for the tests — is reported as what it is, never as the ask's check; say the exact command you ran.",
    "- Anything you could not do, verify, or find is stated as such — never filled with a plausible guess.",
    ...(fields.has("evidence") ? ["- Put each finding's citation in its `evidence` field."] : []),
    ...(fields.has("confidence")
      ? ["- Rate `confidence` honestly; a low value with a reason beats a confident guess."]
      : []),
    "- If you are blocked by something outside your reach, call `escalate` instead of inventing a value.",
  ].join("\n");
}

/** The key set of the schema's top-level `properties`; empty for non-object schemas or when absent. */
function topLevelSchemaProperties(schema: unknown): Set<string> {
  if (typeof schema !== "object" || schema === null) return new Set();
  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return new Set();
  return new Set(Object.keys(properties as Record<string, unknown>));
}
