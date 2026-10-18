import { ChevronRightIcon, PlugIcon } from "lucide-react";
import { useCallback } from "react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockWrapButton,
} from "@/components/ai-elements/code-block.js";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  ToolCallProgressIndicator,
  readToolCallProgress,
} from "@/ToolCallBlocks/ToolCallProgressIndicator.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

interface McpToolPresentation {
  kind: "mcp_tool";
  serverName?: string;
  toolName: string;
  description?: string;
}

const MCP_TOOL_ICON = <PlugIcon className="size-4 shrink-0 text-foreground-subtle" />;
const COMPACT_RESULT_MAX_LENGTH = 160;
const COLLAPSIBLE_CODE_LAYOUT_STYLE = {
  containIntrinsicSize: "none",
  contentVisibility: "visible",
} as const;

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isCompactResult(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= COMPACT_RESULT_MAX_LENGTH &&
    !trimmed.includes("\n") &&
    !looksLikeJson(trimmed)
  );
}

function stringifyMcpResult(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isMcpToolPresentation(value: unknown): value is McpToolPresentation {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "mcp_tool" &&
    typeof record.serverName === "string" &&
    record.serverName.trim().length > 0 &&
    typeof record.toolName === "string" &&
    record.toolName.trim().length > 0
  );
}

function readLegacyMcpToolPresentation(toolName: string | undefined): McpToolPresentation | null {
  if (!toolName) return null;
  const segments = toolName.split("__");
  if (segments.length !== 3 || segments[0] !== "mcp" || !segments[1] || !segments[2]) return null;

  const encodedServerName = segments[1];
  const encodedToolName = segments[2];
  const serverTokens = encodedServerName.split("_").filter(Boolean);
  const toolTokens = encodedToolName.split("_").filter(Boolean);
  let sharedTokenCount = 0;
  const maximumSharedTokens = Math.min(serverTokens.length, toolTokens.length);
  for (let tokenCount = maximumSharedTokens; tokenCount > 0; tokenCount -= 1) {
    if (
      serverTokens.slice(-tokenCount).join("_").toLocaleLowerCase() ===
      toolTokens.slice(0, tokenCount).join("_").toLocaleLowerCase()
    ) {
      sharedTokenCount = tokenCount;
      break;
    }
  }
  const pluginScoped = serverTokens[0]?.toLocaleLowerCase() === "plugin";
  const serverName =
    sharedTokenCount > 0
      ? serverTokens.slice(-sharedTokenCount).join("_")
      : pluginScoped
        ? serverTokens.at(-1)!
        : encodedServerName;
  const actionName =
    sharedTokenCount > 0 && sharedTokenCount < toolTokens.length
      ? toolTokens.slice(sharedTokenCount).join("_")
      : encodedToolName;

  // MCP history from before display persistence has only the protocol execution name, which
  // the generic renderer would dump as raw JSON. Split mechanically by protocol envelope and
  // encoded tokens; new records keep the tools/list discovery display authoritative — the
  // legacy rule never overrides it.
  return { kind: "mcp_tool", serverName, toolName: actionName };
}

export function readMcpToolPresentation(
  context: Pick<ToolCallBlockRenderContext, "toolCallNode">,
): McpToolPresentation | null {
  const raw = context.toolCallNode.toolCall.raw;
  if (typeof raw === "object" && raw !== null) {
    const display = (raw as Record<string, unknown>).display;
    if (isMcpToolPresentation(display)) return display;
  }
  return readLegacyMcpToolPresentation(context.toolCallNode.toolCall.toolName);
}

export function formatMcpIdentifier(value: string): string {
  const words = value.trim().replace(/[-_]+/gu, " ").replace(/\s+/gu, " ");
  if (!words) return value;
  return words[0]!.toLocaleUpperCase() + words.slice(1);
}

