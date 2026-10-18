/**
 * Single source of truth for all data-testid values, shared by UI components and E2E tests.
 * Add new testids here; never hardcode the strings in components.
 * Every entry carries a doc comment.
 */

// Login entry
/** Top-right login trigger button */
export const TID_LOGIN_TRIGGER = "login-trigger";
/** Login action inside the user menu */
export const TID_LOGIN_MENU_ITEM = "login-menu-item";
/** Switch-to-API-key login button on the login page */
export const TID_LOGIN_USE_API_KEY_BUTTON = "login-use-api-key-button";
/** API-key login provider select trigger */
export const TID_LOGIN_API_KEY_PROVIDER_TRIGGER = "login-api-key-provider-trigger";
/** API-key login provider option (suffix: provider choice) */
export const TID_LOGIN_API_KEY_PROVIDER_ITEM = "login-api-key-provider-item";
/** API-key login secret input */
export const TID_LOGIN_API_KEY_INPUT = "login-api-key-input";
/** API-key login continue button */
export const TID_LOGIN_API_KEY_CONTINUE_BUTTON = "login-api-key-continue-button";
/** API-key login cancel button */
export const TID_LOGIN_API_KEY_CANCEL_BUTTON = "login-api-key-cancel-button";
/** API-key login skip-for-now button */
export const TID_LOGIN_API_KEY_SKIP_BUTTON = "login-api-key-skip-button";
/** API-key login error message */
export const TID_LOGIN_API_KEY_ERROR = "login-api-key-error";
/** Login button inside the OAuth dialog */
export const TID_OAUTH_LOGIN_BUTTON = "oauth-login-button";
/** OAuth dialog cancel button */
export const TID_OAUTH_CANCEL = "oauth-cancel";
/** OAuth error message text */
export const TID_OAUTH_ERROR = "oauth-error";

// App
/** Top navigation bar */
export const TID_APP_HEADER = "app-header";
/** Language switch button */
export const TID_LOCALE_TOGGLE = "locale-toggle";
/** Theme toggle button */
export const TID_THEME_TOGGLE = "theme-toggle";
/** Sign-out button */
export const TID_LOGOUT_BUTTON = "logout-button";
/** Terminal visibility toggle button */
export const TID_TERMINAL_TOGGLE = "terminal-toggle";
export const TID_SIDE_PANE_TOGGLE = "side-pane-toggle";
/** Terminal panel close button */
export const TID_TERMINAL_CLOSE_BUTTON = "terminal-close-button";
/** Browser visibility toggle button */
export const TID_BROWSER_TOGGLE = "browser-toggle";
/** Git visibility toggle button */
export const TID_GIT_TOGGLE = "git-toggle";
/** Browser panel container */
export const TID_BROWSER_PANE = "browser-pane";
/** Browser panel close button */
export const TID_BROWSER_CLOSE_BUTTON = "browser-close-button";
/** Git panel container */
export const TID_GIT_PANE = "git-pane";
/** Git panel close button */
export const TID_GIT_CLOSE_BUTTON = "git-close-button";
/** Top-level Git commit/push entry point */
export const TID_GIT_ACTION_TRIGGER = "git-action-trigger";
/** Git commit dialog */
export const TID_GIT_COMMIT_DIALOG = "git-commit-dialog";
/** Git commit message input */
export const TID_GIT_COMMIT_MESSAGE_INPUT = "git-commit-message-input";
/** Git commit message generate button */
export const TID_GIT_COMMIT_GENERATE_BUTTON = "git-commit-generate-button";
/** Git commit dialog include-unstaged toggle */
export const TID_GIT_COMMIT_INCLUDE_UNSTAGED = "git-commit-include-unstaged";
/** Git commit dialog bottom command action list */
export const TID_GIT_COMMIT_ACTION_COMMAND = "git-commit-action-command";
/** Git commit dialog bottom action item (suffix: action id) */
export const TID_GIT_COMMIT_ACTION_ITEM = "git-commit-action-item";
/** Browser address bar input */
export const TID_BROWSER_ADDRESS_INPUT = "browser-address-input";
/** Browser back button */
export const TID_BROWSER_BACK_BUTTON = "browser-back-button";
/** Browser forward button */
export const TID_BROWSER_FORWARD_BUTTON = "browser-forward-button";
/** Browser reload button */
export const TID_BROWSER_REFRESH_BUTTON = "browser-refresh-button";
/** Browser free-size mode button */
export const TID_BROWSER_RESPONSIVE_BUTTON = "browser-responsive-button";
/** Browser free-size viewport */
export const TID_BROWSER_RESPONSIVE_VIEWPORT = "browser-responsive-viewport";
/** Browser free-size top control bar */
export const TID_BROWSER_RESPONSIVE_TOOLBAR = "browser-responsive-toolbar";
/** Browser free-size width input */
export const TID_BROWSER_RESPONSIVE_WIDTH_INPUT = "browser-responsive-width-input";
/** Browser free-size height input */
export const TID_BROWSER_RESPONSIVE_HEIGHT_INPUT = "browser-responsive-height-input";
/** Browser free-size zoom select */
export const TID_BROWSER_RESPONSIVE_ZOOM_SELECT = "browser-responsive-zoom-select";
/** Browser free-size zoom option (suffix: zoom value) */
export const TID_BROWSER_RESPONSIVE_ZOOM_OPTION = "browser-responsive-zoom-option";
/** Browser free-size zoomed canvas placeholder */
export const TID_BROWSER_RESPONSIVE_SCALED_FRAME = "browser-responsive-scaled-frame";
/** Browser free-size left resize handle */
export const TID_BROWSER_RESPONSIVE_RESIZE_LEFT = "browser-responsive-resize-left";
/** Browser free-size right resize handle */
export const TID_BROWSER_RESPONSIVE_RESIZE_WIDTH = "browser-responsive-resize-width";
/** Browser free-size top resize handle */
export const TID_BROWSER_RESPONSIVE_RESIZE_TOP = "browser-responsive-resize-top";
/** Browser free-size bottom resize handle */
export const TID_BROWSER_RESPONSIVE_RESIZE_HEIGHT = "browser-responsive-resize-height";
/** Browser free-size top-left resize corner */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_LEFT =
  "browser-responsive-resize-corner-top-left";
