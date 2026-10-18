/* eslint-disable max-lines -- the public share page keeps status copy, the Row allow-list, and auth state inside one security boundary. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { ArrowUpRightIcon, MoonIcon, SunIcon } from "lucide-react";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import type { ConversationSharePreview } from "@zcode/shared";
import { ConversationShareReadonlyTimeline } from "@zcode/ui/conversation-share-readonly";
import { renderOAuthProviderIcon } from "@zcode/ui/oauth-provider-icon";
import { applyTheme, resolveTheme, type Theme } from "@zcode/ui/useTheme";
import "./conversationShareLandingPage.css";
import type { WebOAuthProviderId } from "../auth/browserOAuthCredentialRepo.js";
import {
  buildShareImportDeepLink,
  type ConversationSharePreviewClientError,
  type ConversationSharePreviewErrorKind,
} from "./conversationSharePreviewClient.js";
import { resolveShareHeaderView, type ShareHeaderView } from "./shareHeaderLayout.js";

/** Sign-in entry order, matching the desktop login card (z.ai first). */
const SHARE_LOGIN_PROVIDERS: readonly WebOAuthProviderId[] = [
  ZAI_PROVIDER_ID,
  BIGMODEL_PROVIDER_ID,
];

type ConversationShareLandingLocale = "zh-CN" | "en-US";
type ConversationShareLandingState =
  | { kind: "loading" }
  | { kind: "login_required" }
  | { kind: "ready"; preview: ConversationSharePreview }
  | { kind: "error"; error: ConversationSharePreviewErrorKind };

function logPreviewLoadFailure(
  stage: "anonymous" | "authenticated",
  error: unknown,
  kind: ConversationSharePreviewErrorKind,
): void {
  const clientError = error as Partial<ConversationSharePreviewClientError> | null;
  console.warn("[conversation-share-web]", "preview_load_failed", {
    stage,
    kind,
    errorName: error instanceof Error ? error.name : typeof error,
    status: typeof clientError?.status === "number" ? clientError.status : undefined,
    code: typeof clientError?.code === "number" ? clientError.code : undefined,
  });
}

interface Copy {
  brand: string;
  loading: string;
  loadingDescription: string;
  loginTitle: string;
  loginDescription: string;
  login: string;
  /** Per-provider button copy and region badge, aligned with the desktop login.oauth.* keys. */
  loginWith: Record<WebOAuthProviderId, string>;
  loginRegion: Record<WebOAuthProviderId, string>;
  expiredTitle: string;
  expiredDescription: string;
  notFoundTitle: string;
  notFoundDescription: string;
  notFoundAccountHint: string;
  backToHome: string;
  networkTitle: string;
  networkDescription: string;
  invalidTitle: string;
  invalidDescription: string;
  outdatedTitle: string;
  outdatedDescription: string;
  unavailableTitle: string;
  unavailableDescription: string;
  retry: string;
  continueInZCode: string;
  switchToDarkTheme: string;
  switchToLightTheme: string;
  continueHelp: string;
  downloadZCode: string;
  retryOpen: string;
  /** Artifact count; {count} placeholder. No plural in zh, singular/plural in en. */
  artifactCountOne: string;
  artifactCountOther: string;
}

// The site home page is the download entry; /download does not exist as a path (a dedicated link would 404).
const ZCODE_DOWNLOAD_URL = "https://zcode.z.ai";

