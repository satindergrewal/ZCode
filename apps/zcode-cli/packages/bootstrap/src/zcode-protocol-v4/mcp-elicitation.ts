import type { UserInputQuestionPayload } from "@zcode/shared/zcode-protocol-v4";

/**
 * MCP elicitation (server -> client `elicitation/create`) mapped onto the ZCode user-question channel
 // . Pure function: requestedSchema -> question list,
 // User answer -> ElicitResult.content. Shared by broker and product-projection, keeping live/v4 paths identical.
 */

/** Tool-name sentinel inside synthesized PermissionRequested events; projection and renderer key on it. */
export const MCP_ELICITATION_TOOL_NAME = "McpElicitation";
export const MCP_ELICITATION_INTERACTION = "mcp_elicitation";
/** A free-text question needs at least one option on the legacy userInput channel; this sentinel means "type it in". */
export const MCP_ELICITATION_FREE_TEXT_OPTION = "__zcode_free_text__";

export interface McpElicitationSchemaField {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "enum";
  title?: string;
  description?: string;
  enumValues?: string[];
  enumNames?: string[];
  required: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses the MCP `requestedSchema` (flat object, primitive-typed properties only); invalid properties skipped. */
export function readMcpElicitationFields(requestedSchema: unknown): McpElicitationSchemaField[] {
  if (!isRecord(requestedSchema) || !isRecord(requestedSchema.properties)) return [];
  const required = new Set(
    Array.isArray(requestedSchema.required)
      ? requestedSchema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const fields: McpElicitationSchemaField[] = [];
  for (const [name, raw] of Object.entries(requestedSchema.properties)) {
    if (!isRecord(raw)) continue;
    const enumValues = Array.isArray(raw.enum)
      ? raw.enum.filter((item): item is string => typeof item === "string")
      : undefined;
    const type = enumValues
      ? "enum"
      : raw.type === "number" || raw.type === "integer" || raw.type === "boolean"
        ? raw.type
        : raw.type === "string"
          ? "string"
          : null;
    if (!type) continue;
    fields.push({
      name,
      type,
      ...(typeof raw.title === "string" ? { title: raw.title } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(enumValues ? { enumValues } : {}),
      ...(Array.isArray(raw.enumNames)
        ? { enumNames: raw.enumNames.filter((item): item is string => typeof item === "string") }
        : {}),
      required: required.has(name),
    });
  }
  return fields;
}

/** Field -> user question; string/number use the free-text sentinel option, boolean Yes/No, enum its values. */
export function mcpElicitationQuestions(
  message: string,
  requestedSchema: unknown,
): UserInputQuestionPayload[] {
  const fields = readMcpElicitationFields(requestedSchema);
  if (fields.length === 0) {
    return [
      {
        header: "Answer",
        question: message,
        options: [{ value: MCP_ELICITATION_FREE_TEXT_OPTION, label: "Type your answer" }],
      },
    ];
  }
  return fields.map((field) => {
    const header = field.title ?? field.name;
    const question = field.description ?? `${message}\n\n${header}`;
    if (field.type === "boolean") {
      return {
        header,
        question,
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
      };
    }
    if (field.type === "enum" && field.enumValues && field.enumValues.length > 0) {
      return {
        header,
        question,
        options: field.enumValues.map((value, index) => ({
          value,
          label: field.enumNames?.[index] ?? value,
        })),
      };
    }
    return {
      header,
      question,
      options: [{ value: MCP_ELICITATION_FREE_TEXT_OPTION, label: "Type your answer" }],
    };
  });
}

function readAnswer(content: Record<string, unknown>, index: number, question: string): unknown {
  const indexed = content[`answer_${index}`];
  if (indexed !== undefined) return indexed;
  const answers = content.answers;
  if (isRecord(answers)) return answers[question];
  if (index === 0 && content.answer !== undefined) return content.answer;
  return undefined;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/** User answer -> MCP ElicitResult.content; converged by requestedSchema type, unconvetible fields omitted. */
export function mcpElicitationContentFromAnswers(
  requestedSchema: unknown,
  questions: UserInputQuestionPayload[],
  content: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!content) return {};
  const fields = readMcpElicitationFields(requestedSchema);
  const result: Record<string, unknown> = {};
  fields.forEach((field, index) => {
    const raw = firstString(readAnswer(content, index, questions[index]?.question ?? ""));
    if (raw === undefined || raw === MCP_ELICITATION_FREE_TEXT_OPTION) return;
    switch (field.type) {
      case "boolean":
        result[field.name] = raw === "true" || raw.toLowerCase() === "yes";
        return;
      case "number":
      case "integer": {
        const parsed = Number(raw);
        if (Number.isFinite(parsed))
          result[field.name] = field.type === "integer" ? Math.trunc(parsed) : parsed;
        return;
      }
      default:
        result[field.name] = raw;
    }
  });
  if (fields.length === 0) {
    const raw = firstString(readAnswer(content, 0, questions[0]?.question ?? ""));
    if (raw !== undefined && raw !== MCP_ELICITATION_FREE_TEXT_OPTION) result.answer = raw;
  }
  return result;
}
