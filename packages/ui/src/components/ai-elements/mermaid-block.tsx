"use client";

import { createMermaidPlugin, type MermaidConfig } from "@streamdown/mermaid";
import { Loader2Icon } from "lucide-react";
import type { HTMLAttributes } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { Theme } from "@/useTheme.js";
import { resolveTheme } from "@/useTheme.js";

type MermaidRenderState =
  | {
      status: "loading";
    }
  | {
      status: "ready";
      svg: string;
    }
  | {
      status: "plaintext";
    };

export interface MermaidBlockProps extends HTMLAttributes<HTMLDivElement> {
  code: string;
  /**
   * App theme (store decoupling): passed in from upper-level state by the caller.
   * The default "system" follows the OS, a fallback for legacy call sites pending removal.
   */
  theme?: Theme;
  onOpenPreview?: () => void;
  onPreviewSvgChange?: (svg: string | null) => void;
}

const mermaidPlugin = createMermaidPlugin();
let mermaidRenderQueue = Promise.resolve();
const MERMAID_COLOR_CANVAS_SENTINEL = "#010203";

// Mermaid's khroma parser does not understand oklab/color-mix results common in
// Tailwind v4. Let the browser resolve theme tokens first, then sample to plain rgb/rgba
// via canvas instead of handing modern CSS colors straight to Mermaid.
// The web-remote smoke test only stubs a minimal document, and SSR/prerender may have no
// DOM factory either; normalization is an enhancement and must never crash the static
// import of MessageResponse in such environments.
const canCreateDomElements =
  typeof document !== "undefined" && typeof document.createElement === "function";
const mermaidColorResolverEl: HTMLSpanElement | null = canCreateDomElements
  ? document.createElement("span")
  : null;
