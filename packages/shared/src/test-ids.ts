/**
 * Single source of truth for every data-testid, shared by UI components and E2E tests.
 * Add new testids here instead of hardcoding strings inside components.
 * Each entry must carry a descriptive comment.
 */

// Login entry
/** Top-right login trigger button */
export const TID_LOGIN_TRIGGER = "login-trigger";
/** Login action in the user menu */
export const TID_LOGIN_MENU_ITEM = "login-menu-item";
/** Login page: switch to API key sign-in button */
export const TID_LOGIN_USE_API_KEY_BUTTON = "login-use-api-key-button";
/** API key login provider selector trigger */
export const TID_LOGIN_API_KEY_PROVIDER_TRIGGER = "login-api-key-provider-trigger";
/** API key login provider option (suffix: provider choice) */
export const TID_LOGIN_API_KEY_PROVIDER_ITEM = "login-api-key-provider-item";
/** API key login key input */
export const TID_LOGIN_API_KEY_INPUT = "login-api-key-input";
/** API key login continue button */
export const TID_LOGIN_API_KEY_CONTINUE_BUTTON = "login-api-key-continue-button";
/** API key login cancel button */
export const TID_LOGIN_API_KEY_CANCEL_BUTTON = "login-api-key-cancel-button";
/** API key login skip-for-now button */
export const TID_LOGIN_API_KEY_SKIP_BUTTON = "login-api-key-skip-button";
/** API key login error message */
export const TID_LOGIN_API_KEY_ERROR = "login-api-key-error";
/** Login button inside the OAuth popup */
export const TID_OAUTH_LOGIN_BUTTON = "oauth-login-button";
/** OAuth popup cancel button */
export const TID_OAUTH_CANCEL = "oauth-cancel";
/** OAuth error text */
export const TID_OAUTH_ERROR = "oauth-error";

// App
/** Top navigation bar */
export const TID_APP_HEADER = "app-header";
/** Language switcher button */
export const TID_LOCALE_TOGGLE = "locale-toggle";
/** Theme toggle button */
export const TID_THEME_TOGGLE = "theme-toggle";
/** Logout button */
export const TID_LOGOUT_BUTTON = "logout-button";
/** Terminal visibility toggle */
export const TID_TERMINAL_TOGGLE = "terminal-toggle";
export const TID_SIDE_PANE_TOGGLE = "side-pane-toggle";
/** Terminal panel close button */
export const TID_TERMINAL_CLOSE_BUTTON = "terminal-close-button";
/** Browser visibility toggle */
export const TID_BROWSER_TOGGLE = "browser-toggle";
/** Git panel visibility toggle */
export const TID_GIT_TOGGLE = "git-toggle";
/** Browser panel container */
export const TID_BROWSER_PANE = "browser-pane";
/** Browser panel close button */
export const TID_BROWSER_CLOSE_BUTTON = "browser-close-button";
/** Git panel container */
export const TID_GIT_PANE = "git-pane";
/** Git panel close button */
export const TID_GIT_CLOSE_BUTTON = "git-close-button";
/** Top-level Git commit/push entry */
export const TID_GIT_ACTION_TRIGGER = "git-action-trigger";
/** Git commit dialog */
export const TID_GIT_COMMIT_DIALOG = "git-commit-dialog";
/** Git commit message input */
export const TID_GIT_COMMIT_MESSAGE_INPUT = "git-commit-message-input";
/** Git commit message generate button */
export const TID_GIT_COMMIT_GENERATE_BUTTON = "git-commit-generate-button";
/** Git commit dialog include-unstaged toggle */
export const TID_GIT_COMMIT_INCLUDE_UNSTAGED = "git-commit-include-unstaged";
/** Git commit dialog footer command action list */
export const TID_GIT_COMMIT_ACTION_COMMAND = "git-commit-action-command";
/** Git commit dialog footer action item (suffix: action id) */
export const TID_GIT_COMMIT_ACTION_ITEM = "git-commit-action-item";
/** Browser URL input */
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
/** Browser free-size zoom selector */
export const TID_BROWSER_RESPONSIVE_ZOOM_SELECT = "browser-responsive-zoom-select";
/** Browser free-size zoom option (suffix: zoom value) */
export const TID_BROWSER_RESPONSIVE_ZOOM_OPTION = "browser-responsive-zoom-option";
/** Browser free-size zoomed-canvas placeholder */
export const TID_BROWSER_RESPONSIVE_SCALED_FRAME = "browser-responsive-scaled-frame";
/** Browser free-size left resize handle */
export const TID_BROWSER_RESPONSIVE_RESIZE_LEFT = "browser-responsive-resize-left";
/** Browser free-size right resize handle */
export const TID_BROWSER_RESPONSIVE_RESIZE_WIDTH = "browser-responsive-resize-width";
/** Browser free-size top resize handle */
export const TID_BROWSER_RESPONSIVE_RESIZE_TOP = "browser-responsive-resize-top";
/** Browser free-size bottom resize handle */
export const TID_BROWSER_RESPONSIVE_RESIZE_HEIGHT = "browser-responsive-resize-height";
/** Browser free-size top-left drag corner */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_LEFT =
  "browser-responsive-resize-corner-top-left";
