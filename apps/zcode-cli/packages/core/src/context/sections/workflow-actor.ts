// ============================================================
// Workflow Actor Identity Section Builder
// ============================================================
//
// Identity section for dynamic workflow subagents (workflow children).
//
// It replaces the interactive Agent Identity ("You are an interactive ZCode agent that helps
// users"): a subagent's audience is scripts, not humans. It does **not** replace the other base sections — the safety IMPORTANT line and
// the `# Harness` block are reused verbatim from identity; memory / skills / project instructions are appended by the builder as usual.
// The author's persona is layered after the opening line and before the contract: role before generic rules, more prominent — but the opening line first pins down
// who the subagent is and who it outputs to, and the persona cannot overturn that.
//
// The contract once branched on the persona's tool tier; in production a zero-tool GLM subagent was
// pushed by "Ground every claim in something you read or ran" into listing dirs and running commands it had no tools for,
// and emitted a degenerate `escalate("placeholder")`. The fix is to **state the tool surface explicitly**: the subagent learns what it has first,
// then where evidence comes from. With tool tiers gone,
// every subagent has the full work toolset and the contract is one text again; the state-the-tool-surface principle stands.

import type { ContextSection, WorkflowActorContext } from "../types.js";
import { estimateTokens } from "../utils.js";
import { buildHarnessBlock, buildSecurityNotice } from "./identity.js";

/** Tool-surface self-description: one line for what exists, one for what does not, so the model never guesses. */
const TOOL_SURFACE =
  "You have the regular working tools — reading, searching, editing, running commands — plus `submit_result` and `escalate`. There is no tool that asks a person anything.";

/** Evidence bar: cite what was read/run, or the material shipped with the ask; only runs count, at the scale the ask names. */
const EVIDENCE_RULE =
    // "Only runs count" governs honesty, not scale —
    // in production subagents substituted one test file or one build for the whole suite the ask named. This line governs scale.
  "Ground every claim in something you read or ran in this session, or in the material the ask gave you, and say which. Cite code as `path:line`. A check counts as passed only if you executed it here; if you could not run it, report it as not run. Run the check an ask names rather than a faster substitute, and say exactly which command you ran.";

function buildWorkflowContract(): string {
  return [
    "# Working inside a workflow",
    `- ${TOOL_SURFACE}`,
    "- Each ask states what to do. When the ask carries a result schema, finish by calling `submit_result` with a conforming value; otherwise your final message is the result.",
    `- ${EVIDENCE_RULE}`,
    "- Report outcomes faithfully. If part of the task is impossible, out of scope, or contradicted by what you found, say so in the result instead of filling a field with a plausible guess. Never fake a passing result to satisfy an instruction.",
    "- When you are blocked by something outside your reach — a gate that cannot pass, instructions that contradict each other, a fact only the run's owner knows — call `escalate`. Questions written in prose reach nobody.",
        // The artifact clause turns "files written by the subagent" from discouraged-and-untracked
        // into a sanctioned escape hatch: subagents still have no artifact tools (only the script publishes; trust boundary unchanged), but
        // when the ask names an output path, write there and hand the path back; the script publishes it to the user.
    "- Do not write report or summary files on your own initiative; findings go in the result. When the ask names an output path, write exactly there and return that path in the result — the script publishes it to the user.",
  ].join("\n");
}

function buildWorkflowActorIdentityPrompt(actor: WorkflowActorContext): string {
  const name = actor.name?.trim();
  const named = name ? `, named "${name}"` : "";
  const opening = [
    `You are a subagent inside a dynamic workflow run${named}. A script created you and hands you work one ask at a time; the script — not a person — consumes what you return. There is no user in this conversation to talk to.`,
  ];
  const persona = actor.persona?.trim();
    // No CLI prefix precedes this anymore ("You are ZCode, an interactive coding agent"
    // is the wrong identity for a subagent), so this section is the system's first line and no longer starts with a blank line.
  const parts = [
    opening.join("\n"),
    ...(persona ? ["", persona] : []),
    "",
    buildSecurityNotice(),
    "",
    buildHarnessBlock(),
    "",
    buildWorkflowContract(),
  ];
  return parts.join("\n");
}

export function buildWorkflowActorIdentitySection(actor: WorkflowActorContext): ContextSection {
  const content = buildWorkflowActorIdentityPrompt(actor);
  return {
    name: "Workflow Actor Identity",
    source: "workflow_actor_identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
