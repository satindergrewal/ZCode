import type { Memory, MemoryConfig } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE =
  "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED";
export const PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE = "PROJECT_MEMORY_FILE_CHANGED";

export interface ProjectMemoryFileSummary {
  name: string;
  /** Real path already validated by MemoryService and confined to the local Project Memory root. */
  path: string;
  kind: "index" | "item";
  size: number;
  updatedAt: number;
}

export interface ProjectMemoryWorkspaceSummary {
  id: string;
  label: string;
  updatedAt: number;
  files: ProjectMemoryFileSummary[];
}

export interface IMemoryService {
  /**
   * Loads the memory file for the given agent
   * @param workspacePath workspace path
   * @param agentId agent id, e.g. 'claude' or 'gemini'
   */
  loadMemory(params: {
    workspacePath: string;
    agentId: string;
  }): Promise<{ memory: Memory | null }>;

  /**
   * Saves the memory configuration
   */
  saveMemory(params: {
    workspacePath: string;
    agentId: string;
    config: MemoryConfig;
  }): Promise<void>;

  /**
   * Clears the memory contents
   */
  clearMemory(params: { workspacePath: string; agentId: string }): Promise<void>;

  /**
   * Returns the user-level memory directory, creating it if missing
   */
  getUserMemoryDirectory(): Promise<{ path: string }>;

  /** Lists the Project Memory entries viewable in the local profile. */
  listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]>;

  /** Reads one Project Memory Markdown file verbatim. */
  readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{ content: string; updatedAt: number }>;
}

export const IMemoryService = createServiceDescriptor<IMemoryService>(ServiceChannels.Memory);