/** Browser free-size top-right drag corner */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_RIGHT =
  "browser-responsive-resize-corner-top-right";
/** Browser free-size bottom-left drag corner */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_BOTTOM_LEFT =
  "browser-responsive-resize-corner-bottom-left";
/** Browser free-size bottom-right drag corner */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER = "browser-responsive-resize-corner";
/** Browser element-picker button */
export const TID_BROWSER_ELEMENT_PICKER_BUTTON = "browser-element-picker-button";
/** Browser URL bar overflow menu button */
export const TID_BROWSER_MORE_BUTTON = "browser-more-button";
/** Browser open-in-default-browser menu item */
export const TID_BROWSER_OPEN_EXTERNAL_ITEM = "browser-open-external-item";
/** Browser open-devtools button */
export const TID_BROWSER_DEVTOOLS_BUTTON = "browser-devtools-button";
/** Browser web view */
export const TID_BROWSER_WEBVIEW = "browser-webview";
/** Browser page-load-failure readable error state */
export const TID_BROWSER_LOAD_ERROR = "browser-load-error";
/** Certificate-override hint inside the load-failure error state */
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
/** Tool call summary row trigger (suffix: toolId) */
export const TID_TOOL_SUMMARY_TRIGGER = "tool-summary-trigger";

// Terminal
/** Terminal container */
export const TID_TERMINAL = "terminal";

