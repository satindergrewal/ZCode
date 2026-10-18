import type { TaskChatToolCall as ChatToolCall } from "@/lib/taskChatMessageTypes.js";
import {
  getToolCallCodeContentPreview,
  getToolCallCodePreview,
  type CodeViewerSource,
  type ImageCodeViewerSource,
  type PatchCodeViewerSource,
  type TextCodeViewerSource,
} from "@/lib/codeViewer.js";
import { isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import {
  isFileContentWriteToolCall,
  isFileDiffToolCall,
  resolveToolCallIdentity,
  type ToolCallIdentity,
} from "@/lib/toolIdentity.js";

export type ToolInlinePreview =
  | { type: "none" }
  | { type: "text"; source: TextCodeViewerSource }
  | { type: "patch"; source: PatchCodeViewerSource }
  | { type: "image"; source: ImageCodeViewerSource };

export interface ToolPlanResult {
  plan: string;
  planFilePath?: string;
}

export interface ToolDisplayModel {
  inlinePreview: ToolInlinePreview;
  planResult: ToolPlanResult | null;
  viewerSource: CodeViewerSource | null;
  viewerLabelId: "codeViewer.viewCode" | "codeViewer.viewDiff";
  showSummaryFileLink: boolean;
  showInput: boolean;
  showOutput: boolean;
  showKind: boolean;
}

interface ToolDisplayContext {
  toolCall: ChatToolCall;
  identity: ToolCallIdentity;
  preview: CodeViewerSource | null;
  contentPreview: TextCodeViewerSource | null;
  errorText?: string;
}

interface ToolDisplayStrategy {
  matches(context: ToolDisplayContext): boolean;
  build(context: ToolDisplayContext): Partial<ToolDisplayModel>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractToolPlanResultFromValue(
  value: unknown,
  workspacePath: string,
): ToolPlanResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawPlan = value["plan"];
  if (typeof rawPlan !== "string" || rawPlan.trim().length === 0) {
    return null;
  }

  const rawPlanFilePath = value["planFilePath"];
  const planFilePath =
    typeof rawPlanFilePath === "string" && rawPlanFilePath.trim().length > 0
      ? isAbsoluteFilePath(rawPlanFilePath)
        ? rawPlanFilePath
        : joinFilePath(workspacePath, rawPlanFilePath)
      : undefined;

  return {
    plan: rawPlan.trim(),
    planFilePath,
  };
}

function toInlinePreview(context: ToolDisplayContext, preferPatch: boolean): ToolInlinePreview {
  if (preferPatch && context.preview?.type === "patch") {
    return {
      type: "patch",
      source: context.preview,
    };
  }

  if (context.preview?.type === "image") {
    return {
      type: "image",
      source: context.preview,
    };
  }

  if (context.preview?.type === "text") {
    return {
      type: "text",
      source: context.preview,
    };
  }

  if (context.contentPreview) {
    return {
      type: "text",
      source: context.contentPreview,
    };
  }

  return { type: "none" };
}

const diffToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return isFileDiffToolCall(context.toolCall, context.identity);
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, true);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      showInput: !hasInlinePreview,
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const readToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "file-read";
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, false);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      // Read-tool titles usually already name the target file; adding a matched file to the
      // summary line would show it twice. Keep title + body preview only.
      showSummaryFileLink: false,
      showInput: !hasInlinePreview,
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const writeToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return isFileContentWriteToolCall(context.toolCall, context.identity);
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, false);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      showInput: !hasInlinePreview,
      // A successful Write output is usually just a structured ack; rendering it adds a pointless Result block.
      // The written content already lives in inlinePreview / the file summary; keep errors only.
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const genericImageStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.preview?.type === "image";
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, false);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      showInput: !hasInlinePreview,
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const executeToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "shell";
  },
  build(context) {
    return {
      inlinePreview: { type: "none" },
      showInput: false,
      showOutput: context.toolCall.output !== undefined || Boolean(context.errorText),
      showKind: false,
    };
  },
};

const searchToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "search";
  },
  build(context) {
    // Search/fetch inputs are usually just a query, path, or filter; users care about the hits.
    // The generic view expanded Parameters and Result together, pushing hits below the fold;
    // keep only result/error so the payload leads. The search scope is already visible in the
    // title/result, so another matched dir/file in the summary line would just repeat noise.
    return {
      inlinePreview: { type: "none" },
      showSummaryFileLink: false,
      showInput: false,
      showOutput: context.toolCall.output !== undefined || Boolean(context.errorText),
      showKind: false,
    };
  },
};

const goalToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "goal";
  },
  build(context) {
    // Goal tool input is a state mutation the model sends to the runtime, not a result to read.
    // The generic fallback spread Parameters, Result, and the whole raw blob, drowning the goal status in noise.
    return {
      inlinePreview: { type: "none" },
      showSummaryFileLink: false,
      showInput: false,
      showOutput: context.toolCall.output !== undefined || Boolean(context.errorText),
      showKind: false,
    };
  },
};

const nodeReplToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "node-repl";
  },
  build() {
    // Display semantics are normalized by the dedicated renderer from title/result/error; the generic
    // Parameters/Result/kind would expose tool internals and duplicate the dedicated result area.
    return {
      inlinePreview: { type: "none" },
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    };
  },
};

const TOOL_DISPLAY_STRATEGIES: ToolDisplayStrategy[] = [
  diffToolStrategy,
  readToolStrategy,
  writeToolStrategy,
  executeToolStrategy,
  searchToolStrategy,
  goalToolStrategy,
  nodeReplToolStrategy,
  genericImageStrategy,
];

export function buildToolDisplayModel(
  toolCall: ChatToolCall,
  workspacePath: string,
): ToolDisplayModel {
  const preview = getToolCallCodePreview(toolCall, workspacePath);
  const contentPreview = getToolCallCodeContentPreview(toolCall, workspacePath);
  const errorText = getToolCallErrorText(toolCall);
  const identity = resolveToolCallIdentity(toolCall);
  // The plan users care about comes from the tool result, not the input.
  // EnterPlanMode-style inputs can also carry plan/todo structures; falling back to input here
  // would render the same plan as a result and blur the real top-of-turn plan event's role.
  const planResult = extractToolPlanResultFromValue(toolCall.output, workspacePath);
  const context: ToolDisplayContext = {
    toolCall,
    identity,
    preview,
    contentPreview,
    errorText,
  };

  const defaultModel: ToolDisplayModel = {
    inlinePreview: { type: "none" },
    planResult,
    viewerSource: preview,
    viewerLabelId: preview?.type === "patch" ? "codeViewer.viewDiff" : "codeViewer.viewCode",
    showSummaryFileLink: Boolean(preview?.path),
    showInput: planResult ? false : toolCall.input !== undefined,
    showOutput: toolCall.output !== undefined || Boolean(errorText),
    showKind: true,
  };

  const matchedStrategy = TOOL_DISPLAY_STRATEGIES.find((strategy) => strategy.matches(context));

  // Tool display used to fork directly on `kind === "edit"`; the preview layer already recognizes
  // read/replace/image but the renderer never saw it, leaving scattered special cases. This converges
  // on "generic model + per-kind strategy overrides": new execute/search/fetch displays just add a strategy.
  const model = matchedStrategy
    ? {
        ...defaultModel,
        ...matchedStrategy.build(context),
      }
    : defaultModel;

  // Exit-plan results carry both the markdown plan and structured fields like allowedPrompts.
  // The generic JSON Result was unreadable in chat and duplicated the plan elsewhere; now `plan`
  // renders as this tool's dedicated result block, falling back to generic output only on error.
  if (planResult) {
    return {
      ...model,
      showInput: false,
      showOutput: Boolean(errorText),
    };
  }

  if (errorText) {
    return {
      ...model,
      // Showing Parameters on edit/write failure pushes the whole oldString/newString JSON up top
      // and buries the actual error. Collapse failures to the error view instead of dead arguments.
      inlinePreview: { type: "none" },
      showInput: false,
      showOutput: true,
      showKind: false,
    };
  }

  return model;
}
