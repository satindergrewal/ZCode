// The old default matches the model's common 30s page wait; once the send side effects succeed it is aborted
// before the result is read. Execution and model-visible text share this constant so the real timeout never drifts
// from the tools/list description.
export const NODE_REPL_DEFAULT_TIMEOUT_MS = 60_000;

// serverInfo was long hardcoded to 0.1.0 and drifted from the plugin release version, so the host could not tell
// which Browser Use runtime had actually loaded. On version bumps keep this in sync with package.json.
// This is the host's own version, not the browser-use plugin's. When the host was split into @zcode/node-repl-host
// the number was kept: it has always been the version the node_repl server announces, and changing it is a pointless
// protocol change. From here on it moves with the host contract (bridge members, tool surface), decoupled from both plugins' versions.
// 0.5.0: the host contract itself changed (node_repl split out of browser-use into its own seed unit, tool surface
// reshaped by the CUA node_repl SDK rebuild) -- per the rule above, bump. Matching browser-use 0.5.0 is shared
// history, not coupling; the two still version independently.
// 0.6.0: the tool surface converged to `js` only; `js_reset` and `js_add_node_module_dir` were removed along with
// the moduleDirs capability. The former has been a fixed-success no-op since the fresh-kernel rework, and its
// never-fails behavior made models call it repeatedly (burning budget); the latter pushed host duties onto the
// model, which cannot know which node_modules to pass -- only the skill docs could say, and the host injects
// those paths itself. Both measured zero calls. Any host protocol change must be identifiable via serverInfo,
// else the host cannot tell which tool-surface generation it connected to.
export const NODE_REPL_SERVER_VERSION = "0.6.0";

// node_repl's underlying capability is general-purpose JS, but the old text declared no routing boundary, so
// non-browser tasks mispicked this high-privilege tool. Browser Use and Computer Use are the sanctioned entries;
// both server and tool descriptions must say so explicitly.
export const NODE_REPL_SERVER_INSTRUCTIONS =
  "Browser Use and Computer Use only. Use `js` to run JavaScript in a fresh Node-backed kernel only when " +
  "the corresponding official skill instructs you to control a browser or computer. Do not use this server for unrelated tasks, " +
  "including general-purpose JavaScript, filesystem, shell, package inspection, or data processing. " +
  `Calls default to a ${NODE_REPL_DEFAULT_TIMEOUT_MS} ms timeout. ` +
  "Always provide `title` as a short user-facing description in the user's language. " +
  "Every `js` call starts fresh; reconstruct browser wrappers and recover persistent tabs from current BrowserControl facts.";

export const JS_TOOL_DESCRIPTION =
  "Browser Use and Computer Use only. Run JavaScript in a fresh Node-backed kernel with top-level await only as " +
  "instructed by the corresponding official skill to control a browser or computer. Do not use it as a general-purpose JavaScript runtime " +
  "or for filesystem, shell, package inspection, data processing, or other non-browser work. " +
  "Always provide the required `title` as a short " +
  "user-facing description in the user's language without implementation terms. If `timeout_ms` is omitted, execution times out " +
  `after ${NODE_REPL_DEFAULT_TIMEOUT_MS} ms. If the code may take more than 30000 ms including all awaited operations, you MUST set \`timeout_ms\` to at least the estimated total runtime plus 15000 ms; split the work into multiple calls if that exceeds the 120000 ms maximum. Use \`nodeRepl.cwd\`, \`nodeRepl.homeDir\`, \`nodeRepl.tmpDir\`, ` +
  "`nodeRepl.requestMeta`, `nodeRepl.setResponseMeta(meta)`, `nodeRepl.write(value)`, and " +
  "`await nodeRepl.emitImage(imageLike)`. Global bindings and module cache do not persist across calls. " +
  "For Computer Use SDK results, do not console.log/JSON.stringify the complete result or call " +
  "nodeRepl.emitImage yourself; the SDK submits the structured image/state result and you should " +
  "use nodeRepl.write for short text-only status. `get_app_state` is an explicit observation: " +
  "assign it to `const state`, always call `nodeRepl.write(state.text)`, and use " +
  "`state.state_id` plus `state.elements[*].index` for element targets; do not leave " +
  "get_app_state as the final expression or regex state_id from its text. " +
  "Metadata methods such as list_apps and list_windows may not return " +
  "action_sent; a missing field is not a failure, so inspect text or structuredContent. " +
  "Never use screenshot_display.bounds or app/window bounds as raster pixel coordinates; " +
  "x/y must be integer pixels inside the width/height of the returned raster. " +
  "Every Computer Use JavaScript call must start with the complete SDK bootstrap in the same cell " +
  "before agent.computerUse; never split bootstrap and action across calls. Never rely on agent, " +
  "runtime, browser, or imported bindings from an earlier call. " +
  "Import only `node:*` builtins and absolute `file://` URLs built from the official skill root, " +
  'for example `await import(pathToFileURL(join(root, "scripts", "client.mjs")).href)`; ' +
  "bare package specifiers do not resolve. Bootstrap the requested official capability in every call.";
