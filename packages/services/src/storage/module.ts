/**
 * storage module manifest: disk usage scan and cleanup for the settings Storage page.
 * Dependencies mirror architecture-policy.yaml; only contract.ts is exported.
 */
export const storageModule = {
  id: "storage",
  requires: ["shared", "rpc", "services"],
  provides: ["storage-service"],
  publicEntrypoints: ["contract.ts"],
} as const;