const COPY: Record<ConversationShareLandingLocale, Copy> = {
  "zh-CN": {
    brand: "ZCode 会话分享",
    loading: "正在加载分享内容",
    loadingDescription: "请稍候，我们正在验证分享链接。",
    loginTitle: "登录后查看分享",
    loginDescription: "请登录后确认你是否有权限查看这个分享。",
    login: "登录",
    loginWith: {
      zai: "连接 Z.ai 继续使用",
      bigmodel: "连接 BigModel 继续使用",
    },
    loginRegion: { zai: "全球", bigmodel: "中国" },
    expiredTitle: "分享已过期",
    expiredDescription: "这个分享链接已经过期，请让分享者重新生成链接。",
    notFoundTitle: "找不到分享内容",
    notFoundDescription: "链接可能无效、分享已被移除，或当前登录账号无法访问。",
    notFoundAccountHint:
      "Z.ai 与 BigModel 的账号数据不互通。请检查是否选错了登录平台或使用了其他账号。",
    backToHome: "回到首页",
    networkTitle: "暂时无法加载分享",
    networkDescription: "请检查网络后重试。",
    invalidTitle: "分享格式无效",
    invalidDescription: "服务返回的分享内容无法通过安全校验。",
    outdatedTitle: "需要更新 ZCode",
    outdatedDescription: "这个分享由更新版本的 ZCode 创建，请升级后再查看。",
    unavailableTitle: "分享不可访问",
    unavailableDescription: "当前账号没有权限，或者分享内容已不存在。",
    retry: "重试",
    continueInZCode: "去 ZCode 继续",
    switchToDarkTheme: "切换到深色主题",
    switchToLightTheme: "切换到浅色主题",
    continueHelp: "如果没有自动打开 ZCode，请先下载客户端，或再次尝试打开。",
    downloadZCode: "下载 ZCode",
    artifactCountOne: "{count} 个结果物",
    artifactCountOther: "{count} 个结果物",
    retryOpen: "再次打开",
  },
  "en-US": {
    brand: "ZCode Conversation Share",
    loading: "Loading shared conversation",
    loadingDescription: "Please wait while we verify this share link.",
    loginTitle: "Sign in to view this share",
    loginDescription: "Sign in to check whether you can view this shared conversation.",
    login: "Sign in",
    loginWith: {
      zai: "Connect to Z.ai",
      bigmodel: "Connect to BigModel",
    },
    loginRegion: { zai: "Global", bigmodel: "CN" },
    expiredTitle: "Share expired",
    expiredDescription: "This share link has expired. Ask the author to create a new one.",
    notFoundTitle: "Share not found",
    notFoundDescription:
      "The link may be invalid, the share may have been removed, or your current account may not have access.",
    notFoundAccountHint:
      "Z.ai and BigModel do not share account data. Check whether you selected the wrong sign-in platform or used a different account.",
    backToHome: "Back to home",
    networkTitle: "Unable to load share",
    networkDescription: "Check your network connection and try again.",
    invalidTitle: "Invalid share content",
    invalidDescription: "The shared content failed the public safety contract.",
    outdatedTitle: "Update ZCode to continue",
    outdatedDescription:
      "This share was created by a newer version of ZCode. Please update to view it.",
    unavailableTitle: "Share unavailable",
    unavailableDescription:
      "This account is not allowed to view the share, or it no longer exists.",
    retry: "Try again",
    continueInZCode: "Continue in ZCode",
    switchToDarkTheme: "Switch to dark theme",
    switchToLightTheme: "Switch to light theme",
    continueHelp: "If ZCode did not open, download the app or try opening it again.",
    downloadZCode: "Download ZCode",
    artifactCountOne: "{count} artifact",
    artifactCountOther: "{count} artifacts",
    retryOpen: "Try again",
  },
};

function localeOf(locale?: ConversationShareLandingLocale): ConversationShareLandingLocale {
  if (locale) return locale;
  return /^zh(?:-|$)/iu.test(globalThis.navigator?.language ?? "") ? "zh-CN" : "en-US";
}

function formatDate(timestamp: number, locale: ConversationShareLandingLocale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(timestamp),
  );
}

const SHARE_CONTENT_RAIL_CLASS =
  "@container/conversation mx-auto w-full max-w-4xl px-4 sm:px-8 xl:max-w-6xl";
const SHARE_CONTINUE_LINK_CLASS =
  "inline-flex max-w-full items-center gap-2 rounded-xl bg-primary px-4 py-2 text-ui-base font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/80 focus-visible:ring-2 focus-visible:ring-input-border-focused sm:gap-3 sm:px-5 sm:py-2.5";