// SSHDialog
/** Trigger for the SSH connection dialog */
export const TID_SSH_CONNECT_TRIGGER = "ssh-connect-trigger";
/** SSH connection dialog container */
export const TID_SSH_DIALOG = "ssh-dialog";
/** Remote connection mode: switch to SSH */
export const TID_REMOTE_KIND_SSH = "remote-kind-ssh";
/** Remote connection mode: switch to WSL */
export const TID_REMOTE_KIND_WSL = "remote-kind-wsl";
/** Remote connection mode: switch to Docker */
export const TID_REMOTE_KIND_DOCKER = "remote-kind-docker";
/** SSH host input */
export const TID_SSH_HOST_INPUT = "ssh-host-input";
/** SSH port input */
export const TID_SSH_PORT_INPUT = "ssh-port-input";
/** SSH username input */
export const TID_SSH_USERNAME_INPUT = "ssh-username-input";
/** SSH config alias selector */
export const TID_SSH_CONFIG_ALIAS_SELECT = "ssh-config-alias-select";
/** SSH password input */
export const TID_SSH_PASSWORD_INPUT = "ssh-password-input";
/** SSH key path input */
export const TID_SSH_PRIVATE_KEY_INPUT = "ssh-private-key-input";
/** SSH auth method: password */
export const TID_SSH_AUTH_PASSWORD = "ssh-auth-password";
/** SSH auth method: key file */
export const TID_SSH_AUTH_PRIVATE_KEY = "ssh-auth-private-key";
/** WSL distro selector */
export const TID_WSL_DISTRO_SELECT = "wsl-distro-select";
/** WSL Linux user input */
export const TID_WSL_USER_INPUT = "wsl-user-input";
/** Docker container selector */
export const TID_DOCKER_CONTAINER_SELECT = "docker-container-select";
/** Docker container name/ID input */
export const TID_DOCKER_CONTAINER_INPUT = "docker-container-input";
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
/** Sidebar workspace entry (suffix: workspacePath) */
export const TID_WORKSPACE_ITEM = "workspace-item";
/** Sidebar close-workspace button (suffix: workspacePath) */
export const TID_WORKSPACE_CLOSE = "workspace-close";
/** Conversations sub-section in the project view */
export const TID_CONVERSATION_SECTION = "conversation-section";
/** Projects sub-section in the project view */
export const TID_PROJECT_SECTION = "project-section";
/** New-task button in the conversation section */
export const TID_CONVERSATION_NEW_TASK = "conversation-new-task";
/** Add-menu button in the project section */
export const TID_PROJECT_ADD = "project-add";
/** Composer workspace selector trigger */
export const TID_COMPOSER_WORKSPACE_TRIGGER = "composer-workspace-trigger";
/** Composer workspace menu remote-connection entry */
export const TID_COMPOSER_REMOTE_CONNECTION = "composer-remote-connection";
/** Composer unbind-current-project button */
export const TID_COMPOSER_PROJECT_DETACH = "composer-project-detach";
/** Composer workspace menu non-project entry */
export const TID_COMPOSER_WORK_OUTSIDE_PROJECT = "composer-work-outside-project";
// ChatView
/** Chat view container */
export const TID_CHAT_VIEW = "chat-view";
/** Chat message list */
export const TID_CHAT_MESSAGES = "chat-messages";
/** Error banner above the chat input */
export const TID_CHAT_ERROR_BANNER = "chat-error-banner";
/** Hook block-error details button */
export const TID_CHAT_ERROR_DETAILS_BUTTON = "chat-error-details-button";
/** Hook block-error banner leading icon */
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
/** Chat top-right status summary panel */
export const TID_CHAT_SUMMARY_PANEL = "chat-summary-panel";
/** Chat context-compaction timeline bar (suffix: inputId or operationId) */
export const TID_CHAT_COMPACT_MARKER = "chat-compact-marker";
/** Chat compaction failure/interrupt retry button (suffix: inputId or operationId) */
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
/** Chat queue edit button (suffix: queueItemId) */
export const TID_CHAT_QUEUE_EDIT_BUTTON = "chat-queue-edit-button";
/** Chat queue edit input (suffix: queueItemId) */
export const TID_CHAT_QUEUE_EDIT_INPUT = "chat-queue-edit-input";
/** Chat queue edit save button (suffix: queueItemId) */
export const TID_CHAT_QUEUE_EDIT_SAVE_BUTTON = "chat-queue-edit-save-button";
/** Chat queue edit cancel button (suffix: queueItemId) */
export const TID_CHAT_QUEUE_EDIT_CANCEL_BUTTON = "chat-queue-edit-cancel-button";
/** Chat queue delete button (suffix: queueItemId) */
export const TID_CHAT_QUEUE_REMOVE_BUTTON = "chat-queue-remove-button";
/** Chat queue drag handle (suffix: queueItemId) */
export const TID_CHAT_QUEUE_DRAG_HANDLE = "chat-queue-drag-handle";
/** Chat user message container (suffix: messageId) */
export const TID_CHAT_USER_MESSAGE = "chat-user-message";
/** Chat assistant message container (suffix: messageId) */
export const TID_CHAT_ASSISTANT_MESSAGE = "chat-assistant-message";
/** Assistant message history collapse trigger (suffix: historyStateKey) */
export const TID_CHAT_ASSISTANT_HISTORY_TRIGGER = "chat-assistant-history-trigger";
/** Assistant message history collapsed content (suffix: historyStateKey) */
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
/** Prefix-suggestion group (suffix: group id) */
export const TID_PROMPT_SUGGESTION_SECTION = "prompt-suggestion-section";
/** Prefix-suggestion option (suffix: option id) */
export const TID_PROMPT_SUGGESTION_OPTION = "prompt-suggestion-option";
/** Prefix-suggestion status row (suffix: group id) */
export const TID_PROMPT_SUGGESTION_STATUS = "prompt-suggestion-status";

