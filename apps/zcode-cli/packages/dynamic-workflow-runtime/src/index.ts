/**
 * `@zcode/dynamic-workflow-runtime`: the sandbox harness.
 *
 * Exports the harness entry, wire protocol types, entry-file rendering/persistence (`renderChildEntry` /
 * `writeChildEntryFile`, so tests and tools can produce production-shaped entry files), and the child exit `childMain`.
 * The SEA hidden subcommand (`__zcode-dwf-child`) no longer imports this package: the entry file carries childMain;
 * the subcommand just `import()`s the file and calls its `start`.
 */

export {
  runWorkflowScript,
  type DriverFactory,
  type RunControlBinding,
  type RunWorkflowOptions,
} from "./harness.js";
export {
  childMain,
  renderChildEntry,
  type ChildMainDeps,
  type ChildReadlineInterface,
  type ChildVmModule,
} from "./child-source.js";
export {
  childEntryFileName,
  fallbackWorkflowRunsDir,
  workflowRunsDir,
  writeChildEntryFile,
  type ChildEntryFile,
  type HarnessWarning,
  type WriteChildEntryFileInput,
} from "./child-entry-file.js";
export {
  type ChildMessage,
  type ChildPayload,
  type CompleteMessage,
  type CreateActorMessage,
  type EventMessage,
  type ParentMessage,
  type RequestMessage,
  type ResponseMessage,
  type WireError,
} from "./protocol.js";
