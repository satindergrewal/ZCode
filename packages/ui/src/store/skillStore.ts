import { create } from "zustand";
import {
  normalizeAgentProviderToZCodeAgent,
  ZCODE_AGENT_PROVIDER,
  type ZCodeProvider,
  type SkillSummary,
  type SkillsCapability,
} from "@zcode/shared";
import type { ISkillsService } from "@zcode/services";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { logger } from "@/logger.js";

interface SkillStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  provider: ZCodeProvider;
  loadedProvider: ZCodeProvider | null;
  skills: SkillSummary[];
  capability: SkillsCapability | null;
  loading: boolean;
  error: string | null;
  initialize: (
    workspacePath: string,
    providerOrSkillsService: ZCodeProvider | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (skillsService: ISkillsService, workspaceIdentity?: string) => Promise<void>;
  setEnabled: (
    skillId: string,
    providerOrEnabled: ZCodeProvider | boolean,
    scopeOrSkillsService: SkillSummary["scope"] | ISkillsService,
    enabledOrSkillsService?: boolean | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
}

const inFlightSkillLoads = new Map<string, ReturnType<ISkillsService["list"]>>();

function getSkillLoadKey(
  workspacePath: string,
  provider: ZCodeProvider,
  workspaceIdentity?: string,
): string {
  return `${workspaceIdentity?.trim() || workspacePath}::${provider}`;
}

function loadSkillsOnce(
  workspacePath: string,
  provider: ZCodeProvider,
  skillsService: ISkillsService,
  workspaceIdentity?: string,
  options: { bypassCache?: boolean } = {},
): ReturnType<ISkillsService["list"]> {
  const key = getSkillLoadKey(workspacePath, provider, workspaceIdentity);
  if (!options.bypassCache) {
    const current = inFlightSkillLoads.get(key);
    if (current) {
      return current;
    }
  }
  // refresh must return fresh results after a skill is copied into or removed from the shared dir.
  // Reusing the in-flight promise returns a stale scan and hides new skills from the chat mention.
  const request = skillsService.list({ workspacePath, workspaceIdentity, provider }).finally(() => {
    // Clear only when this is the active in-flight request; never clobber concurrent ones.
    if (inFlightSkillLoads.get(key) === request) {
      inFlightSkillLoads.delete(key);
    }
  });
  inFlightSkillLoads.set(key, request);
  return request;
}

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspacePath: null,
  loadedWorkspaceIdentity: null,
  provider: ZCODE_AGENT_PROVIDER,
  loadedProvider: null,
  skills: [],
  capability: null,
  loading: false,
  error: null,
  async initialize(
    workspacePath: string,
    providerOrSkillsService: ZCodeProvider | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) {
    const currentState = get();
    const hasProvider = typeof providerOrSkillsService === "string";
    const provider = normalizeAgentProviderToZCodeAgent(
      hasProvider ? providerOrSkillsService : ZCODE_AGENT_PROVIDER,
    );
    const skillsService = hasProvider ? maybeSkillsService : providerOrSkillsService;
    const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
    if (!skillsService) {
      set({
        workspacePath,
        workspaceIdentity: normalizedWorkspaceIdentity,
        provider,
        loading: false,
        error: "skillsService is required",
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
      return;
    }
    const hasCachedSkills =
      currentState.skills.length > 0 &&
      currentState.loadedWorkspacePath === workspacePath &&
      currentState.loadedWorkspaceIdentity === normalizedWorkspaceIdentity &&
      currentState.loadedProvider === provider;
    // Switching the agent filter triggers initialize.
    // It used to always set loading=true, clearing the list to "loading" before results rendered.
    // Now only a cache for the same workspace+provider is reused, so the previous skill set never leaks into this session.
    set({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      provider,
      skills: hasCachedSkills ? currentState.skills : [],
      capability: hasCachedSkills ? currentState.capability : null,
      loading: !hasCachedSkills,
      error: null,
    });
    try {
      // The chat input mounts several skill consumers at once ($ mention and the / panel).
      // They used to fire the same list request concurrently on first paint, amplifying mirror-sync races into visible errors.
      // Deduplicate by workspace+provider and reuse a single request result per round.
      const result = await loadSkillsOnce(
        workspacePath,
        provider,
        skillsService,
        normalizedWorkspaceIdentity ?? undefined,
      );
      set({
        skills: result.skills,
        capability: result.capability,
        loading: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
    } catch (error) {
      logger.error("[skills] initialize failed", {
        workspacePath,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
    }
  },
  async refresh(skillsService: ISkillsService, workspaceIdentity?: string) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const provider = normalizeAgentProviderToZCodeAgent(get().provider);
    const hasCachedSkills = get().skills.length > 0;
    // Toggling a skill triggers refresh, which used to set loading=true every time,
    // flipping the Settings list to "loading" and back and flickering the whole list.
    // The blocking spinner now shows only on first load without cache; cached refreshes run in the background.
    set({ loading: !hasCachedSkills, error: null });
    // refresh must return the latest server result.
    // Calling loadSkillsOnce reuses the in-flight request,
    // leaving a stale list in the chat mention after a skill is copied into the shared dir.
    // refresh therefore skips the in-flight cache and forces a fresh request.
    inFlightSkillLoads.delete(getSkillLoadKey(workspacePath, provider, workspaceIdentityFromState));
    try {
      const result = await loadSkillsOnce(
        workspacePath,
        provider,
        skillsService,
        workspaceIdentityFromState,
      );
      set({
        skills: result.skills,
        capability: result.capability,
        loading: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
        loadedProvider: provider,
      });
    } catch (error) {
      logger.error("[skills] refresh failed", {
        workspacePath,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
        loadedProvider: provider,
      });
    }
  },
  async setEnabled(
    skillId: string,
    providerOrEnabled: ZCodeProvider | boolean,
    scopeOrSkillsService: SkillSummary["scope"] | ISkillsService,
    enabledOrSkillsService?: boolean | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const legacyCall = typeof providerOrEnabled === "boolean";
    const provider = normalizeAgentProviderToZCodeAgent(
      legacyCall ? get().provider : providerOrEnabled,
    );
    const scope = legacyCall ? undefined : (scopeOrSkillsService as SkillSummary["scope"]);
    const enabled = legacyCall ? providerOrEnabled : (enabledOrSkillsService as boolean);
    const skillsService = legacyCall
      ? (scopeOrSkillsService as ISkillsService)
      : maybeSkillsService;
    if (!skillsService) {
      set({ error: "skillsService is required" });
      return;
    }
    try {
      await skillsService.setEnabled({
        workspacePath,
        workspaceIdentity: workspaceIdentityFromState,
        provider,
        ...(scope ? { scope } : {}),
        skillId,
        enabled,
      });
      await get().refresh(skillsService, workspaceIdentityFromState);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));

type SkillStoreE2EBridge = typeof useSkillStore;

declare global {
  interface Window {
    __skillStoreE2E?: SkillStoreE2EBridge;
  }
}

if (shouldExposeE2EStoreBridge()) {
  // The E2E diagnostics entry must be opened explicitly by WDIO, not via ZCODE_ENV=test, so the product test env keeps no mutable global store.
  window.__skillStoreE2E = useSkillStore;
}