// TaskList
/** Task list container */
export const TID_TASK_LIST = "task-list";
/** New task button */
export const TID_TASK_NEW_BUTTON = "task-new-button";
/** Task list entry (suffix: taskId) */
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
/** Settings left section entry (suffix: section id) */
export const TID_SETTINGS_SECTION_NAV = "settings-section-nav";
/** General settings enhanced Find/Grep toggle */
export const TID_SETTINGS_NATIVE_SEARCH_SWITCH = "settings-native-search-switch";
/** General settings data-dir read-only input */
export const TID_SETTINGS_DATA_BASE_DIR_INPUT = "settings-data-base-dir-input";
/** General settings data-dir directory picker */
export const TID_SETTINGS_DATA_BASE_DIR_BROWSE = "settings-data-base-dir-browse";
/** General settings data-dir save button */
export const TID_SETTINGS_DATA_BASE_DIR_SAVE = "settings-data-base-dir-save";
/** General settings data-dir copy/pending-restart/failure state */
export const TID_SETTINGS_DATA_BASE_DIR_STATUS = "settings-data-base-dir-status";
/** Resource monitor top tab (suffix: cpu|memory|storage) */
export const TID_RESOURCE_MANAGER_TAB = "resource-manager-tab";
/** Resource monitor storage tab: section container */
export const TID_RESOURCE_MANAGER_STORAGE_SECTION = "resource-manager-storage-section";
/** Resource monitor storage tab: total-usage figure */
export const TID_RESOURCE_MANAGER_STORAGE_TOTAL = "resource-manager-storage-total";
/** Resource monitor storage tab: scan state (data-state=scanning|complete|cancelled|failed|idle) */
export const TID_RESOURCE_MANAGER_STORAGE_STATUS = "resource-manager-storage-status";
/** Resource monitor storage tab: rescan button */
export const TID_RESOURCE_MANAGER_STORAGE_RESCAN = "resource-manager-storage-rescan";
/** Resource monitor storage tab: disk card (suffix: volume key index) */
export const TID_RESOURCE_MANAGER_STORAGE_DISK_CARD = "resource-manager-storage-disk-card";
/** Resource monitor storage tab: disk card root row (suffix: rootId) */
export const TID_RESOURCE_MANAGER_STORAGE_ROOT = "resource-manager-storage-root";
/** Resource monitor storage tab: category row (suffix: categoryId) */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW = "resource-manager-storage-category-row";
/** Resource monitor storage tab: category size (suffix: categoryId) */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_SIZE = "resource-manager-storage-category-size";
/** Resource monitor storage tab: category clean button (suffix: categoryId) */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN =
  "resource-manager-storage-category-clean";
/** Resource monitor storage tab: detail view */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL = "resource-manager-storage-detail";
/** Resource monitor storage tab: detail back button */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL_BACK = "resource-manager-storage-detail-back";
/** Resource monitor storage tab: detail entry row */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL_ENTRY = "resource-manager-storage-detail-entry";
/** Resource monitor storage tab: clean confirm dialog */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_DIALOG =
  "resource-manager-storage-confirm-dialog";
/** Resource monitor storage tab: clean confirm OK button */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_ACCEPT =
  "resource-manager-storage-confirm-accept";
/** Resource monitor storage tab: clean confirm cancel button */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_CANCEL =
  "resource-manager-storage-confirm-cancel";
/** Memory settings master toggle */
export const TID_SETTINGS_MEMORY_SWITCH = "settings-memory-switch";
/** Memory settings refresh button */
export const TID_SETTINGS_MEMORY_REFRESH = "settings-memory-refresh";
/** Memory workspace-scope menu trigger */
export const TID_SETTINGS_MEMORY_SCOPE_TRIGGER = "settings-memory-scope-trigger";
/** Memory workspace-scope icon */
export const TID_SETTINGS_MEMORY_SCOPE_ICON = "settings-memory-scope-icon";
/** Memory current-workspace file count */
export const TID_SETTINGS_MEMORY_COUNT = "settings-memory-count";
/** Memory file-name search input */
export const TID_SETTINGS_MEMORY_SEARCH_INPUT = "settings-memory-search-input";
/** Memory file-name search clear button */
export const TID_SETTINGS_MEMORY_SEARCH_CLEAR = "settings-memory-search-clear";
/** Memory back-to-project-list button in file view */
export const TID_SETTINGS_MEMORY_BACK_PROJECTS = "settings-memory-back-projects";
/** Memory back-to-file-list button in file content view */
export const TID_SETTINGS_MEMORY_BACK_MEMORIES = "settings-memory-back-memories";
/** Memory workspace row (suffix: workspace id) */
export const TID_SETTINGS_MEMORY_WORKSPACE = "settings-memory-workspace";

