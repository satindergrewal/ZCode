// ============================================================
// Context Builder Types
// ============================================================

import type {
  EnvInfo,
  Model,
  ModelInputMessage,
  ProjectContext,
  ResolvedUserInstructions,
  SkillLoadOutcome,
  UserInstructionsOptions,
} from "@zcode/contracts";
import type { AutoCompactPolicyConfig } from "../compact/index.js";
import type { AgentProfile } from "../subagent/profile.js";

export type {
  EnvInfo,
  PackageManager,
  ProjectContext,
  ProjectType,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
  UserInstructionsOptions,
} from "@zcode/contracts";

// -----------------------------------------------
// Context Source
// -----------------------------------------------

export type ContextSource =
  | "cli_prefix" // CLI / product identity prefix
  | "identity" // base agent description
  | "env_info" // environment info (cwd, platform, git repo boolean)
  | "system_context" // git snapshot context
  | "skills" // available skills
  | "tools" // tool definitions
  | "request_user_context" // request-level user context, provider-visible composite block
  | "memory" // long-term memory read path
  | "current_date" // current date
  | "custom_system_prompt" // custom stable system body
  | "workflow_actor_identity" // dynamic workflow subagent identity: contract plus persona overlay
  | "subagent_agent_prompt" // subagent-specific identity/task prompt
  | "subagent_notes" // general operating reminders for subagents
  | "subagent_environment" // subagent environment and model context
  | "dynamic_behavior" // dynamic behavior boundaries
  | "session_guidance" // guidance for currently available built-in capabilities
  | "output_style" // output style
  | "context_management" // long-context management guidance
  | "desktop_context"; // ZCode Desktop rendering and interaction protocol

export type ContextInjectionTarget = "system" | "meta_user";

export type ContextCacheHint = "stable" | "dynamic";

export type PresentationSurface = "terminal" | "zcode_desktop";

// -----------------------------------------------
// Context Section
// -----------------------------------------------

export interface ContextSection {
  name: string; // human-readable section name
  source: ContextSource; // origin marker
  injectionTarget: ContextInjectionTarget; // injection point
  cacheHint: ContextCacheHint; // cache-stability hint
  chars: number; // character count
  tokens: number; // estimated token count
  content: string; // full content
  preview: string; // first 100 characters
}

export type ContextMetaUserAttachmentSource = "skills_listing" | "context_prefix";

export interface ContextMetaUserAttachment {
  source: ContextMetaUserAttachmentSource;
  content: string;
}

// -----------------------------------------------
// Context Build Result
// -----------------------------------------------

export interface ContextBuildResult {
  sections: ContextSection[];
  totalChars: number;
  totalTokens: number;
  systemMessages: ModelInputMessage[]; // ContextBuilder assembles system messages only
  metaUserAttachments: ContextMetaUserAttachment[]; // meta user bodies not wrapped in <system-reminder>
}

export interface OutputStylePromptConfig {
  name: string;
  prompt: string;
  keepCodingInstructions?: boolean;
}

// -----------------------------------------------
// Context Builder Config
// -----------------------------------------------

export interface ContextBuilderConfig {
  workingDirectory: string;
  envInfo: EnvInfo;
  /** The executing target of the current step; never enters Context Source or the persisted environment snapshot. */
  model?: Model;
  presentationSurface?: PresentationSurface;
  genUiOutputDirectory?: string;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  projectContext?: ProjectContext;
  memoryRoot?: string;
  memoryIndexContent?: string;
  skills?: SkillLoadOutcome;
  agentProfiles?: readonly AgentProfile[];
  embeddedSearchEnabled?: boolean;
  skillMetadataBudget?: number;
  customSystemPrompt?: string;
  /**
   * Identity input for a dynamic workflow subagent (workflow child). When present, the builder takes its third path:
   * base sections (CLI prefix, safety line, Harness, memory) + the workflow-subagent contract + persona overlay,
   * rather than replacing everything like `customSystemPrompt`. Mutually exclusive with `customSystemPrompt`.
   */
  workflowActor?: WorkflowActorContext;
  language?: string;
  outputStyle?: OutputStylePromptConfig;
  compact?: AutoCompactPolicyConfig;
  guidanceToolNames?: readonly string[];
}

/**
 * Workflow-subagent identity input: effective name (absent for anonymous) and the author-written persona system prompt (optional).
 * No tool tiers: every subagent gets the full work toolset, so the contract is a single text.
 */
export interface WorkflowActorContext {
  name?: string;
  persona?: string;
}

export type ContextUserInstructionsRequest = UserInstructionsOptions;