/** Browser free-size top-right resize corner */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_RIGHT =
  "browser-responsive-resize-corner-top-right";
/** Browser free-size bottom-left resize corner */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_BOTTOM_LEFT =
  "browser-responsive-resize-corner-bottom-left";
/** Browser free-size bottom-right resize corner */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER = "browser-responsive-resize-corner";
/** Browser element-picker button */
export const TID_BROWSER_ELEMENT_PICKER_BUTTON = "browser-element-picker-button";
/** Browser address bar more-actions button */
export const TID_BROWSER_MORE_BUTTON = "browser-more-button";
/** Open-in-default-browser menu item */
export const TID_BROWSER_OPEN_EXTERNAL_ITEM = "browser-open-external-item";
/** Browser open-devtools button */
export const TID_BROWSER_DEVTOOLS_BUTTON = "browser-devtools-button";
/** Browser web view */
export const TID_BROWSER_WEBVIEW = "browser-webview";
/** Built-in browser permission bar container */
export const TID_BROWSER_PERMISSION_PROMPTS = "browser-permission-prompts";
/** Permission bar allow-once button */
export const TID_BROWSER_PERMISSION_ALLOW_ONCE = "browser-permission-allow-once";
/** Permission bar allow-for-site button */
export const TID_BROWSER_PERMISSION_ALLOW_ALWAYS = "browser-permission-allow-always";
/** Permission bar deny button (declines once, not remembered) */
export const TID_BROWSER_PERMISSION_DENY = "browser-permission-deny";
export const TID_BROWSER_PERMISSION_DISMISS = "browser-permission-dismiss";
/** Readable error state for browser page-load failures */
export const TID_BROWSER_LOAD_ERROR = "browser-load-error";
/** Certificate-bypass hint inside the browser load-failure state */
export const TID_BROWSER_LOAD_ERROR_CERT_HINT = "browser-load-error-cert-hint";
/** Preview panel container */
export const TID_PREVIEW_PANE = "preview-pane";
/** Preview panel close button */
export const TID_PREVIEW_CLOSE_BUTTON = "preview-close-button";
/** Preview previous-segment button */
export const TID_PREVIEW_PREV_BUTTON = "preview-prev-button";
/** Preview next-segment button */
export const TID_PREVIEW_NEXT_BUTTON = "preview-next-button";
/** View-code button inside a tool call */
export const TID_TOOL_CODE_VIEWER_BUTTON = "tool-code-viewer-button";
/** Tool-call summary row toggle (suffix: toolId) */
export const TID_TOOL_SUMMARY_TRIGGER = "tool-summary-trigger";

// Terminal
/** Terminal container */
export const TID_TERMINAL = "terminal";

// SSHDialog
/** Trigger button for the SSH connection dialog */
export const TID_SSH_CONNECT_TRIGGER = "ssh-connect-trigger";
/** SSH connection dialog container */
export const TID_SSH_DIALOG = "ssh-dialog";
/** Remote connection kind: switch to SSH */
export const TID_REMOTE_KIND_SSH = "remote-kind-ssh";
/** Remote connection kind: switch to Server */
export const TID_REMOTE_KIND_SERVER = "remote-kind-server";
/** Remote connection kind: switch to WSL */
export const TID_REMOTE_KIND_WSL = "remote-kind-wsl";
/** Remote connection kind: switch to Docker */
export const TID_REMOTE_KIND_DOCKER = "remote-kind-docker";
/** SSH host input */
export const TID_SSH_HOST_INPUT = "ssh-host-input";
/** SSH port input */
export const TID_SSH_PORT_INPUT = "ssh-port-input";
/** SSH username input */
export const TID_SSH_USERNAME_INPUT = "ssh-username-input";
/** SSH config alias select */
export const TID_SSH_CONFIG_ALIAS_SELECT = "ssh-config-alias-select";
/** SSH password input */
export const TID_SSH_PASSWORD_INPUT = "ssh-password-input";
/** SSH key path input */
export const TID_SSH_PRIVATE_KEY_INPUT = "ssh-private-key-input";
/** SSH auth method: password */
export const TID_SSH_AUTH_PASSWORD = "ssh-auth-password";
/** SSH auth method: key pair */
export const TID_SSH_AUTH_PRIVATE_KEY = "ssh-auth-private-key";
/** WSL distro select */
export const TID_WSL_DISTRO_SELECT = "wsl-distro-select";
/** WSL Linux user input */
export const TID_WSL_USER_INPUT = "wsl-user-input";
/** Docker container select */
export const TID_DOCKER_CONTAINER_SELECT = "docker-container-select";
/** Docker container name/ID input */
export const TID_DOCKER_CONTAINER_INPUT = "docker-container-input";
/** Server remote URL input */
export const TID_SERVER_URL_INPUT = "server-url-input";
/** Server remote name input */
export const TID_SERVER_NAME_INPUT = "server-name-input";
/** Server remote token input */
export const TID_SERVER_TOKEN_INPUT = "server-token-input";
/** Server remote default workspace path input */
export const TID_SERVER_WORKSPACE_PATH_INPUT = "server-workspace-path-input";
/** SSH connect confirm button */
export const TID_SSH_CONNECT_BUTTON = "ssh-connect-button";
/** SSH dialog cancel button */
export const TID_SSH_CANCEL_BUTTON = "ssh-cancel-button";