/** Memory file row (suffix: file name) */
export const TID_SETTINGS_MEMORY_FILE = "settings-memory-file";
/** Memory file-type icon (suffix: file name) */
export const TID_SETTINGS_MEMORY_FILE_ICON = "settings-memory-file-icon";
/** Memory file name (suffix: file name) */
export const TID_SETTINGS_MEMORY_FILE_NAME = "settings-memory-file-name";
/** Memory file updated-at (suffix: file name) */
export const TID_SETTINGS_MEMORY_FILE_UPDATED_AT = "settings-memory-file-updated-at";
/** Memory file editor button group (suffix: file name) */
export const TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS = "settings-memory-file-editor-actions";
/** Memory raw markdown preview */
export const TID_SETTINGS_MEMORY_PREVIEW = "settings-memory-preview";
/** General settings AskUserQuestion auto-continue toggle */
export const TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH =
  "settings-ask-user-question-auto-resolution-switch";
/** General settings UI-language dropdown trigger */
export const TID_SETTINGS_LOCALE_SELECT_TRIGGER = "settings-locale-select-trigger";
/** General settings UI-language option (suffix: locale preference) */
export const TID_SETTINGS_LOCALE_SELECT_ITEM = "settings-locale-select-item";
/** User/workspace MCP list row (suffix: MCP runtime name) */
export const TID_MCP_SERVER_ROW = "mcp-server-row";
/** Plugin MCP list row (suffix: MCP runtime name) */
export const TID_PLUGIN_MCP_SERVER_ROW = "plugin-mcp-server-row";
/** MCP OAuth authorize button (suffix: MCP runtime name) */
export const TID_MCP_OPEN_AUTHORIZATION_BUTTON = "mcp-open-authorization-button";
/** Subagent list row (suffix: subagent name) */
export const TID_SUBAGENT_ROW = "subagent-row";
/** Built-in subagent model picker (suffix: subagent name) */
export const TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER = "subagent-built-in-model-trigger";
/** Settings usage top tab (suffix: usage tab id) */
export const TID_SETTINGS_USAGE_TAB = "settings-usage-tab";
/** Sidebar avatar-menu remaining-quota submenu entry */
export const TID_SIDEBAR_USAGE_REMAINING_TRIGGER = "sidebar-usage-remaining-trigger";
/** Sidebar avatar-menu usage entry */
export const TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON = "sidebar-coding-plan-usage-button";

// Model Provider Settings
/** Model provider top add button */
export const TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON = "model-provider-add-provider-button";
/** Model provider template chooser page */
export const TID_MODEL_PROVIDER_TEMPLATE_PICKER = "model-provider-template-picker";
/** Model provider template option (suffix: templateId; custom = fully custom) */
export const TID_MODEL_PROVIDER_TEMPLATE_ITEM = "model-provider-template-item";
/** Template page back-to-provider-detail button */
export const TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON = "model-provider-template-back-button";
/** Model provider nav entry (suffix: provider node key) */
export const TID_MODEL_PROVIDER_NAV_ITEM = "model-provider-nav-item";
/** Model provider connection-mode dropdown trigger */
export const TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER = "model-provider-connection-mode-trigger";
/** Quick entry counting existing Start Plan subscriptions. */
export const TID_MODEL_PROVIDER_START_PLAN_COUNT_SHORTCUT =
  "model-provider-start-plan-count-shortcut";
export const TID_MODEL_PROVIDER_START_PLAN_SWITCH_PREFIX =
  "model-provider-start-plan-switch-prefix";
/** Connection-mode dropdown option (suffix: mode key) */
export const TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM = "model-provider-connection-mode-item";
/** Provider detail API key input */
export const TID_MODEL_PROVIDER_API_KEY_INPUT = "model-provider-api-key-input";
/** Provider name edit button */
export const TID_MODEL_PROVIDER_NAME_EDIT_BUTTON = "model-provider-name-edit-button";
/** Provider name edit input */
export const TID_MODEL_PROVIDER_NAME_INPUT = "model-provider-name-input";
/** Provider base URL input */
export const TID_MODEL_PROVIDER_BASE_URL_INPUT = "model-provider-base-url-input";
/** Provider API-format dropdown trigger */
export const TID_MODEL_PROVIDER_API_FORMAT_TRIGGER = "model-provider-api-format-trigger";
/** Provider API-format option (suffix: API format) */
export const TID_MODEL_PROVIDER_API_FORMAT_ITEM = "model-provider-api-format-item";
/** Provider model input (suffix: model row index) */
export const TID_MODEL_PROVIDER_MODEL_INPUT = "model-provider-model-input";
/** Provider model remove button (suffix: model row index) */
export const TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON = "model-provider-model-delete-button";
/** Provider add-model button */
export const TID_MODEL_PROVIDER_ADD_MODEL_BUTTON = "model-provider-add-model-button";