const mermaidColorNormalizeCtx: CanvasRenderingContext2D | null = (() => {
  if (!canCreateDomElements) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx) {
    ctx.globalCompositeOperation = "copy";
  }
  return ctx;
})();

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function hashMermaidCode(code: string): string {
  let hash = 2166136261;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function normalizeCssColorForMermaid(raw: string, fallback: string): string {
  if (!raw || !mermaidColorResolverEl || !mermaidColorNormalizeCtx || !document.body) {
    return raw || fallback;
  }

  try {
    document.body.appendChild(mermaidColorResolverEl);
    mermaidColorResolverEl.style.color = "";
    mermaidColorResolverEl.style.color = raw;
    const resolved = getComputedStyle(mermaidColorResolverEl).color;
    if (!resolved) {
      return fallback;
    }

    mermaidColorNormalizeCtx.clearRect(0, 0, 1, 1);
    mermaidColorNormalizeCtx.fillStyle = MERMAID_COLOR_CANVAS_SENTINEL;
    const sentinelFillStyle = mermaidColorNormalizeCtx.fillStyle;
    mermaidColorNormalizeCtx.fillStyle = resolved;
    // If canvas rejects the color format too, fillStyle keeps the sentinel and we fall
    // back to a Mermaid-parseable safe color.
    if (mermaidColorNormalizeCtx.fillStyle === sentinelFillStyle) {
      return fallback;
    }

    mermaidColorNormalizeCtx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = mermaidColorNormalizeCtx.getImageData(0, 0, 1, 1).data;
    const roundedAlpha = +(a / 255).toFixed(3);
    return roundedAlpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${roundedAlpha})`;
  } catch {
    return fallback;
  } finally {
    mermaidColorResolverEl.remove();
  }
}

function resolveCssColor(variableName: string, fallback: string): string {
  if (typeof document === "undefined" || !document.body) {
    return fallback;
  }

  const probe = document.createElement("span");
  probe.style.color = `var(${variableName})`;
  probe.style.pointerEvents = "none";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();

  return normalizeCssColorForMermaid(color, fallback);
}

function createMermaidConfig(resolvedTheme: "light" | "dark"): MermaidConfig {
  const background = resolveCssColor(
    "--color-card",
    resolvedTheme === "dark" ? "#18181b" : "#ffffff",
  );
  const surface = resolveCssColor(
    "--color-surface",
    resolvedTheme === "dark" ? "#27272a" : "#f4f4f5",
  );
  const accent = resolveCssColor(
    "--color-accent",
    resolvedTheme === "dark" ? "#1f2937" : "#f0f9ff",
  );
  const text = resolveCssColor(
    "--color-foreground",
    resolvedTheme === "dark" ? "#f4f4f5" : "#27272a",
  );
  const subtleText = resolveCssColor(
    "--color-foreground-subtle",
    resolvedTheme === "dark" ? "#a1a1aa" : "#52525b",
  );
  const border = resolveCssColor(
    "--color-border",
    resolvedTheme === "dark" ? "#3f3f46" : "#d4d4d8",
  );

  return {
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: {
      actorBkg: background,
      actorBorder: border,
      actorTextColor: text,
      background,
      lineColor: subtleText,
      mainBkg: background,
      nodeBorder: border,
      noteBkgColor: accent,
      noteTextColor: text,
      primaryBorderColor: border,
      primaryColor: surface,
      primaryTextColor: text,
      secondaryBorderColor: border,
      secondaryColor: accent,
      secondaryTextColor: text,
      signalColor: subtleText,
      signalTextColor: text,
      tertiaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: text,
      textColor: text,
    },
  };
}

function resolveBrowserTheme(theme: Theme): "light" | "dark" {
  if (typeof window === "undefined") {
    return theme === "dark" || theme === "zai-dark" ? "dark" : "light";
  }

  return resolveTheme(theme);
}

function useSystemThemeRevision(theme: Theme): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setRevision((current) => current + 1);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [theme]);

  return revision;
}

function normalizeMermaidRenderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MermaidBlock({
  code,
  className,
  theme = "system",
  onOpenPreview,
  onPreviewSvgChange,
  ...props
}: MermaidBlockProps) {
  const { intl } = useZCodeIntl();
  const systemThemeRevision = useSystemThemeRevision(theme);
  const renderIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const trimmedCode = code.trim();
  const resolvedTheme = resolveBrowserTheme(theme);
  const themeKey = `${theme}:${resolvedTheme}:${systemThemeRevision}`;
  const mermaidConfig = useMemo(
    () => createMermaidConfig(resolvedTheme),
    [resolvedTheme, themeKey],
  );
  const renderKey = useMemo(
    () => `${themeKey}:${hashMermaidCode(trimmedCode)}`,
    [themeKey, trimmedCode],
  );
  const [renderState, setRenderState] = useState<MermaidRenderState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;

    if (!trimmedCode) {
      setRenderState({
        status: "plaintext",
      });
      onPreviewSvgChange?.(null);
      return;
    }

    setRenderState({ status: "loading" });
    onPreviewSvgChange?.(null);
    const renderId = `zcode-mermaid-${renderIdPrefix}-${hashMermaidCode(renderKey)}`;

    void enqueueMermaidRender(async () => {
      const renderer = mermaidPlugin.getMermaid(mermaidConfig);
      return renderer.render(renderId, trimmedCode);
    })
      .then(({ svg }) => {
        if (!cancelled) {
          setRenderState({ status: "ready", svg });
          onPreviewSvgChange?.(svg);
        }
      })
      .catch((error: unknown) => {
        const message = normalizeMermaidRenderError(error);
        logger.debug("[MermaidBlock] Mermaid render failed", {
          error: message,
          codeLength: trimmedCode.length,
        });
        if (!cancelled) {
          // Parse failures usually mean unfinished streamed output or non-standard pasted
          // syntax. Falling back to plain text keeps it readable instead of interrupting the
          // chat with an error panel.
          setRenderState({ status: "plaintext" });
          onPreviewSvgChange?.(null);
        }
      });

    return () => {
      cancelled = true;
      onPreviewSvgChange?.(null);
    };
  }, [intl, mermaidConfig, onPreviewSvgChange, renderIdPrefix, renderKey, trimmedCode]);

  return (
    <div
      className={cn("group/mermaid relative min-h-32 w-full bg-card", className)}
      data-mermaid-block=""
      {...props}
    >
      <div className="max-h-[420px] overflow-auto p-3 text-foreground">
        {renderState.status === "loading" ? (
          <div className="flex min-h-28 items-center justify-center gap-2 text-foreground-subtle text-ui-base">
            <Loader2Icon className="size-4 animate-spin" />
            <span>{intl.formatMessage({ id: "codeBlock.mermaid.loading" })}</span>
          </div>
        ) : null}
        {renderState.status === "plaintext" ? (
          <pre className="m-0 min-h-28 min-w-max bg-transparent font-mono text-foreground text-ui-base leading-relaxed">
            {code}
          </pre>
        ) : null}
        {renderState.status === "ready" ? (
          <div
            aria-label={intl.formatMessage({ id: "codeBlock.mermaid.ariaLabel" })}
            className="flex min-h-28 min-w-max items-center justify-center [&_svg]:h-auto [&_svg]:max-w-none"
            dangerouslySetInnerHTML={{ __html: renderState.svg }}
            onDoubleClick={onOpenPreview}
            role="img"
          />
        ) : null}
      </div>
    </div>
  );
}
