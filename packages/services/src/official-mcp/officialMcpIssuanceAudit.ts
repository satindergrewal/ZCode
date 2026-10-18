interface OfficialMcpIssuanceAudit {
  markFirst(pluginId: string, mcpKey: string, workspaceKey: string): boolean;
}

/** In-process bounded first-issuance audit; true means this triple is seen for the first time. */
export function createOfficialMcpIssuanceAudit(maxEntries = 256): OfficialMcpIssuanceAudit {
  const capacity = Math.max(1, Math.trunc(maxEntries));
  const keys = new Map<string, true>();
  return {
    markFirst(pluginId, mcpKey, workspaceKey) {
      const key = `${pluginId}\u0000${mcpKey}\u0000${workspaceKey}`;
      if (keys.has(key)) return false;
      keys.set(key, true);
      while (keys.size > capacity) {
        const oldest = keys.keys().next();
        if (oldest.done) break;
        keys.delete(oldest.value);
      }
      return true;
    },
  };
}
