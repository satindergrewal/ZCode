import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  isTrustedCodingPlanWebviewOrigin,
  isZaiCodingPlanProviderId,
  normalizeZCodeEndpointOrigin,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import type { CodingPlanWebviewLocale } from "@zcode/shared";
import type { CodingPlanFunnelContext } from "@/lib/codingPlanFunnelTelemetry.js";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";

type CodingPlanWebsiteProvider = "zai" | "bigmodel";
export type CodingPlanPurchaseAudience = "personal" | "team";

export interface CodingPlanEmbeddedCredentials {
  zaiAccessToken?: string | null;
  zcodeJwtToken?: string | null;
  bigmodelAccessToken?: string | null;
}

interface CodingPlanEmbeddedReportContext {
  purchase_funnel_id?: string;
  purchase_entry_reporter?: "app";
  upgrade_source?: string;
  event_region?: string;
  event_text?: string;
  entry_plan_status?: string;
  entry_plan_level?: string;
  entry_plan_list?: string;
  purchase_audience?: string;
  provider_family?: string;
  channel?: string;
  device_mid?: string;
  user_id?: string;
  app_version?: string;
}

export type CodingPlanEmbeddedTheme = "zai-light" | "zai-dark";

/**
 * App locale (zh-CN / en-US) -> official-site URL lang segment (cn / en).
 * Feeds the webview URL's ?lang= hint so the site's first paint has the right language, avoiding an English flash before injection.
 */
function codingPlanLocaleToWebsiteLang(
  locale: CodingPlanWebviewLocale | null | undefined,
): "cn" | "en" {
  return locale === "zh-CN" ? "cn" : "en";
}

interface ResolveCodingPlanEmbeddedOriginOptions {
  endpointOrigin: string;
  e2eStoreBridgeEnabled?: boolean;
  overrideOrigin?: string | null;
}

export const CODING_PLAN_WEBVIEW_OVERRIDE_ENV_KEY = "VITE_CODING_PLAN_WEBVIEW_ORIGIN";
const CODING_PLAN_WEBVIEW_CREDENTIAL_LOCAL_STORAGE_KEYS = [
  "oauth:zai:access_token",
  "zcodejwttoken",
  "oauth:bigmodel:access_token",
] as const;
const CODING_PLAN_REPORT_CONTEXT_STORAGE_KEY = "zcode:coding-plan:report-context";

export function resolveCodingPlanWebsiteProvider(
  providerId: CodingPlanProviderId,
): CodingPlanWebsiteProvider {
  return isZaiCodingPlanProviderId(providerId) ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
    ? "zai"
    : "bigmodel";
}

export function resolveCodingPlanEmbeddedOrigin({
  endpointOrigin,
  e2eStoreBridgeEnabled,
  overrideOrigin,
}: ResolveCodingPlanEmbeddedOriginOptions): string {
  const normalizedOverride = overrideOrigin?.trim();
  if (
    normalizedOverride &&
    isTrustedCodingPlanWebviewOrigin(normalizedOverride, { e2eStoreBridgeEnabled })
  ) {
    return normalizeZCodeEndpointOrigin(normalizedOverride);
  }
  const normalizedEndpointOrigin = normalizeZCodeEndpointOrigin(endpointOrigin);
  return isTrustedCodingPlanWebviewOrigin(normalizedEndpointOrigin, { e2eStoreBridgeEnabled })
    ? normalizedEndpointOrigin
    : DEFAULT_ZCODE_ENDPOINT_ORIGIN;
}

export function buildCodingPlanEmbeddedWebviewUrl({
  origin,
  provider,
  locale,
  theme,
  audience,
  teamPlanKey,
}: {
  origin: string;
  provider: CodingPlanWebsiteProvider;
  // The App's current locale, as the site's first-paint language hint (?lang=cn|en), avoiding an English flash before injection.
  locale?: CodingPlanWebviewLocale | null;
  // The site's SSR default is dark; on first WebView open localStorage has no theme yet,
  // so the App's current theme must ride along in the URL for the site's head script to read pre-first-paint.
  theme?: CodingPlanEmbeddedTheme | null;
  audience?: CodingPlanPurchaseAudience;
  teamPlanKey?: string | null;
}): string {
  const url = new URL("/coding-plan", normalizeZCodeEndpointOrigin(origin));
  url.searchParams.set("provider", provider);
  url.searchParams.set("embedded", "app");
  url.searchParams.set("lang", codingPlanLocaleToWebsiteLang(locale));
  if (audience) {
    url.searchParams.set("audience", audience);
  }
  if (teamPlanKey?.trim()) {
    url.searchParams.set("teamPlanKey", teamPlanKey.trim());
  }
  if (theme) {
    url.searchParams.set("theme", theme);
  }
  return url.toString();
}

