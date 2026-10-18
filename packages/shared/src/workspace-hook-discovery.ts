// The discovery barrel once exported monotonicity and mutation APIs too,
// a second exposure path: consumers could bypass the dedicated subpaths, and a bad re-export once
// kept the desktop build from booting. Single-source demands one exposure path per API: this file exports only
// discovery's config/digest; mutation and monotonicity are imported from their own package subpaths.
export * from "./workspace-hook-config.js";
export * from "./workspace-hook-digest.js";
