import type { PermissionOptionsPolicy, PermissionUpdate } from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME, type ZCodePermissionOption } from "@zcode/shared";

const PROJECT_RULE_INPUT_KEYS = ["command", "url", "file_path", "path", "pattern"] as const;

// A user rejection of a normal interactive permission must tell the model the tool did not run
// and await further instructions; that reason doubles as the provider-visible tool_result.content.
export const PERMISSION_DENIED_BY_USER_CONTENT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

export function buildPermissionDeniedContent(feedback?: string): string {
  const trimmed = feedback?.trim();
  return trimmed
    ? `${PERMISSION_DENIED_BY_USER_CONTENT} To tell you how to proceed, the user said:\n${trimmed}`
    : PERMISSION_DENIED_BY_USER_CONTENT;
}

/**
 * Identity, internal kind, and display name of a session-grant option.
 * optionId passes through the v4 wire untouched (the broker matches on it exactly); kind is a CLI-internal value the v4 projection maps into
 * the closed-set `allowAlways`; name is the GUI localization match key (PermissionDialog's global name map).
 */
const SESSION_ALLOW_PERMISSION_OPTION_ID = "allowSession";
export const SESSION_ALLOW_PERMISSION_OPTION_KIND = "allow_session";
const SESSION_ALLOW_PERMISSION_OPTION_NAME = "Always allow in this session";

interface PermissionOptionSource {
  approvalMode?: "user-once";
  input?: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  optionsPolicy?: PermissionOptionsPolicy;
  toolName: string;
}

/**
 * Pure permission-option projection shared by v3 and v4; kept outside the protocol dir so v4's authority projection never depends back on the legacy protocol.
 */
export function buildProtocolPermissionOptions(
  source: PermissionOptionSource,
): ZCodePermissionOption[] {
  const permissionUpdates = source.suggestedPermissionUpdates?.length
    ? source.suggestedPermissionUpdates
    : defaultPermissionUpdates(source);
  const officialCuaProjectScope = permissionUpdates.some((update) =>
    update.rules.some((rule) => rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME),
  );
  const options: ZCodePermissionOption[] = [
    {
      kind: "allow_once",
      name: "Allow once",
      optionId: "allow_once",
      response: {
        decision: "allow",
        reason: "Approved once",
      },
    },
    // Tools may declare no-always-allow: when every call is different code, a persistent rule is not "remember this decision"
    // but permanently disabling this prompt. session-always-allow instead becomes session-scoped confirmation-free runs: the response
    // carries **no** permissionUpdates -- the wire's zcodePermissionUpdateSchema is strict, so session semantics are
    // synthesized by the broker on the response side as sessionPermissionUpdates (in-memory only, never project rules).
    ...(source.optionsPolicy === "no-always-allow"
      ? []
      : source.optionsPolicy === "session-always-allow"
        ? [
            {
              description: "Do not ask again for this tool in this session",
              kind: SESSION_ALLOW_PERMISSION_OPTION_KIND,
              name: SESSION_ALLOW_PERMISSION_OPTION_NAME,
              optionId: SESSION_ALLOW_PERMISSION_OPTION_ID,
              response: {
                decision: "allow" as const,
                reason: "Approved for this session",
              },
            },
          ]
        : [
            {
              description: officialCuaProjectScope
                ? "Do not ask again for official Computer Use tools in this project"
                : "Do not ask again for matching requests in this project",
              kind: "allow_always" as const,
              name: officialCuaProjectScope
                ? "Always allow Computer Use in this project"
                : "Always allow in this project",
              optionId: "allow_project",
              response: {
                decision: "allow" as const,
                permissionUpdates,
                reason: "Approved for this project",
              },
            },
          ]),
    {
      kind: "deny",
      name: "Deny",
      optionId: "deny",
      response: {
        decision: "deny",
        reason: PERMISSION_DENIED_BY_USER_CONTENT,
      },
    },
  ];
  return source.approvalMode === "user-once"
    ? options.filter((option) => option.kind === "allow_once" || option.kind === "deny")
    : options;
}

/**
 * Session grants apply to the tool as a whole (no ruleContent): scripts differ every run, so what is granted is "this tool", not a script snippet.
 */
export function buildSessionPermissionUpdates(toolName: string): PermissionUpdate[] {
  return [{ behavior: "allow", rules: [{ toolName }], type: "addRules" }];
}

/**
 * Legacy v3 (session-mapper, the broker's v3 reverse RPC) does not understand session semantics: old desktops return the option
 * response verbatim, so presenting session options yields a misleading "allow once". Both strategies therefore
 * degrade to "strip always allow" on legacy.
 */
export function toLegacyPermissionOptionsPolicy(policy: unknown): "no-always-allow" | undefined {
  switch (policy) {
    case "no-always-allow":
    case "session-always-allow":
      return "no-always-allow";
    default:
      return undefined;
  }
}

function defaultPermissionUpdates(source: PermissionOptionSource): PermissionUpdate[] {
  const ruleContent = ruleContentFromPermissionInput(source.input);
  return [
    {
      behavior: "allow",
      rules: [
        {
          toolName: source.toolName,
          ...(ruleContent ? { ruleContent } : {}),
        },
      ],
      type: "addRules",
    },
  ];
}

function ruleContentFromPermissionInput(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim().length > 0) {
    return input;
  }

  const record = asRecord(input);
  for (const key of PROJECT_RULE_INPUT_KEYS) {
    const value = stringField(record, key);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