const SHARE_CONTINUE_MEASURE_CLASS =
  "inline-flex max-w-none items-center gap-2 rounded-xl bg-primary px-4 py-2 text-ui-base font-medium text-primary-foreground sm:gap-3 sm:px-5 sm:py-2.5";
const SHARE_CONTINUE_COMPACT_CLASS =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/80 focus-visible:ring-2 focus-visible:ring-input-border-focused";
const SHARE_THEME_TOGGLE_CLASS =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused";

function ShareThemeToggle({
  theme,
  copy,
  onThemeChange,
}: {
  theme: Theme;
  copy: Pick<Copy, "switchToDarkTheme" | "switchToLightTheme">;
  onThemeChange?: (theme: Theme) => void;
}) {
  const resolvedTheme = resolveTheme(theme);
  const nextTheme = resolvedTheme === "dark" ? "zai-light" : "zai-dark";
  const label = resolvedTheme === "dark" ? copy.switchToLightTheme : copy.switchToDarkTheme;
  const Icon = resolvedTheme === "dark" ? SunIcon : MoonIcon;

  return (
    <button
      type="button"
      data-share-theme-toggle="true"
      className={SHARE_THEME_TOGGLE_CLASS}
      aria-label={label}
      title={label}
      onClick={() => onThemeChange?.(nextTheme)}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

function ShareContentRail({
  children,
  className = "",
  body = false,
}: {
  children: React.ReactNode;
  className?: string;
  body?: boolean;
}) {
  return (
    <div
      data-share-content-rail="true"
      data-share-body-rail={body ? "true" : undefined}
      className={`${SHARE_CONTENT_RAIL_CLASS} ${className}`}
    >
      {children}
    </div>
  );
}

function ShareContentInset({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-share-content-inset="true"
      className={`w-full px-4 @md/conversation:px-6 ${className}`}
    >
      {children}
    </div>
  );
}

export function ConversationShareLandingPage({
  shareCode,
  preview,
  locale,
  theme,
  onThemeChange,
}: {
  shareCode: string;
  preview: ConversationSharePreview;
  locale?: ConversationShareLandingLocale;
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;
}) {
  const resolvedLocale = localeOf(locale);
  const copy = COPY[resolvedLocale];
  const activeTheme = theme ?? "zai-light";
  // Write the conversation title into the tab once the preview arrives; main.tsx can only set a locale-correct placeholder.
  const shareTitle = preview.share.title;
  useEffect(() => {
    document.title = `${shareTitle} · ${copy.brand}`;
  }, [copy.brand, shareTitle]);
  const [showContinueHelp, setShowContinueHelp] = useState(false);
  const importLink =
    preview.share.access_mode === "public_importable" || preview.share.access_mode === "private"
      ? buildShareImportDeepLink(shareCode)
      : null;
  // Count only artifact rows the timeline renders; preview.artifacts also carries download
  // manifests for userInput attachments, so its length is not the artifact count.
  const artifactCount = preview.rows.filter((row) => row.kind === "artifact").length;
  const artifactCountLabel = (
    artifactCount === 1 ? copy.artifactCountOne : copy.artifactCountOther
  ).replace("{count}", String(artifactCount));
  const artifactUrls = new Map(
    preview.artifacts.map((artifact) => [artifact.artifact_id, artifact.url]),
  );
  const artifactNames = new Map(
    preview.artifacts.map((artifact) => [artifact.artifact_id, artifact.display_name]),
  );
  const headerRowRef = useRef<HTMLDivElement>(null);
  const headerShellRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleMeasureRef = useRef<HTMLSpanElement>(null);
  const continueMeasureRef = useRef<HTMLSpanElement>(null);
  const compactContinueMeasureRef = useRef<HTMLSpanElement>(null);
  const [headerMeasured, setHeaderMeasured] = useState(false);
  const [headerView, setHeaderView] = useState<ShareHeaderView>({
    progress: 0,
    brandLeft: 0,
    titleLeft: 0,
    titleWidth: 0,
    continueRight: 0,
    titleTruncated: false,
    continueVisible: Boolean(importLink),
    continueCompact: false,
  });

  useLayoutEffect(() => {
    const row = headerRowRef.current;
    if (!row) return;
    const updateLayout = () => {
      const rowRect = row.getBoundingClientRect();
      const shellRect = headerShellRef.current?.getBoundingClientRect();
      if (!shellRect) return;
      const nextView = resolveShareHeaderView({
        shellWidth: shellRect.width,
        railContentLeft: rowRect.left - shellRect.left,
        railContentRight: shellRect.right - rowRect.right,
        brandWidth: brandRef.current?.getBoundingClientRect().width ?? 50,
        titleContentWidth: titleMeasureRef.current?.getBoundingClientRect().width ?? 0,
        continueWidth: continueMeasureRef.current?.getBoundingClientRect().width ?? 0,
        compactContinueWidth: compactContinueMeasureRef.current?.getBoundingClientRect().width ?? 0,
        hasContinueAction: Boolean(importLink),
      });
      setHeaderMeasured(true);
      setHeaderView((current) =>
        current.progress === nextView.progress &&
        current.brandLeft === nextView.brandLeft &&
        current.titleLeft === nextView.titleLeft &&
        current.titleWidth === nextView.titleWidth &&
        current.continueRight === nextView.continueRight &&
        current.titleTruncated === nextView.titleTruncated &&
        current.continueVisible === nextView.continueVisible &&
        current.continueCompact === nextView.continueCompact
          ? current
          : nextView,
      );
    };
    updateLayout();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateLayout);
    observer.observe(row);
    if (headerShellRef.current) observer.observe(headerShellRef.current);
    if (brandRef.current) observer.observe(brandRef.current);
    if (titleRef.current) observer.observe(titleRef.current);
    if (titleMeasureRef.current) observer.observe(titleMeasureRef.current);
    if (continueMeasureRef.current) observer.observe(continueMeasureRef.current);
    if (compactContinueMeasureRef.current) observer.observe(compactContinueMeasureRef.current);
    return () => observer.disconnect();
  }, [resolvedLocale, importLink]);

  const headerGeometryStyle = {
    "--share-brand-left": `${headerView.brandLeft}px`,
    "--share-title-left": `${headerView.titleLeft}px`,
    "--share-title-width": `${headerView.titleWidth}px`,
    "--share-continue-right": `${headerView.continueRight}px`,
  } as CSSProperties;

  const handleContinue = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      setShowContinueHelp(false);
      window.location.href = importLink!;
      window.setTimeout(() => {
        if (document.visibilityState === "visible") {
          setShowContinueHelp(true);
        }
      }, 1500);
    },
    [importLink],
  );

  return (
    <main
      className="h-full min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-background text-foreground [scrollbar-gutter:stable]"
      data-markdown-table-layout-root="true"
      data-share-scroll-viewport="true"
    >
      <header
        data-share-header="true"
        className="sticky top-0 z-20 border-b border-border bg-background backdrop-blur"
      >
        <div
          ref={headerShellRef}
          data-share-header-shell="true"
          data-share-header-layout="continuous"
          data-share-header-ready={headerMeasured ? "true" : "false"}
          className="w-full"
          style={headerGeometryStyle}
        >
          <ShareContentRail className="flex h-16 items-center">
            <ShareContentInset>
              <div
                ref={headerRowRef}
                data-share-header-row="true"
                className="h-full w-full min-w-0"
              >
                <div
                  ref={brandRef}
                  data-share-brand="true"
                  className="shrink-0 text-ui-lg font-semibold text-foreground"
                  aria-label="ZCode"
                >
                  ZCode
                </div>
                <h1
                  ref={titleRef}
                  data-share-title="true"
                  data-share-title-truncated={headerView.titleTruncated ? "true" : "false"}
                  className="truncate text-left text-ui-lg font-medium"
                  title={preview.share.title}
                >
                  {preview.share.title}
                </h1>
                <span
                  ref={titleMeasureRef}
                  data-share-title-measure="true"
                  className="text-ui-lg font-medium"
                  aria-hidden="true"
                >
                  {preview.share.title}
                </span>
                <div
                  data-share-continue-slot="true"
                  data-share-continue-visible={
                    importLink && headerView.continueVisible ? "true" : "false"
                  }
                >
                  <div className="flex items-center gap-2">
                    <ShareThemeToggle
                      theme={activeTheme}
                      copy={copy}
                      onThemeChange={onThemeChange}
                    />
                    {importLink && headerView.continueVisible ? (
                      <a
                        data-share-continue-link="true"
                        data-share-continue-compact={headerView.continueCompact ? "true" : "false"}
                        className={
                          headerView.continueCompact
                            ? SHARE_CONTINUE_COMPACT_CLASS
                            : SHARE_CONTINUE_LINK_CLASS
                        }
                        href={importLink}
                        aria-label={copy.continueInZCode}
                        title={copy.continueInZCode}
                        onClick={handleContinue}
                      >
                        <span className={headerView.continueCompact ? "sr-only" : "truncate"}>
                          {copy.continueInZCode}
                        </span>
                        <ArrowUpRightIcon
                          className={
                            headerView.continueCompact
                              ? "size-4 shrink-0"
                              : "size-4 shrink-0 sm:size-5"
                          }
                          aria-hidden="true"
                        />
                      </a>
                    ) : null}
                  </div>
                  <span
                    ref={continueMeasureRef}
                    data-share-continue-measure="true"
                    className="inline-flex items-center gap-2"
                    aria-hidden="true"
                    tabIndex={-1}
                  >
                    <span className={SHARE_THEME_TOGGLE_CLASS}>
                      <MoonIcon className="size-4" aria-hidden="true" />
                    </span>
                    {importLink ? (
                      <span className={SHARE_CONTINUE_MEASURE_CLASS}>
                        <span>{copy.continueInZCode}</span>
                        <ArrowUpRightIcon
                          className="size-4 shrink-0 sm:size-5"
                          aria-hidden="true"
                        />
                      </span>
                    ) : null}
                  </span>
                  <span
                    ref={compactContinueMeasureRef}
                    data-share-continue-compact-measure="true"
                    className="inline-flex items-center gap-2"
                    aria-hidden="true"
                    tabIndex={-1}
                  >
                    <span className={SHARE_THEME_TOGGLE_CLASS}>
                      <MoonIcon className="size-4" aria-hidden="true" />
                    </span>
                    {importLink ? (
                      <span className={SHARE_CONTINUE_COMPACT_CLASS}>
                        <ArrowUpRightIcon className="size-4" aria-hidden="true" />
                      </span>
                    ) : null}
                  </span>
                </div>
              </div>
            </ShareContentInset>
          </ShareContentRail>
        </div>
      </header>

      <ShareContentRail body className="py-6 sm:py-10">
        <ShareContentInset>
          <div
            data-share-metadata="true"
            className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-foreground-subtle"
          >
            <span>{formatDate(preview.share.created_at, resolvedLocale)}</span>
            {artifactCount ? (
              // This used to hardcode artifact/artifacts with a hand-written plural, rendering
              // mixed-locale rows (a zh-CN formatted date next to '1 artifact') on the zh page.
              <span aria-label={artifactCountLabel}>· {artifactCountLabel}</span>
            ) : null}
          </div>
        </ShareContentInset>
        {importLink && showContinueHelp ? (
          // This banner used to sit directly under ShareContentRail without ShareContentInset,
          // missing its px-4 / @md:px-6 and sticking out past the timestamp above and body below.
          <ShareContentInset>
            <div
              className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-ui-sm text-foreground-subtle"
              role="status"
            >
              <span>{copy.continueHelp}</span>
              <a
                className="text-brand underline underline-offset-2"
                href={importLink}
                onClick={handleContinue}
              >
                {copy.retryOpen}
              </a>
              <a className="text-brand underline underline-offset-2" href={ZCODE_DOWNLOAD_URL}>
                {copy.downloadZCode}
              </a>
            </div>
          </ShareContentInset>
        ) : null}
        <ConversationShareReadonlyTimeline
          rows={preview.rows}
          unsupportedRowCount={preview.unsupportedRowCount}
          locale={resolvedLocale}
          theme={theme}
          artifactUrls={artifactUrls}
          artifactNames={artifactNames}
        />
        {importLink ? (
          <ShareContentInset>
            <div
              data-share-continue-footer="true"
              className="flex justify-center pb-2 pt-8 sm:pt-10"
            >
              <a
                data-share-continue-link="true"
                className={SHARE_CONTINUE_LINK_CLASS}
                href={importLink}
                onClick={handleContinue}
              >
                <span className="truncate">{copy.continueInZCode}</span>
                <ArrowUpRightIcon className="size-4 shrink-0 sm:size-5" aria-hidden="true" />
              </a>
            </div>
          </ShareContentInset>
        ) : null}
      </ShareContentRail>
    </main>
  );
}