export function isTrustedCodingPlanEmbeddedWebviewUrl(
  value: string | null | undefined,
  options?: {
    e2eStoreBridgeEnabled?: boolean;
  },
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: options?.e2eStoreBridgeEnabled,
      })
    ) {
      return false;
    }
    if (!url.pathname.includes("coding-plan")) return false;
    if (url.searchParams.get("embedded") === "app") return true;
    // After PayPal success the flow returns to /coding-plan/payment/callback with embedded=app
    // inside returnTo. That page still needs the App-injected OAuth token to subscribe, so it must
    // not be treated as an external site and get its credentials cleared.
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    const returnTo = url.searchParams.get("returnTo");
    if (!returnTo) return false;
    const target = new URL(returnTo, url.origin);
    return (
      target.origin === url.origin &&
      target.pathname.includes("coding-plan") &&
      target.searchParams.get("embedded") === "app" &&
      !target.pathname.endsWith("/coding-plan/payment/callback")
    );
  } catch {
    return false;
  }
}

export function createCodingPlanAuthInjectionScript({
  provider,
  credentials,
  theme,
  locale,
  reportContext,
}: {
  provider: CodingPlanWebsiteProvider;
  credentials: CodingPlanEmbeddedCredentials;
  theme: CodingPlanEmbeddedTheme;
  // The App's current locale, written to window.__zcodeLang__ for zcodeBridge.getLang(),
  // and attached to the auth-ready event detail so the site syncs the initial language once.
  locale: CodingPlanWebviewLocale | null;
  reportContext?: CodingPlanEmbeddedReportContext | null;
}): string {
  const values: Record<string, string | null> =
    provider === "zai"
      ? {
          "oauth:zai:access_token": credentials.zaiAccessToken?.trim() || null,
          zcodejwttoken: credentials.zcodeJwtToken?.trim() || null,
          "oauth:bigmodel:access_token": null,
        }
      : {
          "oauth:zai:access_token": null,
          // zcodejwttoken is the common zcode-plan credential (the BigModel OAuth callback persists it too);
          // the site queries billing/balance with it to detect an active Start Plan. Missing it in the
          // BigModel branch makes the site's Start Plan card falsely show "expired" because entitlement
          // lookup fails. Business APIs keep using oauth:bigmodel:access_token; the two never mix.
          zcodejwttoken: credentials.zcodeJwtToken?.trim() || null,
          "oauth:bigmodel:access_token": credentials.bigmodelAccessToken?.trim() || null,
        };
  const storageUpdates = Object.entries(values)
    .map(([key, value]) =>
      value
        ? `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`
        : `localStorage.removeItem(${JSON.stringify(key)});`,
    )
    .join("\n  ");
  const resolvedLocale: CodingPlanWebviewLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  const normalizedReportContext = normalizeCodingPlanEmbeddedReportContext(reportContext);

  return `(() => {
  ${storageUpdates}
  const zcodeTheme = ${JSON.stringify(theme)};
  document.documentElement.classList.toggle("dark", zcodeTheme === "zai-dark");
  document.documentElement.classList.toggle("theme-zai-light", zcodeTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", zcodeTheme === "zai-dark");
  localStorage.setItem("zcode-theme", zcodeTheme);
  localStorage.setItem("zcode:coding-plan:embedded", "app");
  // Writes the current App locale for the site's zcodeBridge.getLang().
  // Note: this is raw JS executed in the webview; no TS syntax (e.g. as any) allowed.
  window.__zcodeLang__ = ${JSON.stringify(resolvedLocale)};
  const zcodeReportContext = ${JSON.stringify(normalizedReportContext)};
  window.__zcodeReportContext__ = zcodeReportContext;
  localStorage.setItem(${JSON.stringify(CODING_PLAN_REPORT_CONTEXT_STORAGE_KEY)}, JSON.stringify(zcodeReportContext));
  window.dispatchEvent(new CustomEvent("zcode-coding-plan-auth-ready", {
    detail: { ...${JSON.stringify({ provider, locale: resolvedLocale })}, reportContext: zcodeReportContext },
  }));
})()`;
}

