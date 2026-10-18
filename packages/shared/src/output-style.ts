export interface OutputStyle {
  id: string;
  name: string;
  description: string;
  content: string;
  isBuiltIn: boolean;
  enabled: boolean;
  filePath?: string; // File path, for opening the file in edit mode
}

export interface OutputStyleConfig {
  name: string;
  description: string;
  content: string;
  enabled?: boolean;
}

export type OutputStyleGenerationStatus = "idle" | "generating" | "completed" | "error";
