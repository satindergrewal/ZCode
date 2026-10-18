import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { renderAsync, type Options } from "docx-preview";
import {
  calculateDocxPreviewFit,
  installDocumentLinkSafety,
  type DocxPreviewFit,
} from "@/lib/officeFilePreview.js";
import { logger } from "@/logger.js";

const DOCX_RENDER_OPTIONS = {
  breakPages: true,
  debug: false,
  experimental: true,
  ignoreFonts: false,
  ignoreHeight: false,
  // docx-preview@0.4.0 merges adjacent sections with equal paper size but different margins when
  // this is false, losing the page break after the cover and inheriting its zero margins. Keep the
  // official preview's default: preserve OOXML section boundaries and per-page pgMar.
  ignoreLastRenderedPageBreak: true,
  ignoreWidth: false,
  inWrapper: true,
  renderAltChunks: false,
  renderChanges: false,
  renderComments: false,
  renderEndnotes: true,
  renderFooters: true,
  renderFootnotes: true,
  renderHeaders: true,
  useBase64URL: true,
} satisfies Partial<Options>;

const DOCX_PAGE_BOX_SHADOW = "0 2px 10px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.05)";

let nextDocxPreviewClassId = 0;

function createDocxPreviewClassName(): string {
  nextDocxPreviewClassId += 1;
  return `zcode-docx-preview-${nextDocxPreviewClassId}`;
}

function isSameDocxPreviewFit(current: DocxPreviewFit | null, next: DocxPreviewFit): boolean {
  return (
    current !== null &&
    Math.abs(current.scale - next.scale) < 0.001 &&
    Math.abs(current.width - next.width) < 0.5 &&
    Math.abs(current.height - next.height) < 0.5
  );
}

export function PreviewPaneOfficeDocxContent({
  buffer,
  errorMessage,
  onOpenBrowserUrl,
  sourcePath,
}: {
  buffer: ArrayBuffer;
  errorMessage: string;
  onOpenBrowserUrl?: (url: string) => void;
  sourcePath: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const renderContainerRef = useRef<HTMLDivElement | null>(null);
  const [previewClassName] = useState(createDocxPreviewClassName);
  const [fit, setFit] = useState<DocxPreviewFit | null>(null);
  const [renderState, setRenderState] = useState<"loading" | "ready" | "error">("loading");

  const updateFit = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || renderState !== "ready") {
      return;
    }

    const next = calculateDocxPreviewFit({
      availableWidth: viewport.clientWidth,
      naturalHeight: content.offsetHeight,
      naturalWidth: content.offsetWidth,
    });
    if (!next) {
      return;
    }

    setFit((current) => {
      if (isSameDocxPreviewFit(current, next)) {
        return current;
      }
      // Debug note: dragging the Preview Pane fires ResizeObserver per frame; high-frequency size
      // traces stay debug-only and never persist in production, keeping log volume far below the
      // resize event rate.
      logger.debug("[PreviewPane] DOCX preview width synced", {
        path: sourcePath,
        availableWidth: viewport.clientWidth,
        naturalWidth: content.offsetWidth,
        scale: next.scale,
      });
      return next;
    });
  }, [renderState, sourcePath]);

  useEffect(() => {
    const visibleContainer = renderContainerRef.current;
    if (!visibleContainer) {
      return;
    }

    let active = true;
    let disposeLinkSafety: (() => void) | undefined;
    const className = previewClassName;
    const renderRoot = document.createElement("div");
    const styleContainer = document.createElement("div");
    const bodyContainer = document.createElement("div");
    renderRoot.dataset.docxRenderRoot = "";
    styleContainer.dataset.docxRenderStyles = "";
    bodyContainer.dataset.docxRenderBody = "";
    renderRoot.append(styleContainer, bodyContainer);

    setRenderState("loading");
    setFit(null);
    visibleContainer.replaceChildren();

    void renderAsync(buffer, bodyContainer, styleContainer, {
      ...DOCX_RENDER_OPTIONS,
      className,
    })
      .then(() => {
        if (!active) {
          return;
        }

        const wrapper = bodyContainer.querySelector<HTMLElement>(`.${className}-wrapper`);
        if (wrapper) {
          // docx-preview paints a gray page background and fixed 30px padding by default, which
          // fights the Preview Pane theme and lets narrow-screen scaling count decoration gaps
          // into the paper width.
          wrapper.style.background = "transparent";
          wrapper.style.padding = "0";
          wrapper.style.width = "max-content";
        }

        // docx-preview's default 50% black page shadow is too heavy here; append scoped styles
        // reusing react-docx's light paper shadow, overriding every page of the current document
        // in one pass.
        const pageSurfaceStyle = document.createElement("style");
        pageSurfaceStyle.dataset.docxPageSurfaceStyle = "";
        pageSurfaceStyle.textContent = `.${className}-wrapper>section.${className} { box-shadow: ${DOCX_PAGE_BOX_SHADOW}; }`;
        styleContainer.append(pageSurfaceStyle);

        disposeLinkSafety = installDocumentLinkSafety(renderRoot, onOpenBrowserUrl);

        visibleContainer.replaceChildren(renderRoot);
        setRenderState("ready");
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        logger.error("[PreviewPane] DOCX parse failed", {
          path: sourcePath,
          error: message,
        });
        visibleContainer.replaceChildren();
        setRenderState("error");
      });

    return () => {
      // renderAsync cannot be cancelled; after a file switch only the latest source may commit
      // visible DOM. Older tasks finishing later stay in their detached temp container.
      active = false;
      disposeLinkSafety?.();
      renderRoot.remove();
      visibleContainer.replaceChildren();
    };
  }, [buffer, onOpenBrowserUrl, previewClassName, sourcePath]);

  useLayoutEffect(() => {
    if (renderState !== "ready") {
      return;
    }

    updateFit();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(updateFit);
    if (viewportRef.current) {
      resizeObserver.observe(viewportRef.current);
    }
    if (contentRef.current) {
      resizeObserver.observe(contentRef.current);
    }
    return () => {
      resizeObserver.disconnect();
    };
  }, [renderState, updateFit]);

  return (
    <div
      aria-busy={renderState === "loading" ? "true" : undefined}
      className="h-full min-h-0 w-full min-w-0 bg-background"
      data-office-preview-kind="docx"
      data-office-preview-pending={renderState === "loading" ? "" : undefined}
    >
      {renderState === "error" ? (
        <div className="p-3 text-ui-base text-destructive" role="alert">
          {errorMessage}
        </div>
      ) : null}
      <div
        className={
          renderState === "error"
            ? "hidden"
            : "h-full min-h-0 w-full min-w-0 overflow-auto p-4 max-sm:p-2"
        }
      >
        <div ref={viewportRef} className="w-full min-w-0" data-docx-fit-viewport>
          <div
            className="relative mx-auto"
            data-docx-fit-frame
            style={fit ? { width: fit.width, height: fit.height } : undefined}
          >
            {/* docx-preview keeps the paper's native width; narrow Preview Panes must shrink only,
                never enlarge, and sync the wrapper box so no unscaled horizontal scroll survives. */}
            <div
              ref={contentRef}
              className="w-max"
              data-docx-fit-content
              style={
                fit
                  ? {
                      position: "absolute",
                      left: 0,
                      top: 0,
                      transform: `scale(${fit.scale})`,
                      transformOrigin: "top left",
                    }
                  : undefined
              }
            >
              <div ref={renderContainerRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
