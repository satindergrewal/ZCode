import { redactFeedbackText } from "@zcode/shared";
/**
 * Builds the description text template for task feedback.
 * All display strings go through formatMessage i18n.
 */
export function buildTaskFeedbackDescription({
  taskTitle,
  taskId,
  workspacePath,
  taskSessionPath,
  taskLogPath,
  formatMessage,
}: {
  taskTitle: string;
  taskId?: string;
  workspacePath: string;
  taskSessionPath?: string | null;
  taskLogPath?: string | null;
  formatMessage: (id: string, values?: Record<string, string>) => string;
}) {
  return redactFeedbackText(
    [
      formatMessage("feedback.submit.template.section.taskHeading"),
      "",
      formatMessage("feedback.submit.template.section.taskInfo"),
      formatMessage("feedback.submit.template.section.taskTitle", { title: taskTitle }),
      taskId ? formatMessage("feedback.submit.template.section.taskId", { id: taskId }) : null,
      formatMessage("feedback.submit.template.section.taskWorkspace", { path: workspacePath }),
      taskSessionPath
        ? formatMessage("feedback.submit.template.section.taskSessionPath", {
            path: taskSessionPath,
          })
        : null,
      taskLogPath
        ? formatMessage("feedback.submit.template.section.taskLogPath", { path: taskLogPath })
        : null,
      "",
      formatMessage("feedback.submit.template.section.problem"),
      formatMessage("feedback.submit.template.section.supplement"),
      "",
      formatMessage("feedback.submit.template.section.expectedResult"),
      formatMessage("feedback.submit.template.section.supplement"),
    ]
      .filter((line): line is string => line != null)
      .join("\n"),
  );
}
