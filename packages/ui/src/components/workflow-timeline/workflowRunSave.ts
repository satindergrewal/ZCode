// Pure logic for the completion card's save / run-again
// (docs/dynamic-workflow/transcript-and-notifications.md, Saving the run and running it again): name rule,
// destination preview, the message handed to ZCode.
//
// Split from the component for the same reason as globalWorkflowGroupHelpers: no React here, and these
// decisions deserve standalone tests.
import type { ZCodeSavedWorkflowScope } from "@zcode/shared";

/**
 * The name's legal shape, character-identical to the agent's isValidSavedWorkflowName (@zcode/contracts).
 * Restated here as a leading echo, not a reimplementation: every keystroke needs to know now whether the name
 * can be a file name, and that rule (charset + length + not dot/dotdot) is the path-traversal defense; neither
 * side may loosen it. The agent still rules; this only makes the message clear before the click.
 */
const SAVED_WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;
export const SAVED_WORKFLOW_NAME_MAX_CHARS = 64;

export function isValidSavedWorkflowNameText(name: string): boolean {
  if (name.length === 0 || name.length > SAVED_WORKFLOW_NAME_MAX_CHARS) return false;
  if (!SAVED_WORKFLOW_NAME_PATTERN.test(name)) return false;
  return name.replaceAll(".", "").length > 0;
}

/**
 * Destination preview. Project scope prints the relative path (what the user sees in their own repo); global
 * prints a home-dir path starting with ~, the AGENT machine's home, which is why remote projects offer no
 * global scope at all.
 */
export function savedWorkflowPathPreview(scope: ZCodeSavedWorkflowScope, name: string): string {
  const file = `${name}.dwf.ts`;
  return scope === "global" ? `~/.zcode/workflows/${file}` : `.zcode/workflows/${file}`;
}

export interface WorkflowSaveDraft {
  name: string;
  scope: ZCodeSavedWorkflowScope;
  description: string;
}

/**
 * The draft at popover-open. The name prefills only when the run name ITSELF is a legal file name: run names
 * are model-authored labels in the user's language (PR review - security/perf/arch), stuffing one into the name
 * box yields a guaranteed-invalid value. The description prefills the run name instead, that IS the one-line
 * what-this-workflow-does the hub card wants.
 */
export function initialWorkflowSaveDraft(input: {
  runName?: string;
  scope?: ZCodeSavedWorkflowScope;
}): WorkflowSaveDraft {
  const runName = input.runName?.trim() ?? "";
  return {
    name: isValidSavedWorkflowNameText(runName) ? runName : "",
    scope: input.scope ?? "project",
    description: runName,
  };
}

function isZh(locale: string): boolean {
  return locale.toLowerCase().startsWith("zh");
}

/**
 * The user message sent by have-ZCode-distill-and-save
 * (docs/dynamic-workflow/transcript-and-notifications.md The message the lead sends). Same precedent as the
 * hub's promote-to-global: the GUI writes and sends it, no second confirmation.
 *
 * Three things must be in it: distill, not copy (else this path equals plain save); the fields the user already
 * filled; and run_id, the ONLY durable link between this run and the definition saved under a model-chosen name
 * (launch.md SaveWorkflow). The script stays out, the model holds the call that started the run.
 */
export function buildWorkflowSaveRequestPrompt(input: {
  locale: string;
  runId: string;
  runName?: string;
  name: string;
  scope: ZCodeSavedWorkflowScope;
  description: string;
}): string {
  const name = input.name.trim();
  const description = input.description.trim();
  const runName = input.runName?.trim();
  if (isZh(input.locale)) {
    const target =
      input.scope === "global" ? '保存为全局工作流（scope: "global"）' : "保存到本项目";
    return [
      `请把刚跑完的工作流${runName ? `「${runName}」` : ""}提炼成可以复用的工作流，用 SaveWorkflow ${target}：`,
      "1. 脚本以这次运行实际执行的那一份为准，不要改动它的逻辑。",
      "2. 把两次运行之间会变化的值抽成 args（写好说明与合理默认值），并补齐 description 与 whenToUse。",
      name.length > 0 ? `3. 名字用 \`${name}\`。` : "3. 名字请你来取（只能用字母、数字和 - _ .）。",
      description.length > 0 ? `4. 说明可以参考：${description}` : "",
      `5. 调用 SaveWorkflow 时带上 run_id: "${input.runId}"——这次运行要据此认出自己已被保存。`,
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }
  const target =
    input.scope === "global"
      ? 'save it as a global workflow (scope: "global")'
      : "save it to this project";
  return [
    `Please distill the workflow that just finished${runName ? ` ("${runName}")` : ""} into a reusable one and ${target} with SaveWorkflow:`,
    "1. Use the script this run actually executed; do not change its logic.",
    "2. Lift the values that change between runs into args (with descriptions and sensible defaults), and write description and whenToUse.",
    name.length > 0
      ? `3. Name it \`${name}\`.`
      : "3. Pick the name yourself (letters, digits and - _ . only).",
    description.length > 0 ? `4. For the description, start from: ${description}` : "",
    `5. Pass run_id: "${input.runId}" to SaveWorkflow, so that run can tell it has been saved.`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