// Sidebar
/** Sidebar container */
export const TID_SIDEBAR = "sidebar";
/** Sidebar open-workspace button */
export const TID_WORKSPACE_OPEN_BUTTON = "workspace-open-button";
/** Sidebar workspace list */
export const TID_WORKSPACE_LIST = "workspace-list";
/** Sidebar workspace item (suffix: workspacePath) */
export const TID_WORKSPACE_ITEM = "workspace-item";
/** Sidebar close-workspace button (suffix: workspacePath) */
export const TID_WORKSPACE_CLOSE = "workspace-close";
/** Conversations subsection in the project view */
export const TID_CONVERSATION_SECTION = "conversation-section";
/** Projects subsection in the project view */
export const TID_PROJECT_SECTION = "project-section";
/** New-task button in the conversations section */
export const TID_CONVERSATION_NEW_TASK = "conversation-new-task";
/** Add-menu button in the projects section */
export const TID_PROJECT_ADD = "project-add";
/** Composer workspace select trigger */
export const TID_COMPOSER_WORKSPACE_TRIGGER = "composer-workspace-trigger";
/** Remote-connect entry in the composer workspace menu */
export const TID_COMPOSER_REMOTE_CONNECTION = "composer-remote-connection";
/** Unlink-current-project button in the composer */
export const TID_COMPOSER_PROJECT_DETACH = "composer-project-detach";
/** Non-project work entry in the composer workspace menu */
export const TID_COMPOSER_WORK_OUTSIDE_PROJECT = "composer-work-outside-project";
// ChatView
/** Chat view container */
export const TID_CHAT_VIEW = "chat-view";
/** Chat message list */
export const TID_CHAT_MESSAGES = "chat-messages";
/** Error banner above the chat input */
export const TID_CHAT_ERROR_BANNER = "chat-error-banner";
/** Hook-blocking error details button */
export const TID_CHAT_ERROR_DETAILS_BUTTON = "chat-error-details-button";
/** Icon on the left of the hook-blocking error banner */
export const TID_CHAT_ERROR_HOOK_ICON = "chat-error-hook-icon";
/** Chat empty-state container */
export const TID_CHAT_EMPTY = "chat-empty";
/** Chat input */
export const TID_CHAT_INPUT = "chat-input";
/** Chat attachment button */
export const TID_CHAT_ATTACHMENT_BUTTON = "chat-attachment-button";
/** Chat attachment menu item */
export const TID_CHAT_ATTACHMENT_MENU_ITEM = "chat-attachment-menu-item";
/** Chat send button */
export const TID_CHAT_SEND_BUTTON = "chat-send-button";
/** Chat stop button */
export const TID_CHAT_STOP_BUTTON = "chat-stop-button";
/** Chat loading indicator */
export const TID_CHAT_LOADING = "chat-loading";
/** Top-right chat status summary panel */
export const TID_CHAT_SUMMARY_PANEL = "chat-summary-panel";
/** Chat compaction timeline bar (suffix: inputId or operationId) */
export const TID_CHAT_COMPACT_MARKER = "chat-compact-marker";
/** Chat compaction retry button after failure/interrupt (suffix: inputId or operationId) */
export const TID_CHAT_COMPACT_RETRY_BUTTON = "chat-compact-retry-button";
/** Chat goal-verification timeline bar (suffix: targetId:goalIteration or verificationId) */
export const TID_CHAT_GOAL_VERIFICATION_MARKER = "chat-goal-verification-marker";
/** Chat queue panel */
export const TID_CHAT_QUEUE_PANEL = "chat-queue-panel";
/** Chat queue item (suffix: queueItemId) */
export const TID_CHAT_QUEUE_ITEM = "chat-queue-item";
/** Chat queue item content (suffix: queueItemId) */
export const TID_CHAT_QUEUE_ITEM_CONTENT = "chat-queue-item-content";
/** Chat queue send-now button (suffix: queueItemId) */
export const TID_CHAT_QUEUE_SEND_NOW_BUTTON = "chat-queue-send-now-button";
/** Chat queue item edit button (suffix: queueItemId) */
export const TID_CHAT_QUEUE_EDIT_BUTTON = "chat-queue-edit-button";
/** Chat queue item edit input (suffix: queueItemId) */
export const TID_CHAT_QUEUE_EDIT_INPUT = "chat-queue-edit-input";
/** Chat queue item edit save button (suffix: queueItemId) */
export const TID_CHAT_QUEUE_EDIT_SAVE_BUTTON = "chat-queue-edit-save-button";
/** Chat queue item edit cancel button (suffix: queueItemId) */
export const TID_CHAT_QUEUE_EDIT_CANCEL_BUTTON = "chat-queue-edit-cancel-button";
/** Chat queue item delete button (suffix: queueItemId) */
export const TID_CHAT_QUEUE_REMOVE_BUTTON = "chat-queue-remove-button";
/** Chat queue item drag handle (suffix: queueItemId) */
export const TID_CHAT_QUEUE_DRAG_HANDLE = "chat-queue-drag-handle";
/** Chat user message container (suffix: messageId) */
export const TID_CHAT_USER_MESSAGE = "chat-user-message";
/** Chat assistant message container (suffix: messageId) */
export const TID_CHAT_ASSISTANT_MESSAGE = "chat-assistant-message";
/** Assistant message history collapse trigger (suffix: historyStateKey) */
export const TID_CHAT_ASSISTANT_HISTORY_TRIGGER = "chat-assistant-history-trigger";
/** Assistant message history collapse content (suffix: historyStateKey) */
export const TID_CHAT_ASSISTANT_HISTORY_CONTENT = "chat-assistant-history-content";
/** Standalone background-result turn title (suffix: turn key) */
export const TID_CHAT_BACKGROUND_RESULT_TITLE = "chat-background-result-title";
/** Chat tool-call block container (suffix: toolCallId) */
export const TID_CHAT_TOOL_CALL_BLOCK = "chat-tool-call-block";
/** Chat user message edit button (suffix: messageId) */
export const TID_CHAT_MESSAGE_EDIT_BUTTON = "chat-message-edit-button";
/** Chat user message edit input (suffix: messageId) */
export const TID_CHAT_MESSAGE_EDIT_INPUT = "chat-message-edit-input";
/** Chat user message edit submit button (suffix: messageId) */
export const TID_CHAT_MESSAGE_EDIT_SUBMIT = "chat-message-edit-submit";
/** Chat user message edit cancel button (suffix: messageId) */
export const TID_CHAT_MESSAGE_EDIT_CANCEL = "chat-message-edit-cancel";
/** Assistant message fork button (suffix: messageId) */
export const TID_CHAT_MESSAGE_FORK_BUTTON = "chat-message-fork-button";
/** Change-summary undo/reapply button (suffix: messageId) */
export const TID_CHAT_CHANGE_SUMMARY_TOGGLE_FILES_BUTTON =
  "chat-change-summary-toggle-files-button";