// Chat Toolbar
/** Chat toolbar model selector button */
export const TID_CHAT_MODEL_SELECT_TRIGGER = "chat-model-select-trigger";
/** Model group in the chat toolbar (suffix: provider group key) */
export const TID_CHAT_MODEL_SELECT_GROUP = "chat-model-select-group";
/** Chat toolbar model option (suffix: model value) */
export const TID_CHAT_MODEL_SELECT_ITEM = "chat-model-select-item";
/** Chat thinking-level selector button */
export const TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER = "chat-thought-level-select-trigger";
/** Thinking-level option (suffix: level value) */
export const TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM = "chat-thought-level-select-item";
/** Chat mode selector button (v4 switchCollaborationMode e2e anchor) */
export const TID_CHAT_MODE_SELECT_TRIGGER = "chat-mode-select-trigger";
/** Chat mode option (suffix: mode value) */
export const TID_CHAT_MODE_SELECT_ITEM = "chat-mode-select-item";
/** Chat context-usage button */
export const TID_CHAT_CONTEXT_USAGE_TRIGGER = "chat-context-usage-trigger";
/** Thinking-block collapse toggle */
export const TID_CHAT_REASONING_TRIGGER = "chat-reasoning-trigger";
/** Thinking-block collapsed content container */
export const TID_CHAT_REASONING_CONTENT = "chat-reasoning-content";

// Workspace
/** Main content header */
export const TID_WORKSPACE_HEADER = "workspace-header";
/** Workspace title */
export const TID_WORKSPACE_TITLE = "workspace-title";
/** Workspace path */
export const TID_WORKSPACE_PATH = "workspace-path";
/** Workspace header overflow-menu button */
export const TID_WORKSPACE_MORE_BUTTON = "workspace-more-button";
/** Top-right help menu trigger */
export const TID_WORKSPACE_HELP_MENU_TRIGGER = "workspace-help-menu-trigger";
/** Resource-monitor item in the help menu (desktop only) */
export const TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER = "workspace-help-menu-resource-manager";
/** Sidebar workspace file-tree toggle (suffix: workspacePath) */
export const TID_WORKSPACE_FILE_TREE_BUTTON = "workspace-file-tree-button";
/** Workspace file-tree panel */
export const TID_WORKSPACE_FILE_TREE_PANEL = "workspace-file-tree-panel";
/** File-tree refresh button */
export const TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON = "workspace-file-tree-refresh-button";
/** File-tree entry (suffix: absolute path) */
export const TID_WORKSPACE_FILE_TREE_ROW = "workspace-file-tree-row";
// SSH error surface
/** SSH connection error message */
export const TID_SSH_ERROR = "ssh-error";
/** SSH connection success note */
export const TID_SSH_SUCCESS = "ssh-success";

// v4 session panes (protocol-v4 vertical slice; the locator protocol carries a paneId dimension: dual panes per session are told apart by the paneId suffix)
/** v4 session pane container (suffix: paneId) */
export const TID_V4_SESSION_PANE = "v4-session-pane";
/** v4 message timeline container */
export const TID_V4_TIMELINE = "v4-timeline";
/** v4 timeline empty-state placeholder */
export const TID_V4_TIMELINE_EMPTY = "v4-timeline-empty";
/** v4 projection row (suffix: rowId) */
export const TID_V4_ROW = "v4-row";
/** v4 workspace hook pending-review banner container */
export const TID_V4_WORKSPACE_HOOK_PENDING_BANNER = "v4-workspace-hook-pending-banner";
/** v4 hook banner review-now button */
export const TID_V4_WORKSPACE_HOOK_PENDING_REVIEW = "v4-workspace-hook-pending-review";
/** v4 hook banner dismiss button */
export const TID_V4_WORKSPACE_HOOK_PENDING_DISMISS = "v4-workspace-hook-pending-dismiss";
/** v4 composer container */
export const TID_V4_COMPOSER = "v4-composer";
/** v4 composer text input */
export const TID_V4_COMPOSER_INPUT = "v4-composer-input";
/** v4 composer background-tasks entry for the current session */
export const TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER = "v4-composer-background-work-trigger";
/** v4 persistent computer-use (CUA) entry button */
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
/** v4 attachment upload progress (suffix: attachment id) */
export const TID_V4_ATTACHMENT_UPLOAD_PROGRESS = "v4-attachment-upload-progress";
/** v4 attachment upload retry (suffix: attachment id) */
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
/** v4 query edit attachment remove button (suffix: rowId-index) */
export const TID_V4_EDIT_ATTACHMENT_REMOVE = "v4-edit-attachment-remove";
export const TID_V4_EDIT_REWIND_WORKSPACE = "v4-edit-rewind-workspace";
/** v4 edit file-conflict dialog */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG = "v4-edit-workspace-conflict-dialog";
/** v4 fallback to conversation-trim-only after a file conflict */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY =
  "v4-edit-workspace-conflict-conversation-only";
