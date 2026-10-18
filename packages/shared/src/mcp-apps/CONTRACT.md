# mcp-apps-protocol

Pure domain module, zero IO. Holds the ZCode extensions for MCP Apps: extension constants, tool `_meta` normalization, the `display.ui` projection schema, and sandbox contract types. The page<->host wire protocol (`ui/*` methods, handshake, version negotiation, JSON-RPC, error codes) belongs to the official `@modelcontextprotocol/ext-apps` SDK; this module duplicates no method names or schemas.

Invariants beyond types and tests:

- `resourceUri` precedence: `_meta.ui.resourceUri` -> deprecated flat key `_meta["ui/resourceUri"]` (spec MUST compat) -> `openai/outputTemplate`; it must start with `ui://` and stay <= 2048 chars, else the whole `ui` descriptor counts as absent -- never partially accepted.
- `visibility` defaults to `["model", "app"]`; tools without `"model"` may not enter provider contracts; `readMcpToolVisibility(meta)` reads independently of resourceUri.
- The agent's `initialize` per MCP server must declare `extensions["io.modelcontextprotocol/ui"].mimeTypes = ["text/html;profile=mcp-app"]` (`buildMcpAppsClientCapabilities`), or servers built on the official template register text-only tools.
- ZCode extension capabilities always live under `hostCapabilities.experimental["zcode/..."]` (widgetState, resourceSubscribe, surface, csp); the official zod strips unknown keys outside the standard slots.
- CSP defaults to the spec set; `'unsafe-eval'` / `'wasm-unsafe-eval'` pass only when declared true in resource `_meta["zcode/csp"]`; unknown keys and non-booleans drop.
- The sandbox handle's `shellUrl` derives from `sandboxId` (`zcode-sandbox://shell-<id>/`); `partition` derives from server identity (`persist:plugin-sandbox-v1-<hash>`); that server's pages share persistent storage, kept after the card closes; `sandboxId` allows `[A-Za-z0-9-]` only (CSP host-source charset).
- Host renderer and relay shell share exactly one MessageChannel (`PLUGIN_SANDBOX_PORT_NAME`) carrying raw JSON-RPC; the shell parses no protocol.
- `widgetState` is a ZCode extension: the initial value ships at handshake via hostContext `zcode/widgetState`, and the page hands state to host renderer memory via `ui/set-widget-state { widgetState }` (not persisted, no visibility argument; model-visible info only via `ui/update-model-context`).
- `_meta.ui.surface` and manifest surface ids share the charset `^[A-Za-z0-9][A-Za-z0-9_.-]*$`, <= 128 chars; invalid dropped.
- The page-initiated `resources/read` bounds live here: `MCP_APPS_UI_READ_RESOURCE_MAX_BYTES` (8 MiB) and `MCP_APPS_UI_READ_RESOURCE_MIME_ALLOWLIST` (`/`-suffix = prefix match, params and case ignored); enforced by the agent's mcp-ui.
- Common documents, images, audio/video, archives, and fonts are admitted by explicit MIME entries, no new category prefixes; unknown and missing-MIME blobs still reject. Scope and regression bars: [resource MIME spec](../../../../docs/mcp-apps-resource-mime-spec.md).

Gen UI reuses the sandbox registration payload with explicit `contentKind: "gen-ui"`, empty pluginId/serverName, and no permission declarations; ordinary MCP Apps must still provide their plugin and server attribution. The Gen UI page-business schema lives separately in `@zcode/shared/gen-ui`.