/** Chat input prefix-suggestion panel */
export const TID_PROMPT_SUGGESTION_PANEL = "prompt-suggestion-panel";
/** Chat input prefix-suggestion group (suffix: group id) */
export const TID_PROMPT_SUGGESTION_SECTION = "prompt-suggestion-section";
/** Chat input prefix-suggestion option (suffix: option id) */
export const TID_PROMPT_SUGGESTION_OPTION = "prompt-suggestion-option";
/** Chat input prefix-suggestion status row (suffix: group id) */
export const TID_PROMPT_SUGGESTION_STATUS = "prompt-suggestion-status";

// TaskList
/** Task list container */
export const TID_TASK_LIST = "task-list";
/** New task button */
export const TID_TASK_NEW_BUTTON = "task-new-button";
/** Task list item (suffix: taskId) */
export const TID_TASK_ITEM = "task-item";
/** Task list empty state */
export const TID_TASK_EMPTY = "task-empty";
/** Task archive button (suffix: taskId) */
export const TID_TASK_ARCHIVE = "task-archive";
/** Settings entry button below the task list */
export const TID_TASK_SETTINGS_BUTTON = "task-settings-button";

// Settings
/** Settings page container */
export const TID_SETTINGS_PAGE = "settings-page";
/** Settings back-to-workspace button */
export const TID_SETTINGS_BACK_BUTTON = "settings-back-button";
/** Settings left-section entry (suffix: section id) */
export const TID_SETTINGS_SECTION_NAV = "settings-section-nav";
/** General-settings enhanced Find/Grep toggle */
export const TID_SETTINGS_NATIVE_SEARCH_SWITCH = "settings-native-search-switch";
/** General-settings data-store path read-only input */
export const TID_SETTINGS_DATA_BASE_DIR_INPUT = "settings-data-base-dir-input";
/** General-settings data-store path directory picker */
export const TID_SETTINGS_DATA_BASE_DIR_BROWSE = "settings-data-base-dir-browse";
/** General-settings data-store path save button */
export const TID_SETTINGS_DATA_BASE_DIR_SAVE = "settings-data-base-dir-save";
/** General-settings data-store path copy/pending-restart/failed status */
export const TID_SETTINGS_DATA_BASE_DIR_STATUS = "settings-data-base-dir-status";
/** Resource manager top tab (suffix=cpu|memory|storage) */
export const TID_RESOURCE_MANAGER_TAB = "resource-manager-tab";
/** Resource manager Storage tab: section container */
export const TID_RESOURCE_MANAGER_STORAGE_SECTION = "resource-manager-storage-section";
/** Resource manager Storage tab: total usage figure */
export const TID_RESOURCE_MANAGER_STORAGE_TOTAL = "resource-manager-storage-total";
/** Resource manager Storage tab: scan state (data-state=scanning|complete|cancelled|failed|idle) */
export const TID_RESOURCE_MANAGER_STORAGE_STATUS = "resource-manager-storage-status";
/** Resource manager Storage tab: rescan button */
export const TID_RESOURCE_MANAGER_STORAGE_RESCAN = "resource-manager-storage-rescan";
/** Resource manager Storage tab: disk card (suffix: volume key index) */
export const TID_RESOURCE_MANAGER_STORAGE_DISK_CARD = "resource-manager-storage-disk-card";
/** Resource manager Storage tab: root row inside a disk card (suffix=rootId) */
export const TID_RESOURCE_MANAGER_STORAGE_ROOT = "resource-manager-storage-root";
/** Resource manager Storage tab: category row (suffix=categoryId) */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW = "resource-manager-storage-category-row";
/** Resource manager Storage tab: category row size (suffix=categoryId) */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_SIZE = "resource-manager-storage-category-size";
/** Resource manager Storage tab: category clean button (suffix=categoryId) */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN =
  "resource-manager-storage-category-clean";
/** Resource manager Storage tab: category detail view */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL = "resource-manager-storage-detail";
/** Resource manager Storage tab: detail back button */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL_BACK = "resource-manager-storage-detail-back";
/** Resource manager Storage tab: detail item row */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL_ENTRY = "resource-manager-storage-detail-entry";
/** Resource manager Storage tab: clean confirmation dialog */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_DIALOG =
  "resource-manager-storage-confirm-dialog";
/** Resource manager Storage tab: clean confirmation confirm button */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_ACCEPT =
  "resource-manager-storage-confirm-accept";
/** Resource manager Storage tab: clean confirmation cancel button */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_CANCEL =
  "resource-manager-storage-confirm-cancel";
/** Master toggle in the Memory settings section */
export const TID_SETTINGS_MEMORY_SWITCH = "settings-memory-switch";
/** Refresh button in the Memory settings section */
export const TID_SETTINGS_MEMORY_REFRESH = "settings-memory-refresh";
/** Memory workspace-scope menu trigger */
export const TID_SETTINGS_MEMORY_SCOPE_TRIGGER = "settings-memory-scope-trigger";
/** Memory workspace-scope icon */
export const TID_SETTINGS_MEMORY_SCOPE_ICON = "settings-memory-scope-icon";
/** File count for the current Memory workspace */
export const TID_SETTINGS_MEMORY_COUNT = "settings-memory-count";
/** Memory file-name search input */
export const TID_SETTINGS_MEMORY_SEARCH_INPUT = "settings-memory-search-input";
/** Memory file-name search clear button */
export const TID_SETTINGS_MEMORY_SEARCH_CLEAR = "settings-memory-search-clear";
/** Memory back-to-project-list button in the project file list */
export const TID_SETTINGS_MEMORY_BACK_PROJECTS = "settings-memory-back-projects";
/** Memory back-to-project-list button in the file content view */
export const TID_SETTINGS_MEMORY_BACK_MEMORIES = "settings-memory-back-memories";
/** Memory workspace row (suffix: workspace id) */
export const TID_SETTINGS_MEMORY_WORKSPACE = "settings-memory-workspace";