/** v4 queue panel container */
export const TID_V4_QUEUE = "v4-queue";
/** v4 paused-queue reason/resume banner */
export const TID_V4_QUEUE_PAUSED_BANNER = "v4-queue-paused-banner";
/** v4 resume-auto-consume button */
export const TID_V4_QUEUE_RESUME = "v4-queue-resume";
/** v4 queue item inline edit input (suffix: queueItemId) */
/** v4 queue item (suffix: queueItemId) */
export const TID_V4_QUEUE_ITEM = "v4-queue-item";
/** v4 queue item delete button (suffix: queueItemId) */
export const TID_V4_QUEUE_ITEM_DELETE = "v4-queue-item-delete";
/** v4 queue item edit button (suffix: queueItemId) */
export const TID_V4_QUEUE_ITEM_EDIT = "v4-queue-item-edit";
/** v4 queue send-now button (suffix: queueItemId) */
export const TID_V4_QUEUE_ITEM_SEND_NOW = "v4-queue-item-send-now";
/** v4 queue move-up button (suffix: queueItemId) */
export const TID_V4_QUEUE_ITEM_UP = "v4-queue-item-up";
/** v4 input control: queue autoDrain toggle (setAutoDrain command) */
export const TID_V4_AUTODRAIN_TOGGLE = "v4-autodrain-toggle";
/** v4 input control: followup routing-mode toggle (setFollowupMode command) */
export const TID_V4_FOLLOWUP_TOGGLE = "v4-followup-toggle";
/** v4 session title display (meta.title; placeholder when empty) */
export const TID_V4_SESSION_TITLE = "v4-session-title";
/** v4 session rename input (renameSession command) */
export const TID_V4_RENAME_INPUT = "v4-rename-input";
/** v4 session rename submit button (renameSession command) */
export const TID_V4_RENAME_SUBMIT = "v4-rename-submit";
/** v4 goal status banner (objective + status; sendGoalCommand/resumeGoal projection) */
export const TID_V4_GOAL_BANNER = "v4-goal-banner";
/** v4 session delete button (deleteSession; returns to draft) */
export const TID_V4_DELETE_SESSION = "v4-delete-session";
/** v4 background-work panel (backgroundWorks projection) */
export const TID_V4_BACKGROUND_WORKS = "v4-background-works";
/** v4 background-work item (suffix: workId) */
export const TID_V4_BACKGROUND_WORK_ITEM = "v4-background-work-item";
/** v4 background-work cancel (cancelBackgroundWork; suffix: workId) */
export const TID_V4_BACKGROUND_WORK_CANCEL = "v4-background-work-cancel";
/** v4 model config display (data-provider/data-model/data-thought; switchModelConfig projection) */
export const TID_V4_MODEL_CONFIG = "v4-model-config";
// v4-model-provider-input / v4-model-model-input / v4-model-thought-input /
// v4-model-apply (debug form) is retired - model switching lives in the composer toolbar via
// TID_CHAT_MODEL_SELECT_* / TID_CHAT_THOUGHT_LEVEL_SELECT_*.
/** v4 subscription-failure reconnect button */
export const TID_V4_RETRY_SUBSCRIBE = "v4-retry-subscribe";
/** v4 userInput interaction dialog container */
export const TID_V4_USER_INPUT_DIALOG = "v4-user-input-dialog";
/** v4 userInput option button (suffix: optionId) */
export const TID_V4_USER_INPUT_OPTION = "v4-user-input-option";
/** v4 userInput free-text input */
export const TID_V4_USER_INPUT_TEXT = "v4-user-input-text";
/** v4 jump-to-bottom button (appears when bottom-follow disengages; virtual-scroll anchor) */
export const TID_V4_TIMELINE_BOTTOM = "v4-timeline-bottom";
/** v4 pane shell (Layout/Focus wrapper; suffix: paneId; data-focused marks the focused pane in split view) */
export const TID_V4_PANE_SHELL = "v4-pane-shell";
/** v4 split-right pane button (pane header; phase 1 opens a split, phase 2 generalizes to split) */
export const TID_V4_SPLIT_OPEN = "v4-split-open";
/** v4 split-down pane button (pane header, grid layout) */
export const TID_V4_SPLIT_DOWN = "v4-split-down";
/** v4 close-pane button (non-primary pane header; phase 1 closes the split) */
export const TID_V4_SPLIT_CLOSE = "v4-split-close";
/** v4 split drag divider (pointer drag resizes; data-split-id marks the split node) */
export const TID_V4_SPLIT_DIVIDER = "v4-split-divider";
/** v4 pane-header workspace badge (ownership on cross-workspace panes) */
export const TID_V4_PANE_WORKSPACE_BADGE = "v4-pane-workspace-badge";
/** Session context-menu open-in-split entry (desktop shell only; final) */
export const TID_V4_TASK_OPEN_IN_SPLIT = "v4-task-open-in-split";
/** v4 load-earlier button (cursor pagination; shown until the window's first row is the global first) */
export const TID_V4_TIMELINE_LOAD_OLDER = "v4-timeline-load-older";
/** v4 turn navigation rail (widescreen, 2+ navigable turns) */
export const TID_V4_TURN_NAVIGATOR = "v4-turn-navigator";
/** v4 turn nav item (suffix: render unit key) */
export const TID_V4_TURN_NAVIGATOR_ITEM = "v4-turn-navigator-item";
/** v4 turn nav hover-card preview (suffix: render unit key) */
export const TID_V4_TURN_NAVIGATOR_TOOLTIP = "v4-turn-navigator-tooltip";
/** v4 subagent row drill-down toggle (suffix: rowId; clickable only with childSessionId) */
export const TID_V4_SUBAGENT_TOGGLE = "v4-subagent-toggle";
/** v4 subagent drill-down mini timeline (suffix: childSessionId) */
export const TID_V4_SUBAGENT_DRILLDOWN = "v4-subagent-drilldown";
/** v4 subagent drill-down open-in-split entry (suffix: childSessionId) */
/** @deprecated subagent details moved to the right-side tabs; constant kept so legacy external tests still compile. */
export const TID_V4_SUBAGENT_OPEN_SPLIT = "v4-subagent-open-split";
export const TID_V4_SUBAGENT_OPEN_SIDE_PANE = "v4-subagent-open-side-pane";
/** v4 userInput row attachment list (suffix: rowId) */
export const TID_V4_ROW_ATTACHMENTS = "v4-row-attachments";

