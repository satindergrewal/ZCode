import type { Model, ModelInputMessage } from "@zcode/contracts";
import { ContextBuilder } from "../context/builder.js";
import {
  buildContextMetaUserBody,
  buildSkillsMetaUserBody,
  type ContextBuilderConfig,
  type ContextBuildResult,
  type ContextSection,
  type EnvInfo,
} from "../context/index.js";
import { buildCliPrefixSection } from "../context/sections/cli-prefix.js";
import { buildCurrentDateSection } from "../context/sections/current-date.js";
import { buildRequestUserContextSection } from "../context/sections/request-user-context.js";
import { buildSkillsSection } from "../context/sections/skills.js";
import { estimateTokens } from "../context/utils.js";
import { buildSubagentCommonNotes, buildSubagentEnvironmentContext } from "./system-prompt.js";

export interface SubagentContextBuilderConfig {
  agentPrompt: string;
  currentDate?: string;
  envInfo: EnvInfo;
  model?: Model;
  skillMetadataBudget?: number;
  skills?: ContextBuilderConfig["skills"];
  userInstructions?: ContextBuilderConfig["userInstructions"];
}

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };

export class SubagentContextBuilder extends ContextBuilder {
  private subagentConfig: SubagentContextBuilderConfig;

  constructor(config: SubagentContextBuilderConfig) {
    super(toBaseContextBuilderConfig(config));
    this.subagentConfig = config;
  }

  override setEnvInfo(envInfo: EnvInfo): this {
    this.subagentConfig = {
      ...this.subagentConfig,
      envInfo,
    };
    return this;
  }

  override build(): ContextBuildResult {
    const sections = buildSubagentContextSections(this.subagentConfig);
    const orderedSections = orderSubagentSections(sections);
    const totalChars = orderedSections.reduce((sum, section) => sum + section.chars, 0);
    const totalTokens = orderedSections.reduce((sum, section) => sum + section.tokens, 0);
    const systemSections = orderedSections.filter(
      (section) => section.injectionTarget === "system",
    );
    // Per-segment markers would exhaust the cache-breakpoint budget and drop trailing markers; the merged body keeps each segment's own newlines.
    const systemMessages = [
      systemSections.filter((section) => section.source === "cli_prefix"),
      systemSections.filter((section) => section.source !== "cli_prefix"),
    ]
      .filter((group) => group.length > 0)
      .map(
        (group): ModelInputMessage => ({
          role: "system",
          content: group.map((section) => section.content).join(""),
          cacheControl: EPHEMERAL_CACHE_CONTROL,
        }),
      );
    const skillsContent = buildSkillsMetaUserBody(
      orderedSections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source === "skills",
      ),
    );
    const contextContent = buildContextMetaUserBody(
      orderedSections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source !== "skills",
      ),
    );

    return {
      sections: orderedSections,
      totalChars,
      totalTokens,
      systemMessages,
      metaUserAttachments: [
        ...(skillsContent
          ? [
              {
                source: "skills_listing" as const,
                content: skillsContent,
              },
            ]
          : []),
        ...(contextContent
          ? [
              {
                source: "context_prefix" as const,
                content: contextContent,
              },
            ]
          : []),
      ],
    };
  }
}

export function createSubagentContextBuilder(
  config: SubagentContextBuilderConfig,
): SubagentContextBuilder {
  return new SubagentContextBuilder(config);
}

function buildSubagentContextSections(config: SubagentContextBuilderConfig): ContextSection[] {
  const sections: ContextSection[] = [buildCliPrefixSection()];
  const agentPrompt = config.agentPrompt.trimEnd();
  if (agentPrompt) {
    sections.push(
      createSubagentSection({
        name: "Subagent Agent Prompt",
        source: "subagent_agent_prompt",
        cacheHint: "stable",
        // An empty prompt is not a semantic segment; a bare left edge must not become its own system block.
        // ZCode by design: the Subagent agent prompt carries a single-newline left edge vs the CLI prefix.
        content: `\n${agentPrompt}`,
      }),
    );
  }

  sections.push(
    createSubagentSection({
      name: "Subagent Notes",
      source: "subagent_notes",
      cacheHint: "stable",
      // ZCode by design: later Subagent system blocks all carry a double-newline left edge.
      content: `\n\n${buildSubagentCommonNotes()}`,
    }),
    createSubagentSection({
      name: "Subagent Environment",
      source: "subagent_environment",
      cacheHint: "dynamic",
      content: `\n\n${buildSubagentEnvironmentContext({
        agentPrompt: config.agentPrompt,
        envInfo: config.envInfo,
        model: config.model,
      })}`,
    }),
  );

  const requestUserContextSection = buildRequestUserContextSection({
    userInstructions: config.userInstructions,
  });
  if (requestUserContextSection) {
    sections.push(requestUserContextSection);
  }
  const currentDateSection = buildCurrentDateSection(config.currentDate);
  if (currentDateSection) {
    sections.push(currentDateSection);
  }
  if (config.skills) {
    const skillsSection = buildSkillsSection({
      outcome: config.skills,
      metadataBudget: config.skillMetadataBudget,
    });
    if (skillsSection) {
      sections.push(skillsSection);
    }
  }

  return sections;
}

function orderSubagentSections(sections: ContextSection[]): ContextSection[] {
  return [
    ...sections.filter((section) => section.injectionTarget === "system"),
    ...sections.filter((section) => section.injectionTarget === "meta_user"),
  ];
}

function createSubagentSection(input: {
  name: string;
  source: ContextSection["source"];
  cacheHint: ContextSection["cacheHint"];
  content: string;
}): ContextSection {
  return {
    ...input,
    injectionTarget: "system",
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    preview: input.content.slice(0, 100),
  };
}

function toBaseContextBuilderConfig(config: SubagentContextBuilderConfig): ContextBuilderConfig {
  return {
    workingDirectory: config.envInfo.cwd,
    envInfo: config.envInfo,
    model: config.model,
    currentDate: config.currentDate,
    skillMetadataBudget: config.skillMetadataBudget,
    skills: config.skills,
  };
}
