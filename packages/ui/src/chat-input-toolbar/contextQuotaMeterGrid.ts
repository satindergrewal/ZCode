export function getContextQuotaMeterGridClass(count: number): string {
  // Start/Coding quotas come from server snapshots and may be 1-3 entries; the official MCP row
  // already spans below the grid, so an over-large count must not crush the 320px popover into
  // four columns. A fixed three columns would hole two-entry layouts and needlessly narrow one.
  if (count <= 1) {
    return "grid-cols-1";
  }
  if (count === 2) {
    return "grid-cols-2";
  }
  if (count === 3) {
    return "grid-cols-3";
  }
  return "grid-cols-3";
}
