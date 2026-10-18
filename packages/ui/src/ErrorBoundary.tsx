import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { Locale } from "@zcode/shared";
import { DEFAULT_LOCALE } from "@zcode/shared";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";
import { logger } from "@/logger.js";
import { reportReactErrorToArms } from "@/lib/reactErrorArmsTelemetry.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { AlertTriangleIcon, RefreshCw } from "lucide-react";

interface AppErrorBoundaryProps {
  children: ReactNode;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  /**
   * Exceptions caught by the React error boundary never bubble to window.onerror, so monitoring
   * SDKs miss them by default. Hosts such as desktop can pass this callback to forward them.
   */
  onCaughtReactError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface AppErrorBoundaryState {
  error: Error | null;
  componentStack: string;
}

export type ScopedErrorBoundaryVariant = "panel" | "inline" | "compact" | "silent";

interface ScopedErrorBoundaryProps {
  children: ReactNode;
  scope: string;
  resetKeys?: readonly unknown[];
  variant?: ScopedErrorBoundaryVariant;
  className?: string;
  onReset?: () => void;
  onCaughtReactError?: (error: Error, errorInfo: ErrorInfo, scope: string) => void;
}

const LOCALE_PREFERENCE_KEY = "zcode-locale-preference";

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown error");
}

function serializeErrorForLog(error: Error): {
  name: string;
  message: string;
  stack?: string;
} {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}

function resolveBoundaryLocale(): Locale {
  if (typeof localStorage !== "undefined" && typeof localStorage.getItem === "function") {
    try {
      const storedPreference = localStorage.getItem(LOCALE_PREFERENCE_KEY);
      if (storedPreference === "zh-CN" || storedPreference === "en-US") {
        return storedPreference;
      }
    } catch {
      // Node test environments can expose a localStorage object that exists but is incomplete or
      // unreadable (a placeholder stub, or reads that throw). Without this guard the error
      // boundary would crash again while rendering the fallback (white screen). Swallow storage
      // errors and keep falling back to navigator / the default language.
    }
  }

  if (typeof navigator !== "undefined") {
    return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  }

  return DEFAULT_LOCALE;
}

function formatBoundaryMessage(id: string): string {
  const locale = resolveBoundaryLocale();
  const messages = locale === "en-US" ? enUS : zhCN;
  return messages[id] ?? id;
}

function haveResetKeysChanged(
  previousKeys: readonly unknown[] = [],
  nextKeys: readonly unknown[] = [],
): boolean {
  if (previousKeys.length !== nextKeys.length) {
    return true;
  }

  return previousKeys.some((previousKey, index) => !Object.is(previousKey, nextKeys[index]));
}

