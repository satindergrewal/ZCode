import { create } from "zustand";
import type { EmbeddedBrowserPermissionPromptEvent } from "@zcode/shared";

/**
 * Embedded-browser permission prompt queue: main pushes requests over IPC and the component
 * returns the decision to dequeue. Main dedupes/times out (10s); this store only queues for render.
 */
interface EmbeddedBrowserPermissionState {
  prompts: EmbeddedBrowserPermissionPromptEvent[];
  receivePrompt: (event: EmbeddedBrowserPermissionPromptEvent) => void;
  /** Once main settles a requestId by timeout, dequeue it here too; later pushes are unaffected. */
  dropPrompt: (requestId: string) => void;
}

export const useEmbeddedBrowserPermissionStore = create<EmbeddedBrowserPermissionState>((set) => ({
  prompts: [],
  // Pushes with the same requestId are hot updates (BT scan / USB enumeration); replace, never append.
  receivePrompt: (event) =>
    set((state) => ({
      prompts: state.prompts.some((prompt) => prompt.requestId === event.requestId)
        ? state.prompts.map((prompt) => (prompt.requestId === event.requestId ? event : prompt))
        : [...state.prompts, event],
    })),
  dropPrompt: (requestId) =>
    set((state) => ({ prompts: state.prompts.filter((prompt) => prompt.requestId !== requestId) })),
}));