export function formatMcpServerLabel(value: string): string {
  const namespaceSegments = value
    .split(":")
    .map((segment) => segment.trim())
    .filter(Boolean);
  // Plugin MCP configured server keys carry a plugin:<plugin>:<server> namespace; showing it
  // verbatim leaks internal routing identifiers. The last segment is the user-configured
  // server name.
  const displayIdentifier =
    namespaceSegments[0]?.toLocaleLowerCase() === "plugin" && namespaceSegments.length > 1
      ? namespaceSegments.at(-1)!
      : value;
  return formatMcpIdentifier(displayIdentifier);
}

export function formatMcpToolLabel(toolName: string, serverLabel: string): string {
  const formattedToolName = formatMcpIdentifier(toolName);
  const repeatedPrefix = `${serverLabel} `;
  // Many MCP tools prefix the tool with the server name again; with the server source shown
  // in the summary you would get "Firebase / Firebase get environment". Case-insensitive
  // mechanical dedupe only.
  return formattedToolName.toLocaleLowerCase().startsWith(repeatedPrefix.toLocaleLowerCase())
    ? formatMcpIdentifier(formattedToolName.slice(repeatedPrefix.length))
    : formattedToolName;
}

export function McpToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const presentation = readMcpToolPresentation(context);
  const { toolCall } = context.toolCallNode;
  const serverLabel = presentation?.serverName
    ? formatMcpServerLabel(presentation.serverName)
    : undefined;
  const toolLabel = presentation
    ? formatMcpToolLabel(presentation.toolName, serverLabel ?? "")
    : toolCall.title;
  const callDetailsLabel = intl.formatMessage({ id: "chat.toolCall.mcp.callDetails" });
  const resultLabel = intl.formatMessage({ id: "chat.toolCall.mcp.result" });
  const copyResultLabel = intl.formatMessage({ id: "chat.toolCall.mcp.copyResult" });
  const wrapLinesLabel = intl.formatMessage({ id: "chat.toolCall.mcp.wrapLines" });
  const descriptionLabel = intl.formatMessage({ id: "chat.toolCall.mcp.description" });
  const parametersLabel = intl.formatMessage({ id: "chat.toolCall.mcp.parameters" });
  const hasCallDetails = Boolean(presentation?.description || toolCall.input !== undefined);
  const resultText = stringifyMcpResult(toolCall.output);
  const visibleError = toolCall.status === "failed" ? (toolCall.error ?? context.errorText) : undefined;
  const hasPrimaryResult = Boolean(resultText || visibleError);
  const isSummaryOnlyLifecycle = toolCall.status === "pending" || toolCall.status === "stopped";
  // R7：运行中且 agent 投影了 MCP 进度时，摘要行显示细进度条 + message；终态由投影清除。
  const progress = toolCall.status === "in_progress" ? readToolCallProgress(toolCall.raw) : null;
  const stoppedSummaryStatus =
    toolCall.status === "stopped" ? (
      <span className="inline-flex items-center gap-2">
        <span className="text-foreground-subtlest">·</span>
        <span>{context.statusLabel}</span>
      </span>
    ) : progress ? (
      <ToolCallProgressIndicator progress={progress} />
    ) : undefined;
  const failedSummaryStatus =
    toolCall.status === "failed" ? (
      <span className="inline-flex items-center gap-2">
        <span className="text-foreground-subtlest">·</span>
        <span>{context.statusLabel}</span>
      </span>
    ) : undefined;
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const renderContent = useCallback(
    () => (
      // MCP details used to lead with description and params, reading like an API debugger
      // even expanded. Following BUA, the result is the primary content; call metadata lives
      // in a muted secondary collapsible.
      <div className="mb-2 space-y-3 py-1" data-testid="mcp-expanded-content">
        {visibleError ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-base font-medium text-destructive">{resultLabel}</h4>
            <p
              className="whitespace-pre-wrap break-words rounded-lg bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
              data-testid="mcp-error-surface"
            >
              {visibleError}
            </p>
          </section>
        ) : resultText && isCompactResult(resultText) ? (
          <p
            className="break-words rounded-xl border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
            data-testid="mcp-result-surface"
          >
            {resultText.trim()}
          </p>
        ) : resultText ? (
          <div
            className="max-h-72 overflow-auto rounded-xl border border-border bg-card"
            data-testid="mcp-result-surface"
          >
            <CodeBlock
              appTheme={context.theme}
              className="bg-card"
              code={resultText}
              enableSyntaxHighlighting={looksLikeJson(resultText)}
              language={looksLikeJson(resultText) ? "json" : "log"}
              renderMermaid={false}
              style={COLLAPSIBLE_CODE_LAYOUT_STYLE}
              wrapLongLines
            >
              <CodeBlockHeader className="pl-3 pr-2 pt-2">
                <CodeBlockTitle>
                  <span className="text-ui-base font-medium text-foreground-subtle">
                    {resultLabel}
                  </span>
                </CodeBlockTitle>
                <CodeBlockActions>
                  <CodeBlockWrapButton aria-label={wrapLinesLabel} title={wrapLinesLabel} />
                  <CodeBlockCopyButton aria-label={copyResultLabel} title={copyResultLabel} />
                </CodeBlockActions>
              </CodeBlockHeader>
            </CodeBlock>
          </div>
        ) : toolCall.status === "pending" ? (
          <p
            className="break-words rounded-xl border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
            data-testid="mcp-pending-surface"
          >
            {context.statusLabel}
          </p>
        ) : (
          // Expanding a pending/running/stopped MCP without a result leaves ToolCallBody
          // empty and the phase unclear; reuse the summary's localized status instead of
          // inventing lifecycle copy.
          <p className="text-ui-base text-foreground-subtle">{context.statusLabel}</p>
        )}
        {hasCallDetails ? (
          <Collapsible className="group/details">
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 text-foreground-subtlest hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground"
              >
                <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/details:rotate-90" />
                {callDetailsLabel}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-3 pt-2">
                {presentation?.description ? (
                  <section className="space-y-1.5">
                    <h4 className="text-ui-sm font-medium text-foreground-subtlest">
                      {descriptionLabel}
                    </h4>
                    <p className="whitespace-pre-wrap break-words text-ui-base text-foreground-subtle">
                      {presentation.description}
                    </p>
                  </section>
                ) : null}
                {toolCall.input !== undefined ? (
                  <section className="space-y-1.5">
                    <h4 className="text-ui-sm font-medium text-foreground-subtlest">
                      {parametersLabel}
                    </h4>
                    <div className="max-h-72 overflow-auto rounded-xl border border-border bg-card">
                      <CodeBlock
                        appTheme={context.theme}
                        code={JSON.stringify(toolCall.input, null, 2)}
                        language="json"
                      />
                    </div>
                  </section>
                ) : null}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
      </div>
    ),
    [
      callDetailsLabel,
      copyResultLabel,
      context,
      descriptionLabel,
      handleLoadFullToolCallFields,
      hasCallDetails,
      hasPrimaryResult,
      parametersLabel,
      presentation?.description,
      resultLabel,
      resultText,
      toolCall,
      visibleError,
      wrapLinesLabel,
    ],
  );

  if (!presentation) return null;

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={MCP_TOOL_ICON}
      showIcon={context.showIcon !== false}
      // Pending/stopped have no consumable result; expanding would only repeat status or
      // expose diagnostic params. Even an explicit parent forceOpen must respect these two
      // lifecycles' summary-only semantics.
      canToggle={!isSummaryOnlyLifecycle && (context.canToggle ?? true)}
      forceOpen={!isSummaryOnlyLifecycle && (context.forceOpen ?? false)}
      kindLabel="MCP"
      kindDetail={
        serverLabel ? (
          <span className="text-foreground-subtle">{serverLabel}</span>
        ) : undefined
      }
      primaryText={toolLabel}
      summaryContentSeparator="·"
      // Pending/Running/Completed are normal lifecycles and never repeat in the summary;
      // Stopped is an abnormal terminal state, so an explicit separator node keeps the two
      // text nodes of the non-animated summary from sticking together. Failed uses the
      // dedicated status slot.
      secondaryText={stoppedSummaryStatus}
      statusLabel={failedSummaryStatus}
      statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={context.isRunning}
      title={presentation.description ?? presentation.toolName}
      renderContent={renderContent}
    />
  );
}
