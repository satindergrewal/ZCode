// The impl moved to @zcode/shared/workspaceFileEntriesCodec (services/host side
// needs it too; layering evicts it from ui). This file stays a re-export so legacy
// import paths in the filter backend/worker keep working and pre-push affected
// does not degrade to a full run over a deleted-file diff.
export * from "@zcode/shared/workspaceFileEntriesCodec";