export function ConversationShareLandingStatus({
  state,
  locale,
  onLogin,
  onRetry,
}: {
  state: Exclude<ConversationShareLandingState, { kind: "ready" }>;
  locale?: ConversationShareLandingLocale;
  onLogin?: (provider: WebOAuthProviderId) => void;
  onRetry?: () => void;
}) {
  const copy = COPY[localeOf(locale)];
  const content =
    state.kind === "loading"
      ? { title: copy.loading, description: copy.loadingDescription }
      : state.kind === "login_required"
        ? { title: copy.loginTitle, description: copy.loginDescription }
        : state.error === "expired"
          ? { title: copy.expiredTitle, description: copy.expiredDescription }
          : state.error === "not_found"
            ? { title: copy.notFoundTitle, description: copy.notFoundDescription }
            : state.error === "unsupported_schema_version"
              ? { title: copy.outdatedTitle, description: copy.outdatedDescription }
              : state.error === "invalid_contract"
                ? { title: copy.invalidTitle, description: copy.invalidDescription }
                : state.error === "authentication_required"
                  ? { title: copy.loginTitle, description: copy.loginDescription }
                  : { title: copy.networkTitle, description: copy.networkDescription };
  const showLogin =
    state.kind === "login_required" ||
    (state.kind === "error" && state.error === "authentication_required");
  const isNotFound = state.kind === "error" && state.error === "not_found";
  /**
   * Offer retry only when repeating the same request could plausibly succeed.
   *
   * auth required means sign in, not retry -- an unauthorized request repeats identically;
   * expired never un-expires; a payload newer than this build needs a client upgrade. A retry
   * button on those is a guaranteed no-op.
   */
  const canRetry =
    Boolean(onRetry) &&
    state.kind !== "loading" &&
    !showLogin &&
    !(
      state.kind === "error" &&
      (state.error === "expired" || state.error === "unsupported_schema_version")
    );
  return (
    <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-md rounded-lg border border-card-border bg-card p-6 shadow-sm">
        <div className="mb-4 text-ui-sm font-medium text-brand">{copy.brand}</div>
        <h1 className="text-ui-xl font-semibold">{content.title}</h1>
        <p className="mt-3 text-ui-base leading-6 text-foreground-subtle">{content.description}</p>
        {/* The server hides whether a protected share exists; the account hint only aids debugging and must not claim the login is wrong. */}
        {isNotFound ? (
          <p className="mt-4 text-ui-base leading-6 text-foreground-subtle">
            {copy.notFoundAccountHint}
          </p>
        ) : null}
        {/*
          Both providers stacked full-width, matching the desktop login card
          (icon + copy + region badge). Both are required: the owner identity of a private
          share is provider-specific and the page cannot know which side owns it -- guessing
          wrong locks the user out of their own share.
        */}
        {showLogin && onLogin ? (
          <div className="mt-5 space-y-2">
            {SHARE_LOGIN_PROVIDERS.map((provider) => (
              <button
                key={provider}
                type="button"
                data-share-login-provider={provider}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-ui-base text-primary-foreground"
                onClick={() => onLogin(provider)}
              >
                {renderOAuthProviderIcon(provider, "size-4")}
                <span className="min-w-0 truncate">{copy.loginWith[provider]}</span>
                <span className="ml-1 inline-flex h-5 shrink-0 items-center rounded-full border border-primary-foreground/30 px-2 text-ui-xs font-medium leading-none text-primary-foreground/60">
                  {copy.loginRegion[provider]}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {canRetry || isNotFound ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {canRetry ? (
              <button
                type="button"
                className="rounded-md border border-border px-4 py-2 text-ui-base text-foreground"
                onClick={onRetry}
              >
                {copy.retry}
              </button>
            ) : null}
            {isNotFound ? (
              <a
                className="rounded-md bg-primary px-4 py-2 text-ui-base text-primary-foreground"
                href={ZCODE_DOWNLOAD_URL}
              >
                {copy.backToHome}
              </a>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}

export function ConversationShareLandingLoader({
  shareCode,
  client,
  getAccessToken,
  onLogin,
  onLogout,
  locale,
  theme,
}: {
  shareCode: string;
  client: {
    getPreview: (shareCode: string, accessToken?: string) => Promise<ConversationSharePreview>;
  };
  getAccessToken?: () => string | null;
  onLogin?: (provider: WebOAuthProviderId) => void;
  onLogout?: () => void;
  locale?: ConversationShareLandingLocale;
  theme?: Theme;
}) {
  const [state, setState] = useState<ConversationShareLandingState>({ kind: "loading" });
  const [activeTheme, setActiveTheme] = useState<Theme>(theme ?? "zai-light");
  const handleThemeChange = useCallback((nextTheme: Theme) => {
    localStorage.setItem("zcode-theme", nextTheme);
    setActiveTheme(nextTheme);
    applyTheme(nextTheme);
  }, []);
  useEffect(() => {
    if (activeTheme !== "system") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => applyTheme("system");
    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, [activeTheme]);
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    // Attach credentials on the first attempt when present: for private shares an anonymous
    // request is a guaranteed existence-hiding 404, so an anonymous probe just wastes a round
    // trip. Without credentials, still try anonymously -- public shares need no login, and
    // prompting for login merely because the token is missing would be wrong.
    const initialToken = getAccessToken?.() ?? null;
    try {
      const preview = await client.getPreview(shareCode, initialToken ?? undefined);
      setState({ kind: "ready", preview });
    } catch (error) {
      const kind =
        error && typeof error === "object" && "kind" in error
          ? (error as ConversationSharePreviewClientError).kind
          : "network";
      logPreviewLoadFailure(initialToken ? "authenticated" : "anonymous", error, kind);
      if (kind === "authentication_required" || kind === "not_found") {
        // A failure after sending credentials is final: either the local session is stale (the
        // host must clear it and re-auth) or the server rejects this viewer.
        if (initialToken) {
          setState({ kind: "error", error: kind });
          if (kind === "authentication_required") onLogout?.();
          return;
        }
        setState({ kind: "login_required" });
        return;
      }
      setState({ kind: "error", error: kind });
    }
  }, [client, getAccessToken, onLogout, shareCode]);
  useEffect(() => {
    void load();
  }, [load]);
  if (state.kind === "ready")
    return (
      <ConversationShareLandingPage
        shareCode={shareCode}
        preview={state.preview}
        locale={locale}
        theme={activeTheme}
        onThemeChange={handleThemeChange}
      />
    );
  return (
    <ConversationShareLandingStatus
      state={state}
      locale={locale}
      onLogin={onLogin}
      onRetry={() => void load()}
    />
  );
}
