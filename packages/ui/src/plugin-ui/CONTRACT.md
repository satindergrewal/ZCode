# plugin-ui

Renderer module, layer order `domain -> app -> adapters -> components`; public entry `index.ts`.

- One window-level page manager owns MCP and Gen UI capacity and reclaims; `createPage` holds the MCP controller, AppBridge, dedicated workspace/session lease, notice feed and memory snapshots. Cards and panes register anchors only. Inline pages sit inside the scroll container, panes position independently; atomic moves keep the same guest -- no resource reread, no rehandshake. Detach must move into the hidden carrier synchronously before DOM unmount.
- The page carrier handles layout only, never mouse hits; the webview receives clicks explicitly. A released webview's empty container must not cover the host reload button -- one rule for inline, pane and preview.
- Logical keys bind workspace identity (path fallback), session, plugin, server, resource and logical view. Surfaces share explicitly; plain tools share only on explicit widgetSessionId with identical permissions, else isolate by toolCallId. No same-turn same-resource inference merges.
- UI never touches plugin HTML, databases or connection credentials. Handles come via IPluginUiBridgeService; the platform port validates sandboxId/initId only; requests and live notices bind agent runtimeId/generation/token/appIdentity.
- Official ext-apps 2.0.0: one AppBridge per live page, 15s handshake. Keep experimental zcode/* widgetState, resourceSubscribe, surface and CSP extensions; never fake the full OpenAI API.
- App-provided tools discover/register after initialized; claims run on the official SDK AbortSignal, model cancels arrive via live-only deltas. callId dedup; terminal results are final. The host pins the page's MCP targets, reusing agent permissions/approvals; raw results return untouched.
- Page availableDisplayModes is a hard constraint; inline/fullscreen map to inline/pane, pip stays. Height defaults 240px within [80,1200]; hostContext returns width/maxHeight only, avoiding height loops. Layout merges per frame.
- widgetState accepts page-initiated writes only; one memory store keyed logically. Rebuilds deliver via hostContext zcode/widgetState. Moves never copy; manual retry, task eviction and source revoke clear; app restart empties.
- Idle 5 minutes offscreen reclaims live pages; never while pane-visible or with pending approval/call. Release waits for the agent's atomic idle confirm. Caps: 30 tasks, 64 live pages, serial admission; unsafe reclaims error. Task deletion cancels queued creates.
- Approved proactive release first detaches navigation/crash listeners under the original sandboxId, so Main's about:blank navigation cannot masquerade as a crash; real navigations/crashes still error and rebuild on retry.
- Release order: invalidate credentials, cancel calls/registrations, bounded resource-teardown, close port/guest, release feed/lease. Late prepares, unregisters and anchor cleanups touch only the captured instance. Card unmount never cuts keep-alive subscriptions.
- sendFollowUpMessage rides the existing session actions with gesture/editable confirm; verify the instance after confirm. Read-only sessions register nothing. updateModelContext delivers only to that workspace/session's composer, never database state.
- Invalid display.ui, web/mobile/remote, unsupported platforms or init failures fall back to the plain MCP card. Supersede/collapse policy stays projection-derived; no second accepted-input queue, no continuous/replayable semantic changes.
- Failed/cancelled or display.ui.isError rows stay plain records: no inline/pane slot, no auto-pane; manual pin/showInline/recent-turn never bypass this gate, and failures never replace a live success. Raw error results and page notice semantics are unchanged.

Components reach capabilities only via hooks/service ports; controllers never import adapters, domain stays pure. Pane tabs and composer context remain with their existing UI owners, never duplicated into page state.

preferredDisplayMode fullscreen consumes once per actual tool call; records live in the existing pane memory, keyed workspace/session/plugin/server/resource/toolCall, retained and evicted with its window cache. Row remounts cannot re-fire opens over collapse prefs; already-visible calls consume too. Manual opens, page requests and new calls use the normal entries.

- Sampling uses official oncreatesamplingmessage; only actionable tasks declare sampling. Requests carry full instance credentials, SDK signals cancel explicitly via the agent; controllers count sampling as busy and never cancel/resend on moves. Results stay out of the main chat; content extensions and progress remain pending.

hostPrimitives exposes to Gen UI the MessagePort transport, atomic carrier moves, window capacity management, theme projection and session-action reads. Gen UI never reuses the MCP tool-call controller. Bindings distinguish natural flow, container placement and pane; Gen UI previews reuse the origin popover, never remounting pages.
