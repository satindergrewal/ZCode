import type { Hook, ZCodeWorkspaceHookTrustGrantResult } from "@zcode/shared";
import type { WorkspaceHookBundleSnapshotData } from "@zcode/shared/workspace-hook-discovery";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IHooksService {
  /**
   * Load the workspace hooks configuration
   */
  loadHooks(params: { workspaceIdentity?: string; workspacePath: string }): Promise<{
    hooks: Hook[];
    hooksEnabled: boolean;
    workspaceHookSnapshot?: WorkspaceHookBundleSnapshotData;
    /** True when the trust store is corrupt/unreadable (fail-closed: every hook treated as untrusted). */
    trustStoreCorrupt?: boolean;
  }>;

  /**
   * Save the hooks configuration
   */
  saveHooks(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    hooks: Hook[];
  }): Promise<void>;

  /**
   * Pre-trust a Workspace Hook with no task/session. Implementations must forward to the Agent
   * authority to re-discover the canonical snapshot; the service/UI never writes the store directly.
   */
  grantWorkspaceHookTrust?(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    bundleDigest: string;
    hookDeclarationDigest: string;
  }): Promise<ZCodeWorkspaceHookTrustGrantResult>;
}

export const IHooksService = createServiceDescriptor<IHooksService>(ServiceChannels.Hooks);
