import type { FormEvent, ReactNode } from "react";
import {
  Bug,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  ExternalLink,
  Globe,
  LoaderIcon,
  MonitorSmartphone,
  MousePointerClick,
  RefreshCw,
  TriangleAlertIcon,
} from "lucide-react";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_BACK_BUTTON,
  TID_BROWSER_DEVTOOLS_BUTTON,
  TID_BROWSER_ELEMENT_PICKER_BUTTON,
  TID_BROWSER_FORWARD_BUTTON,
  TID_BROWSER_LOAD_ERROR,
  TID_BROWSER_LOAD_ERROR_CERT_HINT,
  TID_BROWSER_MORE_BUTTON,
  TID_BROWSER_OPEN_EXTERNAL_ITEM,
  TID_BROWSER_REFRESH_BUTTON,
  TID_BROWSER_RESPONSIVE_BUTTON,
} from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Input } from "@/components/ui/input.js";
import {
  isDefaultBrowserOpenableUrl,
  type BrowserGuestFailure,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

export function BrowserToolbar({
  addressValue,
  browserState,
  permissionControl,
  formatMessage,
  onAddressChange,
  onGoBack,
  onGoForward,
  onOpenExternal,
  onOpenDevTools,
  onPickElement,
  onReload,
  onToggleResponsiveMode,
  onSubmit,
  isElementPickerActive,
  isResponsiveMode,
}: {
  addressValue: string;
  browserState: BrowserState;
  /** 地址栏左侧的站点设置入口；聚焦编辑 URL 时隐藏但不卸载。 */
  permissionControl?: ReactNode;
  formatMessage: (descriptor: { id: string }) => string;
  onAddressChange: (value: string) => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onOpenExternal: () => void;
  onOpenDevTools: () => void;
  onPickElement: () => void;
  onReload: () => void;
  onToggleResponsiveMode: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isElementPickerActive: boolean;
  isResponsiveMode: boolean;
}) {
  return (
    <form
      onSubmit={(event) =>
        runUserAction({
          input: { featureId: "workbench.browser", action: "navigate", trigger: "keyboard" },
          operation: () => onSubmit(event),
          completed: { resultSource: "optimistic_projection" },
          failureStage: "browser_navigate",
        })
      }
      className="flex items-center h-12 px-3 gap-2"
    >
      <BrowserIconButton
        icon={<ChevronLeft className="h-4 w-4" />}
        title={formatMessage({ id: "browser.back" })}
        disabled={!browserState.canGoBack}
        dataTestId={TID_BROWSER_BACK_BUTTON}
        onClick={onGoBack}
      />
      <BrowserIconButton
        icon={<ChevronRight className="h-4 w-4" />}
        title={formatMessage({ id: "browser.forward" })}
        disabled={!browserState.canGoForward}
        dataTestId={TID_BROWSER_FORWARD_BUTTON}
        onClick={onGoForward}
      />
      <BrowserIconButton
        icon={<RefreshCw className={`h-4 w-4 ${browserState.isLoading ? "animate-spin" : ""}`} />}
        title={formatMessage({ id: "browser.reload" })}
        disabled={!browserState.isReady}
        dataTestId={TID_BROWSER_REFRESH_BUTTON}
        onClick={onReload}
      />
      <div
        className="group/browser-address relative min-w-0 flex-1"
        data-testid="browser-address-bar"
      >
        <Input
          type="text"
          value={addressValue}
          data-testid={TID_BROWSER_ADDRESS_INPUT}
          size="sm"
          className="h-8 rounded-full px-14 text-center focus:px-3 focus:text-left"
          onChange={(event) => onAddressChange(event.target.value)}
          placeholder={formatMessage({ id: "browser.addressPlaceholder" })}
          spellCheck={false}
        />
        {/* 编辑 URL 时隐藏入口但不卸载，避免将隐藏图标误当成关闭权限申请。 */}
        <div className="absolute top-1/2 left-0.5 -translate-y-1/2 group-has-[input:focus]/browser-address:hidden">
          {permissionControl}
        </div>
      </div>
      <BrowserIconButton
        icon={<MonitorSmartphone className="h-4 w-4" />}
        title={formatMessage({
          id: isResponsiveMode ? "browser.responsive.exit" : "browser.responsive.enter",
        })}
        disabled={false}
        dataTestId={TID_BROWSER_RESPONSIVE_BUTTON}
        onClick={onToggleResponsiveMode}
        active={isResponsiveMode}
        pressed={isResponsiveMode}
      />
      <BrowserIconButton
        icon={<MousePointerClick className="h-4 w-4" />}
        title={formatMessage({
          id: isElementPickerActive
            ? "browser.elementPicker.cancel"
            : "browser.elementPicker.start",
        })}
        disabled={!browserState.isReady}
        dataTestId={TID_BROWSER_ELEMENT_PICKER_BUTTON}
        onClick={onPickElement}
        active={isElementPickerActive}
      />
      <BrowserToolbarMoreMenu
        canOpenExternal={
          browserState.isReady && isDefaultBrowserOpenableUrl(browserState.currentUrl)
        }
        canOpenDevTools={browserState.isReady}
        formatMessage={formatMessage}
        onOpenExternal={onOpenExternal}
        onOpenDevTools={onOpenDevTools}
      />
    </form>
  );
}

function BrowserToolbarMoreMenu({
  canOpenDevTools,
  canOpenExternal,
  formatMessage,
  onOpenDevTools,
  onOpenExternal,
}: {
  canOpenDevTools: boolean;
  canOpenExternal: boolean;
  formatMessage: (descriptor: { id: string }) => string;
  onOpenDevTools: () => void;
  onOpenExternal: () => void;
}) {
  const moreLabel = formatMessage({ id: "browser.more" });
  return (
    <DropdownMenu>
      <ControlHintTooltip title={moreLabel}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={moreLabel}
            data-testid={TID_BROWSER_MORE_BUTTON}
          >
            <Ellipsis className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          data-testid={TID_BROWSER_OPEN_EXTERNAL_ITEM}
          disabled={!canOpenExternal}
          onSelect={onOpenExternal}
        >
          <ExternalLink className="size-4" />
          <span>{formatMessage({ id: "browser.openExternal" })}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid={TID_BROWSER_DEVTOOLS_BUTTON}
          disabled={!canOpenDevTools}
          onSelect={onOpenDevTools}
        >
          <Bug className="size-4" />
          <span>{formatMessage({ id: "browser.devtools" })}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BrowserEmptyState({
  browserState,
  formatMessage,
  isGuestStarting = !browserState.isReady,
}: {
  browserState: BrowserState;
  formatMessage: (descriptor: { id: string }) => string;
  isGuestStarting?: boolean;
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col pb-10 items-center text-center">
        {isGuestStarting ? (
          <LoaderIcon className="mb-6 size-16 animate-spin text-foreground opacity-30" />
        ) : (
          <Globe className="mb-6 size-16 text-foreground opacity-30" />
        )}
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({ id: "browser.title" })}
        </h3>
        <p className="mt-2 text-ui-base text-foreground-subtle">
          {formatMessage({ id: "browser.empty" })}
        </p>
      </div>
    </div>
  );
}

/**
 * Readable error state for failed page loads.
 *
 * Electron's `<webview>` has no Chrome interstitial: blocked navigation lands on an empty
 * chrome-error page. errorMessage used to be state with no renderer while the empty state was
 * suppressed, leaving plain black. Certificate failures add the bypass hint so users have a next step.
 */
export function BrowserLoadErrorState({
  errorMessage,
  formatMessage,
  isCertificateError,
  onRetry,
}: {
  errorMessage: string;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  isCertificateError: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      data-testid={TID_BROWSER_LOAD_ERROR}
      className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6"
    >
      <div className="flex max-w-sm flex-col items-center pb-10 text-center">
        <TriangleAlertIcon className="mb-6 size-16 text-warning opacity-60" />
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({
            id: isCertificateError ? "browser.loadError.certTitle" : "browser.loadError.title",
          })}
        </h3>
        <p className="mt-2 font-mono text-ui-sm break-all text-foreground-subtlest">
          {errorMessage}
        </p>
        {isCertificateError ? (
          <p
            data-testid={TID_BROWSER_LOAD_ERROR_CERT_HINT}
            className="mt-3 text-ui-base text-foreground-subtle"
          >
            {formatMessage({ id: "browser.loadError.certHint" })}
          </p>
        ) : null}
        <Button type="button" variant="outline" className="mt-6" onClick={onRetry}>
          <RefreshCw className="size-4" />
          {formatMessage({ id: "browser.loadError.retry" })}
        </Button>
      </div>
    </div>
  );
}

/** Host takes over the screen when guest start fails; auto-rebuild would loop, so retry is explicit only. */
export function BrowserGuestFailureState({
  formatMessage,
  guestFailure,
  onRetry,
}: {
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  guestFailure: BrowserGuestFailure;
  onRetry: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center pb-10 text-center">
        <TriangleAlertIcon className="mb-6 size-16 text-warning opacity-60" />
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({ id: "browser.guestFailed.title" })}
        </h3>
        <p className="mt-2 text-ui-base text-foreground-subtle">
          {formatMessage({ id: "browser.guestFailed.description" })}
        </p>
        <p className="mt-2 font-mono text-ui-sm text-foreground-subtlest">
          {formatMessage(
            { id: "browser.guestFailed.detail" },
            { exitCode: guestFailure.exitCode, reason: guestFailure.reason },
          )}
        </p>
        <Button type="button" variant="outline" className="mt-6" onClick={onRetry}>
          <RefreshCw className="size-4" />
          {formatMessage({ id: "browser.guestFailed.retry" })}
        </Button>
      </div>
    </div>
  );
}

function BrowserIconButton({
  dataTestId,
  disabled,
  icon,
  onClick,
  title,
  active = false,
  pressed,
}: {
  dataTestId: string;
  disabled: boolean;
  icon: ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  pressed?: boolean;
}) {
  return (
    <ControlHintTooltip title={title}>
      <Button
        type="button"
        size="icon-md"
        variant={active ? "secondary" : "ghost"}
        aria-label={title}
        aria-pressed={pressed}
        data-testid={dataTestId}
        disabled={disabled}
        onClick={onClick}
      >
        {icon}
      </Button>
    </ControlHintTooltip>
  );
}