export function buildCodingPlanEmbeddedReportContext({
  funnelContext,
  deviceMid,
  userId,
  appVersion,
}: {
  funnelContext?: CodingPlanFunnelContext | null;
  deviceMid?: string | null;
  userId?: string | null;
  appVersion?: string | null;
}): CodingPlanEmbeddedReportContext {
  return normalizeCodingPlanEmbeddedReportContext({
    purchase_funnel_id: funnelContext?.purchaseFunnelId,
    // Without the attribution marker the site keeps its legacy duplicate-reporting entry; with no funnel, never claim the App took over.
    purchase_entry_reporter: funnelContext ? "app" : undefined,
    upgrade_source: funnelContext?.upgradeSource,
    event_region: funnelContext?.eventRegion,
    event_text: funnelContext?.eventText,
    entry_plan_status: funnelContext?.entryPlanStatus,
    entry_plan_level: funnelContext?.entryPlanLevel,
    entry_plan_list: funnelContext?.entryPlanList,
    purchase_audience: funnelContext?.purchaseAudience,
    provider_family: funnelContext?.providerFamily,
    channel: funnelContext?.channel,
    device_mid: deviceMid ?? undefined,
    user_id: userId ?? undefined,
    app_version: appVersion ?? undefined,
  });
}

function normalizeCodingPlanEmbeddedReportContext(
  context: CodingPlanEmbeddedReportContext | null | undefined,
): CodingPlanEmbeddedReportContext {
  if (!context) return {};
  return Object.fromEntries(
    Object.entries(context).flatMap(([key, value]) => {
      if (typeof value !== "string") return [];
      const normalized = value.trim();
      return normalized ? [[key, normalized]] : [];
    }),
  ) as CodingPlanEmbeddedReportContext;
}

export function createCodingPlanCredentialClearScript(): string {
  const keys = [...CODING_PLAN_WEBVIEW_CREDENTIAL_LOCAL_STORAGE_KEYS];
  return `(() => {
  for (const key of ${JSON.stringify(keys)}) {
    localStorage.removeItem(key);
  }
  localStorage.removeItem(${JSON.stringify(CODING_PLAN_REPORT_CONTEXT_STORAGE_KEY)});
  delete window.__zcodeReportContext__;
})()`;
}

export function createCodingPlanScrollbarHideScript(): string {
  return `(() => {
  const styleId = "zcode-coding-plan-hide-scrollbar";
  if (document.getElementById(styleId)) return;
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = \`
html,
body,
* {
  scrollbar-width: none !important;
}

html::-webkit-scrollbar,
body::-webkit-scrollbar,
*::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
\`;
  document.head.appendChild(style);
})()`;
}

/**
 * Builds the "update webview locale" injection script.
 * When the App locale changes at runtime, executeJavaScript this in the webview:
 * it rewrites window.__zcodeLang__ and dispatches zcode-coding-plan-lang-change, which the site
 * (zcodeBridge.onLangChange or a window listener) uses to switch languages seamlessly.
 */
export function createCodingPlanLangInjectionScript(locale: CodingPlanWebviewLocale): string {
  const resolvedLocale: CodingPlanWebviewLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  return `(() => {
  // Note: raw JS executed in the webview; no TS syntax (e.g. as any) allowed.
  window.__zcodeLang__ = ${JSON.stringify(resolvedLocale)};
  window.dispatchEvent(new CustomEvent("zcode-coding-plan-lang-change", {
    detail: ${JSON.stringify({ locale: resolvedLocale })},
  }));
})()`;
}

export function getCodingPlanCredentialKeys(provider: CodingPlanWebsiteProvider): string[] {
  // zcodejwttoken loads for both providers: it is the common zcode-plan credential, also persisted by
  // the BigModel OAuth callback (see resolveBigModelStartPlanZcodeJwt).
  return provider === "zai"
    ? [`oauth:${ZAI_PROVIDER_ID}:access_token`, "zcodejwttoken"]
    : [`oauth:${BIGMODEL_PROVIDER_ID}:access_token`, "zcodejwttoken"];
}
