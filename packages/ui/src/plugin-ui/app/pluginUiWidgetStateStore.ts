/**
 * Single owner of plugin page widgetState.
 * Keyed buildPluginUiSurfaceKey(target, scope): workspaceKey + sessionId + pluginId + server + resource + scopeId,
 * same isolation as pluginUiSurfaceStore. Page ui/set-widget-state writes here synchronously; usePluginUiHost
 * seeds from here at AppBridge creation, so collapse/re-expand and pane reopen restore.
 * Renderer memory, not persisted: empty after restart; plugin business data belongs in the plugin's backend.
 * Since 4a-0 no CLI-command session writes and no model-visible semantics -- model info goes via updateModelContext.
 */
const states = new Map<string, unknown>();

/** undefined until first write; a page-written null is preserved (not-loaded vs cleared). */
export function getPluginUiWidgetState(key: string): unknown {
  return states.get(key);
}

export function setPluginUiWidgetState(key: string, widgetState: unknown): void {
  states.set(key, widgetState);
}

export function clearPluginUiWidgetState(key: string): void {
  states.delete(key);
}

/** Test hook: clear all records. */
export function resetPluginUiWidgetStateForTest(): void {
  states.clear();
}