/** Memory file row (suffix: file name) */
export const TID_SETTINGS_MEMORY_FILE = "settings-memory-file";
/** Memory file type icon (suffix: file name) */
export const TID_SETTINGS_MEMORY_FILE_ICON = "settings-memory-file-icon";
/** Memory file name (suffix: file name) */
export const TID_SETTINGS_MEMORY_FILE_NAME = "settings-memory-file-name";
/** Memory file updated-at (suffix: file name) */
export const TID_SETTINGS_MEMORY_FILE_UPDATED_AT = "settings-memory-file-updated-at";
/** Memory file editor button group (suffix: file name) */
export const TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS = "settings-memory-file-editor-actions";
/** Memory raw Markdown preview */
export const TID_SETTINGS_MEMORY_PREVIEW = "settings-memory-preview";
/** General-settings AskUserQuestion auto-continue toggle */
export const TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH =
  "settings-ask-user-question-auto-resolution-switch";
/** General-settings UI language dropdown trigger */
export const TID_SETTINGS_LOCALE_SELECT_TRIGGER = "settings-locale-select-trigger";
/** General-settings UI language dropdown option (suffix: locale preference) */
export const TID_SETTINGS_LOCALE_SELECT_ITEM = "settings-locale-select-item";
/** User/workspace MCP list row (suffix: MCP runtime name) */
export const TID_MCP_SERVER_ROW = "mcp-server-row";
/** Plugin MCP list row (suffix: MCP runtime name) */
export const TID_PLUGIN_MCP_SERVER_ROW = "plugin-mcp-server-row";
/** MCP OAuth authorize button (suffix: MCP runtime name) */
export const TID_MCP_OPEN_AUTHORIZATION_BUTTON = "mcp-open-authorization-button";
/** Subagent list row (suffix: subagent name) */
export const TID_SUBAGENT_ROW = "subagent-row";
/** Built-in subagent model select (suffix: subagent name) */
export const TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER = "subagent-built-in-model-trigger";
/** Settings usage top-level tab (suffix: usage tab id) */
export const TID_SETTINGS_USAGE_TAB = "settings-usage-tab";
/** Remaining-quota submenu entry in the sidebar avatar menu */
export const TID_SIDEBAR_USAGE_REMAINING_TRIGGER = "sidebar-usage-remaining-trigger";
/** Usage-stats entry in the sidebar avatar menu */
export const TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON = "sidebar-coding-plan-usage-button";

// Model Provider Settings
/** Model-provider top add button */
export const TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON = "model-provider-add-provider-button";
/** Model-provider template selection page */
export const TID_MODEL_PROVIDER_TEMPLATE_PICKER = "model-provider-template-picker";
/** Model-provider template option (suffix: templateId; custom means fully custom) */
export const TID_MODEL_PROVIDER_TEMPLATE_ITEM = "model-provider-template-item";
/** Model-provider back-to-provider-detail button on the template page */
export const TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON = "model-provider-template-back-button";
/** Model-provider left nav item (suffix: provider node key) */
export const TID_MODEL_PROVIDER_NAV_ITEM = "model-provider-nav-item";
/** Model-provider connection-kind dropdown trigger */
export const TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER = "model-provider-connection-mode-trigger";
/** Quick entry showing the number of existing Start Plans in settings. */
export const TID_MODEL_PROVIDER_START_PLAN_COUNT_SHORTCUT =
  "model-provider-start-plan-count-shortcut";
export const TID_MODEL_PROVIDER_START_PLAN_SWITCH_PREFIX =
  "model-provider-start-plan-switch-prefix";
/** Model-provider connection-kind dropdown option (suffix: connection-kind key) */
export const TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM = "model-provider-connection-mode-item";
/** Model-provider detail API key input */
export const TID_MODEL_PROVIDER_API_KEY_INPUT = "model-provider-api-key-input";
/** Model-provider name edit button */
export const TID_MODEL_PROVIDER_NAME_EDIT_BUTTON = "model-provider-name-edit-button";
/** Model-provider name edit input */
export const TID_MODEL_PROVIDER_NAME_INPUT = "model-provider-name-input";
/** Model-provider base URL input */
export const TID_MODEL_PROVIDER_BASE_URL_INPUT = "model-provider-base-url-input";
/** Model-provider API-format dropdown trigger */
export const TID_MODEL_PROVIDER_API_FORMAT_TRIGGER = "model-provider-api-format-trigger";
/** Model-provider API-format dropdown option (suffix: API format) */
export const TID_MODEL_PROVIDER_API_FORMAT_ITEM = "model-provider-api-format-item";
/** Model-provider model input (suffix: model row index) */
export const TID_MODEL_PROVIDER_MODEL_INPUT = "model-provider-model-input";
/** Model-provider model delete button (suffix: model row index) */
export const TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON = "model-provider-model-delete-button";
/** Model-provider add-model button */
export const TID_MODEL_PROVIDER_ADD_MODEL_BUTTON = "model-provider-add-model-button";

// Chat Toolbar
/** Chat toolbar model select button */
export const TID_CHAT_MODEL_SELECT_TRIGGER = "chat-model-select-trigger";
/** Chat toolbar model provider group (suffix: provider group key) */
export const TID_CHAT_MODEL_SELECT_GROUP = "chat-model-select-group";
/** Chat toolbar model option (suffix: model value) */
export const TID_CHAT_MODEL_SELECT_ITEM = "chat-model-select-item";
/** Chat toolbar thinking-level select button */
export const TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER = "chat-thought-level-select-trigger";
/** Chat toolbar thinking-level option (suffix: thinking-level value) */
export const TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM = "chat-thought-level-select-item";
/** Chat toolbar mode select button (v4 switchCollaborationMode e2e anchor) */
export const TID_CHAT_MODE_SELECT_TRIGGER = "chat-mode-select-trigger";
/** Chat toolbar mode option (suffix: mode value) */
export const TID_CHAT_MODE_SELECT_ITEM = "chat-mode-select-item";
/** Chat toolbar context-usage button */
export const TID_CHAT_CONTEXT_USAGE_TRIGGER = "chat-context-usage-trigger";
/** Thinking block collapse toggle */
export const TID_CHAT_REASONING_TRIGGER = "chat-reasoning-trigger";
/** Thinking block collapsed content container */
export const TID_CHAT_REASONING_CONTENT = "chat-reasoning-content";

