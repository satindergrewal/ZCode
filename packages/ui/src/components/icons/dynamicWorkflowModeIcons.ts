import { createLucideIcon, type IconNode } from "lucide-react";

// Icons for the three dynamic-workflow modes (docs/dynamic-workflow/launch.md The user's choice): all grown
// from Lucide Workflow's boxes and edges, rendered via Lucide to inherit theme foreground, stroke width and layer opacity.
const WORKFLOW_FIRST_BOX_AND_LINK: IconNode = [
  ["rect", { width: "8", height: "8", x: "3", y: "3", rx: "2", key: "first" }],
  ["path", { d: "M7 11v4a2 2 0 0 0 2 2h4", key: "link" }],
];
const WORKFLOW_SECOND_BOX: IconNode[number] = [
  "rect",
  { width: "8", height: "8", x: "13", y: "13", rx: "2", key: "second" },
];

/** Always on: the full workflow. */
export const DynamicWorkflowAlwaysOnIcon = createLucideIcon("DynamicWorkflowAlwaysOn", [
  ...WORKFLOW_FIRST_BOX_AND_LINK,
  WORKFLOW_SECOND_BOX,
]);

/** Enabled via command: second box dashed, lands only once commanded. */
export const DynamicWorkflowOnCommandIcon = createLucideIcon("DynamicWorkflowOnCommand", [
  ...WORKFLOW_FIRST_BOX_AND_LINK,
  [
    "rect",
    { width: "8", height: "8", x: "13", y: "13", rx: "2", strokeDasharray: "2 2", key: "second" },
  ],
]);

/** Off: the workflow plus a slash. */
export const DynamicWorkflowOffIcon = createLucideIcon("DynamicWorkflowOff", [
  ...WORKFLOW_FIRST_BOX_AND_LINK,
  WORKFLOW_SECOND_BOX,
  ["path", { d: "M4 20 20 4", key: "slash" }],
]);