// Plugin store
/** Settings entry into the plugin store (the store is a WorkspaceShell main view, not a settings section) */
export const TID_PLUGIN_STORE_BROWSE = "plugin-store-browse";

// Automations / scheduled tasks
export const TID_AUTOMATIONS_OPEN = "automations-open";
export const TID_AUTOMATIONS_LIST = "automations-list";
/** Status-filter pill row shared by scheduled/idle lists (all/running/completed/failed) */
export const TID_AUTOMATIONS_STATUS_FILTER = "automations-status-filter";
export const TID_AUTOMATION_CREATE_MENU = "automation-create-menu";
export const TID_AUTOMATION_CREATE_MANUALLY = "automation-create-manually";
export const TID_AUTOMATION_CARD = "automation-card";
// Idle-time tasks (off-peak, separate surface)
export const TID_OFFPEAK_CREATE_BUTTON = "offpeak-create-button";
export const TID_OFFPEAK_CARD = "offpeak-card";
/** Idle card footnote: bound session title (created in-session). */
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
// Scheduler builder / custom recurrence / annual month-day picker (e2e stability anchors)
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

/** Build a suffixed testid for dynamic elements, e.g. file-tree-item-/home/user */
export function testId(base: string, suffix: string): string {
  return `${base}-${suffix}`;
}

export const TID_START_PLAN_RECOMMENDATION_DIALOG = "start-plan-recommendation-dialog";

/** Diagnostic-log consent toggle for user feedback */
export const TID_FEEDBACK_LOGS_OPT_IN = "feedback-logs-opt-in";