// Workspace
/** Main content header */
export const TID_WORKSPACE_HEADER = "workspace-header";
/** Workspace title */
export const TID_WORKSPACE_TITLE = "workspace-title";
/** Workspace path */
export const TID_WORKSPACE_PATH = "workspace-path";
/** Workspace header more-actions menu button */
export const TID_WORKSPACE_MORE_BUTTON = "workspace-more-button";
/** Top-right help (?) menu trigger */
export const TID_WORKSPACE_HELP_MENU_TRIGGER = "workspace-help-menu-trigger";
/** Resource-manager item in the help menu (desktop only) */
export const TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER = "workspace-help-menu-resource-manager";
/** Sidebar open workspace file tree button (suffix: workspacePath) */
export const TID_WORKSPACE_FILE_TREE_BUTTON = "workspace-file-tree-button";
/** Workspace file tree panel */
export const TID_WORKSPACE_FILE_TREE_PANEL = "workspace-file-tree-panel";
/** Workspace file tree refresh button */
export const TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON = "workspace-file-tree-refresh-button";
/** Workspace file tree item (suffix: absolute file path) */
export const TID_WORKSPACE_FILE_TREE_ROW = "workspace-file-tree-row";
// SSH error messages
/** SSH connection error message */
export const TID_SSH_ERROR = "ssh-error";
/** SSH connection success message */
export const TID_SSH_SUCCESS = "ssh-success";

// V4 session panes (protocol-v4 vertical slice; the targeting protocol carries a paneId dimension:
// two panes of one session are told apart by the paneId suffix).
/** v4 session pane container (suffix: paneId) */
export const TID_V4_SESSION_PANE = "v4-session-pane";
/** v4 message timeline container */
export const TID_V4_TIMELINE = "v4-timeline";
/** v4 timeline empty-state placeholder */
export const TID_V4_TIMELINE_EMPTY = "v4-timeline-empty";
/** v4 projected row (suffix: rowId) */
export const TID_V4_ROW = "v4-row";
/** v4 workspace hook pending-review banner container */
export const TID_V4_WORKSPACE_HOOK_PENDING_BANNER = "v4-workspace-hook-pending-banner";
/** v4 workspace hook banner review-now button */
export const TID_V4_WORKSPACE_HOOK_PENDING_REVIEW = "v4-workspace-hook-pending-review";
/** v4 workspace hook banner ignore button */
export const TID_V4_WORKSPACE_HOOK_PENDING_DISMISS = "v4-workspace-hook-pending-dismiss";
/** v4 composer container */
export const TID_V4_COMPOSER = "v4-composer";
/** v4 composer text input */
export const TID_V4_COMPOSER_INPUT = "v4-composer-input";
/** v4 composer current-session background-tasks entry */
export const TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER = "v4-composer-background-work-trigger";
/** v4 composer persistent computer-use (CUA) entry button */
export const TID_V4_COMPOSER_CUA_ENTRY = "v4-composer-cua-entry";
/** v4 composer send button */
export const TID_V4_COMPOSER_SEND = "v4-composer-send";
/** v4 paused-queue send confirm: clear queue and send */
export const TID_V4_COMPOSER_CLEAR_QUEUE_SEND = "v4-composer-clear-queue-send";
/** v4 paused-queue send confirm: keep queue and send */
export const TID_V4_COMPOSER_KEEP_QUEUE_SEND = "v4-composer-keep-queue-send";
/** v4 paused-queue send confirm dialog */
export const TID_V4_PAUSED_QUEUE_SEND_DIALOG = "v4-paused-queue-send-dialog";
/** v4 composer attachment chip (suffix: attachment id) */
export const TID_V4_ATTACHMENT = "v4-attachment";
/** v4 composer attachment upload progress (suffix: attachment id) */
export const TID_V4_ATTACHMENT_UPLOAD_PROGRESS = "v4-attachment-upload-progress";
/** v4 composer attachment upload retry (suffix: attachment id) */
export const TID_V4_ATTACHMENT_UPLOAD_RETRY = "v4-attachment-upload-retry";
/** v4 stop button */
export const TID_V4_STOP = "v4-stop";
/** v4 assistant row fork button (suffix: rowId) */
export const TID_V4_FORK = "v4-fork";
/** v4 assistant row retry button (suffix: rowId) */
export const TID_V4_RETRY = "v4-retry";
/** v4 assistant row like button (suffix: rowId) */
export const TID_V4_FEEDBACK_LIKE = "v4-feedback-like";
/** v4 assistant row dislike button (suffix: rowId) */
export const TID_V4_FEEDBACK_DISLIKE = "v4-feedback-dislike";
/** v4 turn hook details button (suffix: product turnId) */
export const TID_V4_HOOK_DETAILS_TRIGGER = "v4-hook-details-trigger";
/** v4 turn hook details popover (suffix: product turnId) */
export const TID_V4_HOOK_DETAILS_CONTENT = "v4-hook-details-content";
/** v4 user row edit button (suffix: rowId) */
export const TID_V4_EDIT = "v4-edit";
/** v4 user query edit input (suffix: rowId) */
export const TID_V4_EDIT_INPUT = "v4-edit-input";
/** v4 user query edit submit button (suffix: rowId) */
export const TID_V4_EDIT_SUBMIT = "v4-edit-submit";
/** v4 user query edit cancel button (suffix: rowId) */
export const TID_V4_EDIT_CANCEL = "v4-edit-cancel";
/** v4 user query edit attachment remove button (suffix: rowId-index) */
export const TID_V4_EDIT_ATTACHMENT_REMOVE = "v4-edit-attachment-remove";
export const TID_V4_EDIT_REWIND_WORKSPACE = "v4-edit-rewind-workspace";
/** v4 edit file-conflict dialog */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG = "v4-edit-workspace-conflict-dialog";
/** v4 edit fallback to conversation-only trim after a file conflict */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY =
  "v4-edit-workspace-conflict-conversation-only";
