import type { OpenAiCompatApi, ZcodeAliasApi } from "./aliasApi.js";

export const OPENAI_SET_GLOBALS_EVENT = "openai:set_globals";

/** Everything delegates to one `window.zcode` instance; alias.ts dispatches `openai:set_globals` on globals changes (detail.globals sourced from this object). */
export function createOpenAiCompatApi(api: ZcodeAliasApi): OpenAiCompatApi {
  return {
    get toolInput() {
      return api.toolInput;
    },
    get toolOutput() {
      return api.toolOutput;
    },
    get toolResponseMetadata() {
      return api.toolResponseMetadata;
    },
    get widgetState() {
      return api.widgetState;
    },
    get theme() {
      return api.theme;
    },
    get locale() {
      return api.locale;
    },
    get displayMode() {
      return api.displayMode;
    },
    get maxHeight() {
      return api.maxHeight;
    },
    get safeArea() {
      return api.safeArea;
    },
    get userAgent() {
      return api.userAgent;
    },
    setWidgetState: (state) => api.setWidgetState(state),
    callTool: (name, args) => api.callTool(name, args),
    sendFollowUpMessage: (input) => api.sendFollowUpMessage({ prompt: input.prompt }),
    requestDisplayMode: (input) => api.requestDisplayMode(input),
    openExternal: (input) => api.openExternal(input),
    notifyIntrinsicHeight: (height) => api.notifyIntrinsicHeight(height),
  };
}

/** `openai:set_globals` detail: compat-interface shape carrying only the currently readable globals snapshot. */
export function readOpenAiGlobals(api: OpenAiCompatApi): Record<string, unknown> {
  return {
    toolInput: api.toolInput,
    toolOutput: api.toolOutput,
    toolResponseMetadata: api.toolResponseMetadata,
    widgetState: api.widgetState,
    theme: api.theme,
    locale: api.locale,
    displayMode: api.displayMode,
    maxHeight: api.maxHeight,
    safeArea: api.safeArea,
    userAgent: api.userAgent,
  };
}
