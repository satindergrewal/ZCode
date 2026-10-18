// Prefilled prompts for the hub's create-via-chat / revise-in-chat actions.
// They are plain user messages: they prefill the draft without sending; the user continues with
// what to change / build. The promote-to-global prompt (buildSavedWorkflowPromotePrompt) is the
// exception: it goes out as createSession.firstInput and is **sent automatically**, so it is a full
// instruction, not a opener.

function isZh(locale: string): boolean {
  return locale.toLowerCase().startsWith("zh");
}

/** Revise-in-chat: prefills only, never auto-sends - the user adds what to change. */
export function buildSavedWorkflowRevisePrompt(input: {
  name: string;
  path: string;
  locale: string;
  scope?: "project" | "global";
}): string {
  // For global-scope revisions, append a keep scope global reminder so a later overwrite saves back into the same scope.
  const globalReminderZh =
    input.scope === "global" ? '它是全局工作流，保存时保持 scope: "global"。' : "";
  const globalReminderEn =
    input.scope === "global" ? 'It is a global workflow; keep scope: "global" when saving. ' : "";
  return isZh(input.locale)
    ? `请修订已保存的工作流「${input.name}」（${input.path}）：${globalReminderZh}`
    : `Please revise the saved workflow "${input.name}" (${input.path}): ${globalReminderEn}`;
}

/** Empty state / top-bar create-via-chat: prefill an opener. */
export function buildSavedWorkflowCreatePrompt(
  locale: string,
  scope?: "project" | "global",
): string {
  if (scope === "global") {
    return isZh(locale)
      ? '帮我设计一个工作流，跑通后用 SaveWorkflow 保存为全局工作流（scope: "global"）：'
      : 'Help me design a workflow and save it as a global workflow (scope: "global") with SaveWorkflow once it works: ';
  }
  return isZh(locale)
    ? "帮我设计一个工作流，跑通后保存到本项目："
    : "Help me design a workflow and save it to this project once it works: ";
}

/**
 * Promote-to-global: the full instruction generalizing a project workflow into a global one
 * (auto-sent, not a prefilled opener).
 *
 * Only name and path are given; the model reads the file itself. The checklist is user-ratified:
 * read -> find repo-specific references -> lift into args or neutral phrasing -> keep the causal
 * structure -> SaveWorkflow(scope global, name may change) -> summarize; declining is allowed when
 * the workflow is inherently project-bound. Say explicitly not to touch the original file: the two
 * copies coexist and the user deletes theirs - invariant 9.
 */
export function buildSavedWorkflowPromotePrompt(input: {
  name: string;
  path: string;
  locale: string;
}): string {
  if (isZh(input.locale)) {
    return [
      `请把已保存的项目工作流「${input.name}」（${input.path}）提升为全局工作流。全局工作流对所有项目可见、在任何项目里都能运行，所以它不能依赖本仓库的任何东西。请按下面的步骤做：`,
      "1. 读取这个文件，理解它的因果结构（哪些子代理、什么顺序、什么交接）。",
      "2. 找出所有引用本仓库的地方：具体路径、命令、目录结构、命名约定、分支名等。",
      "3. 把它们抽成 `args` 声明（带说明与合理默认值），或改成不依赖项目的中性表述；保持因果结构不变。",
      '4. 用 SaveWorkflow 以 scope: "global" 保存。名字可以沿用，也可以取一个更贴切的名字。不要改动原来的项目工作流文件。',
      "5. 最后用几句话总结你概括了什么、哪些点被抽成了参数。",
      "如果这个工作流本质上就绑定在这个项目上、无法有意义地概括，请说明原因并停下，不要保存。",
    ].join("\n");
  }
  return [
    `Promote the saved project workflow "${input.name}" (${input.path}) to a global workflow. Global workflows are visible to every project and can run from any of them, so it must not depend on anything in this repository. Follow these steps:`,
    "1. Read the file and understand its causal structure (which subagents, in what order, with what hand-offs).",
    "2. Find everything that refers to this repository: concrete paths, commands, directory layout, naming conventions, branch names, and so on.",
    "3. Lift those into `args` declarations (with descriptions and sensible defaults) or rewrite them in project-neutral terms, keeping the causal structure intact.",
    '4. Save it with SaveWorkflow using scope: "global". Keep the name or pick a better one. Do not modify the original project workflow file.',
    "5. Finish with a short summary of what you generalized and which points became arguments.",
    "If the workflow is inherently bound to this project and cannot be generalized meaningfully, say why and stop without saving.",
  ].join("\n");
}