/** v4 queue panel container */
export const TID_V4_QUEUE = "v4-queue";
/** v4 paused-queue reason/resume banner */
export const TID_V4_QUEUE_PAUSED_BANNER = "v4-queue-paused-banner";
/** v4 paused-queue resume-auto-consume button */
export const TID_V4_QUEUE_RESUME = "v4-queue-resume";
/** v4 queue item inline edit input (suffix: queueItemId) */
/** v4 queue item (suffix: queueItemId) */
export const TID_V4_QUEUE_ITEM = "v4-queue-item";
/** v4 queue item delete button (suffix: queueItemId) */
export const TID_V4_QUEUE_ITEM_DELETE = "v4-queue-item-delete";
/** v4 queue item edit button (suffix: queueItemId) */
export const TID_V4_QUEUE_ITEM_EDIT = "v4-queue-item-edit";
/** v4 queue item send-now button (suffix: queueItemId) */
export const TID_V4_QUEUE_ITEM_SEND_NOW = "v4-queue-item-send-now";
/** v4 queue item move-up button (suffix: queueItemId) */
export const TID_V4_QUEUE_ITEM_UP = "v4-queue-item-up";
/** v4 input control: queue auto-drain toggle (setAutoDrain command) */
export const TID_V4_AUTODRAIN_TOGGLE = "v4-autodrain-toggle";
/** v4 input control: follow-up routing mode toggle (setFollowupMode command) */
export const TID_V4_FOLLOWUP_TOGGLE = "v4-followup-toggle";
/** v4 session title display (meta.title; placeholder when empty) */
export const TID_V4_SESSION_TITLE = "v4-session-title";
/** v4 session rename input (renameSession command) */
export const TID_V4_RENAME_INPUT = "v4-rename-input";
/** v4 session rename submit button (renameSession command) */
export const TID_V4_RENAME_SUBMIT = "v4-rename-submit";
/** v4 goal status banner (objective + status; projection of sendGoalCommand/resumeGoal effects) */
export const TID_V4_GOAL_BANNER = "v4-goal-banner";
/** v4 session delete button (deleteSession command; returns to draft) */
export const TID_V4_DELETE_SESSION = "v4-delete-session";
/** v4 background-works panel (projection of backgroundWorks) */
export const TID_V4_BACKGROUND_WORKS = "v4-background-works";
/** v4 background work item (suffix: workId) */
export const TID_V4_BACKGROUND_WORK_ITEM = "v4-background-work-item";
/** v4 background work cancel button (cancelBackgroundWork command; suffix: workId) */
export const TID_V4_BACKGROUND_WORK_CANCEL = "v4-background-work-cancel";
/** v4 model config display (data-provider/data-model/data-thought; projection of switchModelConfig) */
export const TID_V4_MODEL_CONFIG = "v4-model-config";
// v4-model-provider-input / v4-model-model-input / v4-model-thought-input /
// v4-model-apply (debug form) is retired; model switching lives in the composer toolbar via
// TID_CHAT_MODEL_SELECT_* / TID_CHAT_THOUGHT_LEVEL_SELECT_*.
/** v4 subscription-failure reconnect button */
export const TID_V4_RETRY_SUBSCRIBE = "v4-retry-subscribe";
/** v4 userInput interaction dialog container */
export const TID_V4_USER_INPUT_DIALOG = "v4-user-input-dialog";
/** v4 userInput option button (suffix: optionId) */
export const TID_V4_USER_INPUT_OPTION = "v4-user-input-option";
/** v4 userInput free-text input */
export const TID_V4_USER_INPUT_TEXT = "v4-user-input-text";
/** v4 timeline jump-to-bottom button (appears after unpinning bottom-follow; virtual-scroll anchor) */
export const TID_V4_TIMELINE_BOTTOM = "v4-timeline-bottom";
/** v4 pane shell (Layout/Focus wrapper, suffix: paneId; data-focused marks the focused pane in split view) */
export const TID_V4_PANE_SHELL = "v4-pane-shell";
/** v4 split-right pane button (pane header; phase 1 open-split, phase 2 generalized to split) */
export const TID_V4_SPLIT_OPEN = "v4-split-open";
/** v4 split-down pane button (pane header, grid layout) */
export const TID_V4_SPLIT_DOWN = "v4-split-down";
/** v4 close-pane button (non-primary pane header; phase 1 close-split) */
export const TID_V4_SPLIT_CLOSE = "v4-split-close";
/** v4 split drag divider (pointer-drag resize; data-split-id marks the split node) */
export const TID_V4_SPLIT_DIVIDER = "v4-split-divider";
/** v4 pane header workspace badge (shows owning workspace on cross-workspace panes) */
export const TID_V4_PANE_WORKSPACE_BADGE = "v4-pane-workspace-badge";
/** Sidebar session context-menu open-in-split item (desktop shell only, final pass) */
export const TID_V4_TASK_OPEN_IN_SPLIT = "v4-task-open-in-split";
/** v4 timeline load-earlier button (cursor pagination; shown while the window head is above the global head) */
export const TID_V4_TIMELINE_LOAD_OLDER = "v4-timeline-load-older";
/** v4 turn navigation rail (wide layouts, 2+ navigable turns) */
export const TID_V4_TURN_NAVIGATOR = "v4-turn-navigator";
/** v4 turn navigation item (suffix: render unit key) */
export const TID_V4_TURN_NAVIGATOR_ITEM = "v4-turn-navigator-item";
/** v4 turn navigation hover-card preview (suffix: render unit key) */
export const TID_V4_TURN_NAVIGATOR_TOOLTIP = "v4-turn-navigator-tooltip";
/** v4 subagent row drill-down toggle (suffix: rowId; clickable only with childSessionId) */
export const TID_V4_SUBAGENT_TOGGLE = "v4-subagent-toggle";
/** v4 subagent drill-down mini timeline (suffix: childSessionId) */
export const TID_V4_SUBAGENT_DRILLDOWN = "v4-subagent-drilldown";
/** v4 subagent drill-down open-in-split entry (suffix: childSessionId) */
/** @deprecated subagent details moved to right-side tabs; constant kept so legacy external tests still compile. */
export const TID_V4_SUBAGENT_OPEN_SPLIT = "v4-subagent-open-split";
export const TID_V4_SUBAGENT_OPEN_SIDE_PANE = "v4-subagent-open-side-pane";
/** v4 userInput row attachment list (suffix: rowId) */
export const TID_V4_ROW_ATTACHMENTS = "v4-row-attachments";