function ErrorFallback({
  error,
  componentStack,
  onReset,
  onReload,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
}: {
  error: Error;
  componentStack: string;
  onReset: () => void;
  onReload: () => void;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  const errorSummary = error.message.trim() || formatBoundaryMessage("appError.unknown");

  return (
    <DesktopWindowFrame
      title={formatBoundaryMessage("appError.title")}
      isDesktop={isDesktop}
      isMacDesktop={isMacDesktop}
      isWindowsDesktop={isWindowsDesktop}
    >
      <div className="flex h-full min-h-0 justify-center overflow-y-auto p-6">
        <div
          role="alert"
          // Error message and component stack can be very long; a non-scrollable shell used to
          // push content out of the viewport, hiding the stack and the retry/refresh buttons.
          // Pin the fallback card to the top and rely on outer vertical scrolling so every
          // action stays reachable no matter the window size.
          className="w-full max-w-xl self-start rounded-3xl border border-destructive/20 bg-surface-alt p-6 shadow-sm"
        >
          <div className="flex size-10 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <AlertTriangleIcon className="size-5" />
          </div>

          <h1 className="mt-4 text-lg font-semibold text-foreground">
            {formatBoundaryMessage("appError.title")}
          </h1>
          <p className="mt-2 text-ui-base leading-6 text-on-surface-muted">
            {formatBoundaryMessage("appError.description")}
          </p>

          <div className="mt-4 rounded-2xl border border-border bg-background px-3 py-2 font-mono text-ui-base leading-5 text-on-surface-muted">
            {errorSummary}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button type="button" onClick={onReset}>
              {formatBoundaryMessage("appError.retry")}
            </Button>
            <Button type="button" variant="outline" onClick={onReload}>
              <RefreshCw />
              {formatBoundaryMessage("appError.reload")}
            </Button>
          </div>

          <p className="mt-4 text-ui-base leading-5 text-on-surface-muted">
            {formatBoundaryMessage("appError.hint")}
          </p>

          {componentStack ? (
            <details className="mt-4 rounded-2xl border border-border bg-background px-3 py-2">
              <summary className="cursor-pointer text-ui-base font-medium text-on-surface-muted">
                {formatBoundaryMessage("appError.details")}
              </summary>
              <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words text-ui-base leading-5 text-on-surface-muted">
                {/* The expanded component stack grows instantly; cap the pre height with its own
                    scroll so details cannot fill the screen and push the main actions out of view. */}
                {componentStack.trim()}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </DesktopWindowFrame>
  );
}

function ScopedErrorFallback({
  error,
  componentStack,
  onReset,
  onReload,
  variant = "panel",
  className,
}: {
  error: Error;
  componentStack: string;
  onReset: () => void;
  onReload: () => void;
  variant?: ScopedErrorBoundaryVariant;
  className?: string;
}) {
  if (variant === "silent") {
    return null;
  }

  const errorSummary = error.message.trim() || formatBoundaryMessage("appError.unknown");
  const isCompact = variant === "compact";
  const showDetails = variant !== "compact";

  if (isCompact) {
    return (
      <div
        role="alert"
        className={cn(
          "flex min-h-10 items-center gap-2 border-border bg-surface px-3 py-2",
          className,
        )}
      >
        <AlertTriangleIcon className="size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-base font-medium text-foreground">
            {formatBoundaryMessage("appError.sectionTitle")}
          </p>
          <p className="truncate font-mono text-ui-base text-foreground-subtle">{errorSummary}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onReset}>
          {formatBoundaryMessage("appError.sectionRetry")}
        </Button>
      </div>
    );
  }

  const content = (
    <>
      <div className="flex size-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
        <AlertTriangleIcon className="size-4" />
      </div>
      <h2 className="mt-3 text-ui-base font-medium text-foreground">
        {formatBoundaryMessage("appError.sectionTitle")}
      </h2>
      <p className="mt-1 text-ui-base leading-5 text-foreground-subtle">
        {formatBoundaryMessage("appError.sectionDescription")}
      </p>
      <div className="mt-3 rounded-lg border border-border bg-background px-3 py-2 font-mono text-ui-base leading-5 text-foreground-subtle">
        {errorSummary}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={onReset}>
          {formatBoundaryMessage("appError.sectionRetry")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onReload}>
          <RefreshCw />
          {formatBoundaryMessage("appError.reload")}
        </Button>
      </div>
      <p className="mt-3 text-ui-base leading-5 text-foreground-subtle">
        {formatBoundaryMessage("appError.sectionHint")}
      </p>
      {showDetails && componentStack ? (
        <details className="mt-3 rounded-lg border border-border bg-background px-3 py-2">
          <summary className="cursor-pointer text-ui-base font-medium text-foreground-subtle">
            {formatBoundaryMessage("appError.details")}
          </summary>
          <pre className="mt-2 max-h-[32vh] overflow-auto whitespace-pre-wrap break-words text-ui-base leading-5 text-foreground-subtle">
            {componentStack.trim()}
          </pre>
        </details>
      ) : null}
    </>
  );

  if (variant === "inline") {
    return (
      <div
        role="alert"
        className={cn("w-full rounded-xl border border-destructive/20 bg-surface p-4", className)}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        "flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-4",
        className,
      )}
    >
      <div className="w-full max-w-md rounded-xl border border-destructive/20 bg-surface p-4 shadow-sm">
        {content}
      </div>
    </div>
  );
}

/**
 * AppErrorBoundary — React root-level error boundary.
 *
 * Mounting ZCodeIntlProvider / Root directly via createRoot means any Provider or page component
 * throwing during render/lifecycle unmounts the whole tree into a white screen. This shared root
 * boundary converges failures into a recoverable fallback, always keeps a retry/refresh exit, and
 * logs the error to the unified UI logger.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
    componentStack: "",
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      error: normalizeError(error),
      componentStack: "",
    };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const normalizedError = normalizeError(error);
    logger.error(
      "[AppErrorBoundary] React subtree crashed:",
      // Error objects serialize to {} across the preload log bridge, losing key messages such as
      // Maximum update depth. Expand the diagnosable fields explicitly.
      serializeErrorForLog(normalizedError),
      errorInfo.componentStack,
    );
    this.props.onCaughtReactError?.(normalizedError, errorInfo);
    // The React error boundary intercepts the exception and stops it reaching window.onerror, so
    // the RUM browser SDK sees nothing by default. Forward to the ARMS custom-event pipeline
    // (reporter injected early in the renderer entry) to close the root-render-crash blind spot.
    reportReactErrorToArms({
      error: normalizedError,
      componentStack: errorInfo.componentStack ?? "",
    });
    this.setState({ componentStack: errorInfo.componentStack ?? "" });
  }

  private handleReset = () => {
    this.setState({
      error: null,
      componentStack: "",
    });
  };

  private handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  override render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <ErrorFallback
        error={this.state.error}
        componentStack={this.state.componentStack}
        onReset={this.handleReset}
        onReload={this.handleReload}
        isDesktop={this.props.isDesktop}
        isMacDesktop={this.props.isMacDesktop}
        isWindowsDesktop={this.props.isWindowsDesktop}
      />
    );
  }
}

/**
 * ScopedErrorBoundary — isolation boundary for localized UI failures.
 *
 * With a root boundary only, any panel throwing in render bubbles to the root and replaces the
 * whole UI with a full-screen error page. This reusable scoped boundary lets sidebar, chat,
 * terminal, side pane, and friends fail and recover independently so one broken component cannot
 * take down the window.
 */
export class ScopedErrorBoundary extends Component<
  ScopedErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    error: null,
    componentStack: "",
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      error: normalizeError(error),
      componentStack: "",
    };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const normalizedError = normalizeError(error);
    logger.error(
      `[ScopedErrorBoundary:${this.props.scope}] React subtree crashed:`,
      // Error objects serialize to {} across the preload log bridge; the scoped boundary must
      // keep message/stack to locate UI update loops.
      serializeErrorForLog(normalizedError),
      errorInfo.componentStack,
    );
    this.props.onCaughtReactError?.(normalizedError, errorInfo, this.props.scope);
    // Same as the root boundary: render errors caught in scoped areas never reach RUM either.
    // Report by scope so sidebar/chat/terminal/settings crashes stay visible and locatable.
    reportReactErrorToArms({
      error: normalizedError,
      componentStack: errorInfo.componentStack ?? "",
      scope: this.props.scope,
    });
    this.setState({ componentStack: errorInfo.componentStack ?? "" });
  }

  override componentDidUpdate(previousProps: ScopedErrorBoundaryProps) {
    if (this.state.error && haveResetKeysChanged(previousProps.resetKeys, this.props.resetKeys)) {
      // Without auto-clearing the scoped fallback on workspace/task/tab switches, returning to
      // the failed area still shows the stale error. Reset the boundary when resetKeys change so
      // the new isolated context can render again.
      this.setState({
        error: null,
        componentStack: "",
      });
    }
  }

  private handleReset = () => {
    this.setState({
      error: null,
      componentStack: "",
    });
    this.props.onReset?.();
  };

  private handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  override render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <ScopedErrorFallback
        error={this.state.error}
        componentStack={this.state.componentStack}
        onReset={this.handleReset}
        onReload={this.handleReload}
        variant={this.props.variant}
        className={this.props.className}
      />
    );
  }
}