// Plugin store
/** Entry button to the plugin store in plugin settings (the store is a WorkspaceShell main view, not a settings section) */
export const TID_PLUGIN_STORE_BROWSE = "plugin-store-browse";

// Automations / scheduled tasks
export const TID_AUTOMATIONS_OPEN = "automations-open";
export const TID_AUTOMATIONS_LIST = "automations-list";
/** Status filter pill row shared by scheduled/off-peak lists (all/running/completed/failed) */
export const TID_AUTOMATIONS_STATUS_FILTER = "automations-status-filter";
export const TID_AUTOMATION_CREATE_MENU = "automation-create-menu";
export const TID_AUTOMATION_CREATE_MANUALLY = "automation-create-manually";
export const TID_AUTOMATION_CARD = "automation-card";
// Off-peak tasks (standalone surface)
export const TID_OFFPEAK_CREATE_BUTTON = "offpeak-create-button";
export const TID_OFFPEAK_CARD = "offpeak-card";
/** Off-peak card footnote: bound session title (created in-session). */
export const TID_OFFPEAK_CARD_SESSION = "offpeak-card-session";
export const TID_OFFPEAK_CARD_MENU = "offpeak-card-menu";
export const TID_OFFPEAK_EDIT_VIEW = "offpeak-edit-view";
export const TID_OFFPEAK_EDIT_SUBMIT = "offpeak-edit-submit";
export const TID_OFFPEAK_FORM_TITLE = "offpeak-form-title";
export const TID_OFFPEAK_FORM_INSTRUCTIONS = "offpeak-form-instructions";
export const TID_OFFPEAK_ACTION_PAUSE = "offpeak-action-pause";
export const TID_OFFPEAK_ACTION_CONTINUE = "offpeak-action-continue";
export const TID_OFFPEAK_ACTION_DELETE = "offpeak-action-delete";
export const TID_OFFPEAK_TAB = "offpeak-tab";
export const TID_AUTOMATION_CARD_MENU = "automation-card-menu";
export const TID_AUTOMATION_ACTION_TOGGLE = "automation-action-toggle";
export const TID_AUTOMATION_ACTION_DELETE = "automation-action-delete";
export const TID_AUTOMATION_FORM_TITLE = "automation-form-title";
export const TID_AUTOMATION_FORM_PROMPT = "automation-form-prompt";
export const TID_AUTOMATION_FORM_SUBMIT = "automation-form-submit";
export const TID_AUTOMATION_RUN_NOW = "automation-run-now";
export const TID_AUTOMATION_EDIT_BACK = "automation-edit-back";
// Schedule builder / custom recurrence / year-month-day pickers (stable e2e anchors)
export const TID_AUTOMATION_FREQUENCY_SELECT = "automation-frequency-select";
export const TID_AUTOMATION_FREQUENCY_OPTION = "automation-frequency-option";
export const TID_AUTOMATION_CUSTOM_UNIT_SELECT = "automation-custom-unit-select";
export const TID_AUTOMATION_CUSTOM_UNIT_OPTION = "automation-custom-unit-option";
export const TID_AUTOMATION_CUSTOM_INTERVAL_SELECT = "automation-custom-interval-select";
export const TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT = "automation-custom-interval-increment";
export const TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT = "automation-custom-interval-decrement";
export const TID_AUTOMATION_CUSTOM_INTERVAL_OPTION = "automation-custom-interval-option";
export const TID_AUTOMATION_CUSTOM_REPEAT_EDIT = "automation-custom-repeat-edit";
export const TID_AUTOMATION_CUSTOM_CONFIRM = "automation-custom-confirm";
export const TID_AUTOMATION_YEAR_MONTHDAY = "automation-year-monthday";
export const TID_AUTOMATION_YEAR_MONTH_OPTION = "automation-year-month-option";
export const TID_AUTOMATION_YEAR_DAY_OPTION = "automation-year-day-option";
export const TID_AUTOMATION_SCHEDULE_PREVIEW = "automation-schedule-preview";
export const TID_AUTOMATION_SCHEDULE_ADD = "automation-schedule-add";
export const TID_AUTOMATION_SCHEDULE_DELETE = "automation-schedule-delete";
export const TID_CRON_CREATE_CARD = "cron-create-card";
export const TID_CRON_CREATE_OPEN = "cron-create-open";
export const TID_OFFPEAK_CREATE_CARD = "offpeak-create-card";
export const TID_OFFPEAK_CREATE_OPEN = "offpeak-create-open";
export const TID_CONFIRM_DIALOG_CONFIRM = "confirm-dialog-confirm";

/** Builds a suffixed testid for dynamic elements, e.g. file-tree-item-/home/user */
export function testId(base: string, suffix: string): string {
  return `${base}-${suffix}`;
}

/** Manually claimable Start Plan banner above the sidebar avatar. */
export const TID_MANUAL_CLAIM_PLAN_BANNER = "manual-claim-plan-banner";

/** Plugin UI sandbox card container and its webview. */
export const TID_PLUGIN_UI_CARD = "plugin-ui-card";
export const TID_PLUGIN_UI_OPEN_SIDE_PANE = "plugin-ui-open-side-pane";
export const TID_PLUGIN_UI_WEBVIEW = "plugin-ui-webview";
export const TID_START_PLAN_RECOMMENDATION_DIALOG = "start-plan-recommendation-dialog";

/** Diagnostic-log consent toggle for user feedback */
export const TID_FEEDBACK_LOGS_OPT_IN = "feedback-logs-opt-in";
