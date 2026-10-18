"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileDownIcon,
  Loader2Icon,
  MousePointer2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { PopoverAnchor } from "@/components/ui/popover.js";
import { toast } from "@/components/ui/toast.js";
import { PptxSelectionActionBar } from "@/components/ui/pptx-selection-action-bar.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import type { PresentationPrintHost } from "@/presentation/presentationPdfPrintExport.js";
import {
  PPTX_MAX_ZOOM_PERCENT,
  PPTX_MIN_ZOOM_PERCENT,
  PPTX_ZOOM_STEP_PERCENT,
  clampPresentationPageNumber,
  clampPresentationZoomPercent,
} from "@/presentation/presentationPreviewControls.js";
import { hitTestPresentationElement } from "@/presentation/presentationElementModel.js";
import { getPresentationElementSelectedText } from "@/presentation/presentationTextSelection.js";
import type {
  PresentationPageSize,
  PresentationPageElement,
  PresentationPreviewDocument,
  PresentationRenderHandle,
} from "@/presentation/types.js";
import { installDocumentLinkSafety, sanitizeDocumentHref } from "@/lib/officeFilePreview.js";
import type { PptxReferencePreviewNavigation } from "@/lib/codeViewer.js";
import {
  createPptxElementReference,
  dispatchPptxElementReferenceAddToChat,
  sha256Fingerprint,
  type PptxElementReferenceSource,
} from "@/lib/pptxElementReference.js";

export interface PptxPreviewViewerLabels {
  loading: string;
  loadError: string;
  noSlides: string;
  previousPage: string;
  nextPage: string;
  pageInput: string;
  zoomIn: string;
  zoomOut: string;
  thumbnails: string;
  thumbnail: (pageNumber: number) => string;
  exportPdf: string;
  exportingPdf: string;
  exportPdfSuccess: (path: string) => string;
  exportPdfFailed: string;
  selectElement: string;
  exitElementSelection: string;
  aiEdit: string;
  commentPlaceholder: string;
  cancelAiEdit: string;
  addToConversation: string;
  referencedPageMissing: (pageNumber: number) => string;
  referencedSourceChanged: (pageNumber: number) => string;
}

interface RenderedPageProps {
  document: PresentationPreviewDocument;
  pageIndex: number;
  scale: number;
  generation: number;
  interactive?: boolean;
  onNavigate?: (pageIndex: number) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onRenderError?: (generation: number, error: Error) => void;
  selectionMode?: boolean;
  elements?: readonly PresentationPageElement[];
  selectedElement?: PresentationPageElement | null;
  onSelectElement?: (element: PresentationPageElement) => void;
  renderSurfaceRef?: RefObject<HTMLDivElement | null>;
}

function isSamePresentationElement(
  left: PresentationPageElement | null | undefined,
  right: PresentationPageElement | null | undefined,
) {
  if (!left || !right) {
    return false;
  }
  return (
    left.nodeId === right.nodeId &&
    left.nodeType === right.nodeType &&
    left.rowIndex === right.rowIndex &&
    left.cellIndex === right.cellIndex
  );
}

function toPresentationPoint(
  surface: HTMLElement,
  pageSize: PresentationPageSize,
  clientX: number,
  clientY: number,
) {
  const rect = surface.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    x: ((clientX - rect.left) / rect.width) * pageSize.width,
    y: ((clientY - rect.top) / rect.height) * pageSize.height,
  };
}

function RenderedPage({
  document,
  pageIndex,
  scale,
  generation,
  interactive = false,
  onNavigate,
  onOpenBrowserUrl,
  onRenderError,
  selectionMode = false,
  elements = [],
  selectedElement = null,
  onSelectElement,
  renderSurfaceRef,
}: RenderedPageProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const internalMountRef = useRef<HTMLDivElement | null>(null);
  const mountRef = renderSurfaceRef ?? internalMountRef;
  const textSelectionEnabled = selectionMode && Boolean(selectedElement?.text?.trim());

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }
    // Scrollbars of the slide's inner overflow:hidden containers are globally hidden,
    // yet native behaviors (selection-drag autoscroll, link-focus scrollIntoView) still
    // scroll them, silently shifting content with no way to drag back. scroll does not
    // bubble, so a capture listener resets any internal offset.
    const resetScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.scrollTop !== 0 || target.scrollLeft !== 0)) {
        target.scrollTop = 0;
        target.scrollLeft = 0;
      }
    };
    frame.addEventListener("scroll", resetScroll, true);
    return () => frame.removeEventListener("scroll", resetScroll, true);
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return;
    }

    let handle: PresentationRenderHandle | null = null;
    let disposeLinkSafety: (() => void) | undefined;
    let cancelled = false;
    const reportRenderError = (error: unknown) => {
      if (cancelled) {
        return;
      }
      onRenderError?.(generation, error instanceof Error ? error : new Error(String(error)));
    };
    try {
      handle = document.renderPage(pageIndex, mount, {
        onNavigate: (target) => {
          if (target.pageIndex !== undefined) {
            onNavigate?.(target.pageIndex);
            return;
          }
          const safeUrl = sanitizeDocumentHref(target.url);
          if (safeUrl && !safeUrl.startsWith("#")) {
            onOpenBrowserUrl?.(safeUrl);
          }
        },
      });
      // The PPTX renderer writes OOXML external links as plain <a href>; sanitize and
      // intercept navigation at the page mount point, covering asynchronously added
      // anchors too.
      disposeLinkSafety = installDocumentLinkSafety(mount, onOpenBrowserUrl);
      void handle.ready.catch(reportRenderError);
    } catch (error) {
      reportRenderError(error);
    }

    return () => {
      // dispose() does not guarantee the ready promise settles in sync; cancel callbacks first so late errors from an unmounted page cannot leak into the next session.
      cancelled = true;
      disposeLinkSafety?.();
      handle?.dispose();
      mount.replaceChildren();
    };
  }, [document, generation, onNavigate, onOpenBrowserUrl, onRenderError, pageIndex]);

  return (
    <div
      ref={frameRef}
      className="relative shrink-0 overflow-hidden bg-background shadow-md"
      style={{
        width: document.pageSize.width * scale,
        height: document.pageSize.height * scale,
      }}
    >
      {/* The renderer mount ref used to bind both this React container and the inner
          node; cleanup's replaceChildren() deleted the selection overlay and React's
          removeChild then crashed on a missing node. The renderer may only touch the
          dedicated leaf mount below, which holds no React children. */}
      <div
        data-zcode-pptx-render-surface=""
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: document.pageSize.width,
          height: document.pageSize.height,
          transform: `scale(${scale})`,
        }}
      >
        <div
          ref={mountRef}
          data-zcode-pptx-render-surface="true"
          className={cn(
            "absolute inset-0",
            interactive && (!selectionMode || textSelectionEnabled)
              ? "pointer-events-auto"
              : "pointer-events-none",
            textSelectionEnabled && "select-text",
          )}
          onPointerDownCapture={(event) => {
            if (!textSelectionEnabled) {
              return;
            }
            const point = toPresentationPoint(
              event.currentTarget,
              document.pageSize,
              event.clientX,
              event.clientY,
            );
            const hitElement = point ? hitTestPresentationElement(elements, point) : null;
            if (isSamePresentationElement(hitElement, selectedElement)) {
              return;
            }
            // The selection overlay covers the real text and the page below disables hit
            // testing, so the browser cannot create a native text selection. Once a
            // text-bearing element is highlighted, pass through only its bounds; outside,
            // the stable element model keeps handling selection so underlying links stay
            // closed.
            event.preventDefault();
            event.stopPropagation();
            if (hitElement) {
              onSelectElement?.(hitElement);
            }
          }}
          onClickCapture={(event) => {
            if (!selectionMode) {
              return;
            }
            // The click ending a text selection must not re-trigger internal links; native selection completed during the pointer sequence.
            event.preventDefault();
            event.stopPropagation();
          }}
        />
        {selectionMode ? (
          <div
            className="pointer-events-none absolute inset-0"
            data-pptx-element-selection-overlay="true"
          >
            {elements.map((element) => {
              const elementKey = [
                element.nodeId,
                element.nodeType,
                element.rowIndex ?? "",
                element.cellIndex ?? "",
              ].join(":");
              const selected = isSamePresentationElement(selectedElement, element);
              const elementButton = (
                <button
                  key={elementKey}
                  type="button"
                  aria-pressed={selected}
                  aria-label={element.text || element.nodeName || element.nodeType}
                  className={cn(
                    "absolute border outline-none transition-colors",
                    textSelectionEnabled ? "pointer-events-none" : "pointer-events-auto",
                    selected
                      ? "border-primary bg-accent/30"
                      : "border-transparent bg-transparent hover:border-primary hover:bg-accent/20",
                  )}
                  style={{
                    left: element.bounds.x,
                    top: element.bounds.y,
                    width: element.bounds.width,
                    height: element.bounds.height,
                    zIndex: element.zIndex * 2 + (element.nodeType === "table-cell" ? 1 : 0),
                  }}
                  onClick={() => onSelectElement?.(element)}
                />
              );
              return selected ? (
                <PopoverAnchor key={`anchor:${elementKey}`} asChild>
                  {elementButton}
                </PopoverAnchor>
              ) : (
                elementButton
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface ThumbnailProps {
  document: PresentationPreviewDocument;
  pageIndex: number;
  generation: number;
  selected: boolean;
  scrollRoot: HTMLElement | null;
  labels: PptxPreviewViewerLabels;
  onSelect: () => void;
}

function PptxThumbnail({
  document,
  pageIndex,
  generation,
  selected,
  scrollRoot,
  labels,
  onSelect,
}: ThumbnailProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const button = buttonRef.current;
    if (!button || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { root: scrollRoot, rootMargin: "200px 0px" },
    );
    observer.observe(button);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) {
      return;
    }
    const updateWidth = () => setWidth(Math.max(0, button.clientWidth - 16));
    updateWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(button);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (selected) {
      buttonRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  const scale = width > 0 ? width / document.pageSize.width : 0;
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-current={selected ? "page" : undefined}
      aria-label={labels.thumbnail(pageIndex + 1)}
      className={cn(
        "flex w-full flex-col items-center gap-1 rounded-lg border p-2 text-ui-xs text-foreground-subtle outline-none transition-colors",
        selected
          ? "border-border-hover bg-selected text-foreground"
          : "border-transparent hover:border-border hover:bg-surface-hover",
      )}
      onClick={onSelect}
    >
      <div
        className="flex w-full items-center justify-center overflow-hidden bg-surface"
        style={{
          aspectRatio: `${document.pageSize.width} / ${document.pageSize.height}`,
        }}
      >
        {visible && scale > 0 ? (
          <RenderedPage
            document={document}
            generation={generation}
            pageIndex={pageIndex}
            scale={scale}
          />
        ) : null}
      </div>
      <span className="tabular-nums">{pageIndex + 1}</span>
    </button>
  );
}

function useElementSize(node: HTMLElement | null) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!node) {
      return;
    }
    const update = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return size;
}

export function PptxPreviewViewer({
  data,
  labels,
  onOpenBrowserUrl,
  className,
  fileName,
  referenceSource,
  referenceNavigation,
  referenceNavigationReady = true,
}: {
  data: ArrayBuffer;
  labels: PptxPreviewViewerLabels;
  onOpenBrowserUrl?: (url: string) => void;
  className?: string;
  fileName?: string;
  referenceSource?: PptxElementReferenceSource;
  referenceNavigation?: PptxReferencePreviewNavigation;
  referenceNavigationReady?: boolean;
}) {
  const [presentation, setPresentation] = useState<{
    generation: number;
    document: PresentationPreviewDocument;
    sourceFingerprint: string;
  } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [zoomPercent, setZoomPercent] = useState(100);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [thumbnailRoot, setThumbnailRoot] = useState<HTMLElement | null>(null);
  const [previewViewport, setPreviewViewport] = useState<HTMLElement | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedElement, setSelectedElement] = useState<PresentationPageElement | null>(null);
  const [aiEditDraft, setAiEditDraft] = useState<{
    selectedText?: string;
  } | null>(null);
  const [addingReference, setAddingReference] = useState(false);
  const viewportSize = useElementSize(previewViewport);
  const generationRef = useRef(0);
  const platform = useOptionalPlatform();
  const canExportPdf = Boolean(platform?.printPageToPdf && platform?.saveFile);
  const appliedReferenceNavigationRequestIdRef = useRef<string | null>(null);
  const mainRenderSurfaceRef = useRef<HTMLDivElement | null>(null);
  const document = presentation?.document ?? null;
  const documentGeneration = presentation?.generation ?? 0;

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let cancelled = false;
    let openedDocument: PresentationPreviewDocument | null = null;
    setPresentation(null);
    setLoadError(false);
    setPageNumber(1);
    setPageInput("1");
    setZoomPercent(100);
    setSelectionMode(false);
    setSelectedElement(null);
    setAiEditDraft(null);
    setAddingReference(false);

    void sha256Fingerprint(data)
      .then((sourceFingerprint) =>
        import("@/presentation/pptxRendererPreviewEngine.js")
          .then(({ pptxRendererPreviewEngine }) => pptxRendererPreviewEngine.open(data))
          .then((nextDocument) => ({ nextDocument, sourceFingerprint })),
      )
      .then(({ nextDocument, sourceFingerprint }) => {
        openedDocument = nextDocument;
        if (cancelled || generation !== generationRef.current) {
          nextDocument.dispose();
          return;
        }
        setPresentation({
          generation,
          document: nextDocument,
          sourceFingerprint,
        });
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== generationRef.current) {
          return;
        }
        logger.error("[PptxPreviewViewer] Failed to parse PPTX", error);
        setLoadError(true);
      });

    return () => {
      // open()'s promise is not cancelled by effect cleanup; the generation counter lets late results from an old session only release resources, never mutate the new session.
      cancelled = true;
      if (generation === generationRef.current) {
        generationRef.current += 1;
      }
      openedDocument?.dispose();
    };
  }, [data]);

  const goToPage = useCallback(
    (target: number) => {
      if (!document || document.pageCount === 0) {
        return;
      }
      const nextPage = clampPresentationPageNumber(target, document.pageCount);
      setPageNumber(nextPage);
      setPageInput(String(nextPage));
    },
    [document],
  );

  const commitPageInput = useCallback(() => {
    const parsed = Number.parseInt(pageInput.trim(), 10);
    if (Number.isNaN(parsed)) {
      setPageInput(String(pageNumber));
      return;
    }
    goToPage(parsed);
  }, [goToPage, pageInput, pageNumber]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // The comment draft's textarea renders via a popover portal but still bubbles
      // here through the React tree; exempting only INPUT would page prev/next while
      // typing and wipe the unsaved comment.
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }
      if (event.key === "Escape" && selectionMode) {
        event.preventDefault();
        if (aiEditDraft) {
          // While editing a comment, Esc only returns to the AI edit bar so a stray press cannot wipe typed text.
          setAiEditDraft(null);
          return;
        }
        setSelectionMode(false);
        setSelectedElement(null);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToPage(pageNumber - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goToPage(pageNumber + 1);
      }
    },
    [aiEditDraft, goToPage, pageNumber, selectionMode],
  );

  const exitElementSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedElement(null);
    setAiEditDraft(null);
  }, []);

  const mainScale = useMemo(() => {
    if (!document || viewportSize.width === 0 || viewportSize.height === 0) {
      return 1;
    }
    const fitScale = Math.min(
      Math.max(1, viewportSize.width - 32) / document.pageSize.width,
      Math.max(1, viewportSize.height - 32) / document.pageSize.height,
    );
    return fitScale * (zoomPercent / 100);
  }, [document, viewportSize.height, viewportSize.width, zoomPercent]);

  const handleRenderError = useCallback((generation: number, error: Error) => {
    if (generation !== generationRef.current) {
      return;
    }
    logger.error("[PptxPreviewViewer] Failed to render PPTX page", error);
    setLoadError(true);
  }, []);
  const handlePageNavigate = useCallback(
    (targetPageIndex: number) => goToPage(targetPageIndex + 1),
    [goToPage],
  );
  useEffect(() => {
    if (!referenceNavigation) {
      return;
    }
    // Reference jumps originate in the composer; a stale selection overlay would suggest
    // the element selection revived along with the page. Close the generation-local
    // selection first, then attempt page anchoring once the file check and document parse
    // settle.
    setSelectionMode(false);
    setSelectedElement(null);
    setAiEditDraft(null);
    if (
      !referenceNavigationReady ||
      !document ||
      appliedReferenceNavigationRequestIdRef.current === referenceNavigation.requestId
    ) {
      return;
    }
    appliedReferenceNavigationRequestIdRef.current = referenceNavigation.requestId;
    const referencedPageNumber = referenceNavigation.pageIndex + 1;
    if (
      !Number.isInteger(referenceNavigation.pageIndex) ||
      referenceNavigation.pageIndex < 0 ||
      referenceNavigation.pageIndex >= document.pageCount
    ) {
      toast(labels.referencedPageMissing(referencedPageNumber));
      return;
    }
    goToPage(referencedPageNumber);
    if (presentation?.sourceFingerprint !== referenceNavigation.expectedSourceFingerprint) {
      toast(labels.referencedSourceChanged(referencedPageNumber));
    }
  }, [
    document,
    goToPage,
    labels,
    presentation?.sourceFingerprint,
    referenceNavigation,
    referenceNavigationReady,
  ]);
  useEffect(() => {
    setSelectedElement(null);
    setAiEditDraft(null);
  }, [documentGeneration, pageNumber]);

  const pageElements = useMemo(
    () => (document && selectionMode ? document.getPageElements(pageNumber - 1) : []),
    [document, pageNumber, selectionMode],
  );
  const handleAiEdit = useCallback(() => {
    if (!selectedElement || !presentation || !referenceSource || addingReference) {
      return;
    }
    const renderSurface = mainRenderSurfaceRef.current;
    const selectedText = getPresentationElementSelectedText({
      selection: renderSurface?.ownerDocument.defaultView?.getSelection() ?? null,
      renderSurface,
      pageSize: presentation.document.pageSize,
      elementBounds: selectedElement.bounds,
      elementText: selectedElement.text,
    });
    setAiEditDraft(selectedText ? { selectedText } : {});
  }, [addingReference, presentation, referenceSource, selectedElement]);

  const handleSelectElement = useCallback((element: PresentationPageElement) => {
    setAiEditDraft(null);
    setSelectedElement(element);
  }, []);

  const handleAddToConversation = useCallback(
    (comment: string) => {
      if (
        !selectedElement ||
        !presentation ||
        !referenceSource ||
        !aiEditDraft ||
        addingReference
      ) {
        return;
      }
      const normalizedComment = comment.trim();
      const referenceGeneration = generationRef.current;
      setAddingReference(true);
      // Partial text selections used to cover the full element.text, locking the
      // textFingerprint to a substring while the OOXML resolver validates the whole
      // shape/cell. Full text is for conflict checks; the substring is model context only.
      void createPptxElementReference({
        element: selectedElement,
        ...aiEditDraft,
        ...(normalizedComment ? { comment: normalizedComment } : {}),
        ...referenceSource,
        sourceFingerprint: presentation.sourceFingerprint,
      })
        .then((reference) => {
          if (referenceGeneration !== generationRef.current) {
            return;
          }
          dispatchPptxElementReferenceAddToChat(reference);
          setAiEditDraft(null);
        })
        .catch((error: unknown) => {
          if (referenceGeneration === generationRef.current) {
            logger.error("[PptxPreviewViewer] Failed to create PPTX element reference", error);
          }
        })
        .finally(() => {
          if (referenceGeneration === generationRef.current) {
            setAddingReference(false);
          }
        });
    },
    [addingReference, aiEditDraft, presentation, referenceSource, selectedElement],
  );

  const suggestedPdfName = useMemo(() => {
    const base = fileName?.split(/[\\/]/).pop()?.trim();
    if (!base) {
      return "presentation.pdf";
    }
    const pptExtension = /\.(pptx?|ppsx?)$/i;
    return pptExtension.test(base) ? base.replace(pptExtension, ".pdf") : `${base}.pdf`;
  }, [fileName]);

  const handleExportPdf = useCallback(async () => {
    const printPageToPdf = platform?.printPageToPdf;
    const saveFile = platform?.saveFile;
    if (!document || exportingPdf || !printPageToPdf || !saveFile) {
      return;
    }
    setExportingPdf(true);
    let printHost: PresentationPrintHost | null = null;
    try {
      const { renderPresentationToPrintHost } =
        await import("@/presentation/presentationPdfPrintExport.js");
      printHost = await renderPresentationToPrintHost(document, window.document);
      const printResult = await printPageToPdf();
      // Release the print DOM as soon as the PDF bytes arrive; the save dialog must not pin every page in memory
      printHost.dispose();
      printHost = null;
      if (!printResult.success || !printResult.data) {
        throw new Error(printResult.error ?? "print_failed");
      }
      const saveResult = await saveFile({
        data: printResult.data,
        suggestedName: suggestedPdfName,
      });
      if (saveResult.canceled) {
        return;
      }
      if (!saveResult.success || !saveResult.path) {
        throw new Error(saveResult.error ?? "save_failed");
      }
      toast(labels.exportPdfSuccess(saveResult.path));
    } catch (error) {
      logger.error("[PptxPreviewViewer] Failed to export PPTX to PDF", error);
      toast(labels.exportPdfFailed);
    } finally {
      printHost?.dispose();
      setExportingPdf(false);
    }
  }, [document, exportingPdf, labels, platform, suggestedPdfName]);

  if (loadError) {
    return <div className="p-3 text-ui-base text-destructive">{labels.loadError}</div>;
  }
  if (!document) {
    return <div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>;
  }
  if (document.pageCount === 0) {
    return <div className="p-3 text-ui-base text-foreground-subtle">{labels.noSlides}</div>;
  }

  const pageIndex = pageNumber - 1;
  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={cn("flex h-full min-h-0 outline-none", className)}
    >
      <aside
        ref={setThumbnailRoot}
        aria-label={labels.thumbnails}
        className="w-24 shrink-0 overflow-y-auto border-r border-border bg-surface/30 p-2 sm:w-32"
      >
        <div className="flex flex-col gap-2">
          {Array.from({ length: document.pageCount }, (_, index) => (
            <PptxThumbnail
              key={index}
              document={document}
              generation={documentGeneration}
              pageIndex={index}
              selected={index === pageIndex}
              scrollRoot={thumbnailRoot}
              labels={labels}
              onSelect={() => goToPage(index + 1)}
            />
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <div ref={setPreviewViewport} className="min-h-0 flex-1 overflow-auto">
          <div className="grid min-h-full min-w-full place-items-center p-4">
            <PptxSelectionActionBar
              open={selectionMode && selectedElement !== null}
              boundary={previewViewport}
              label={labels.aiEdit}
              commentPlaceholder={labels.commentPlaceholder}
              cancelLabel={labels.cancelAiEdit}
              addToConversationLabel={labels.addToConversation}
              editing={aiEditDraft !== null}
              disabled={addingReference}
              onAiEdit={handleAiEdit}
              onCancelAiEdit={() => setAiEditDraft(null)}
              onAddToConversation={handleAddToConversation}
              onExitSelection={exitElementSelection}
            >
              <RenderedPage
                document={document}
                generation={documentGeneration}
                pageIndex={pageIndex}
                scale={mainScale}
                interactive
                selectionMode={selectionMode}
                elements={pageElements}
                selectedElement={selectedElement}
                onSelectElement={handleSelectElement}
                renderSurfaceRef={mainRenderSurfaceRef}
                onNavigate={handlePageNavigate}
                onOpenBrowserUrl={onOpenBrowserUrl}
                onRenderError={handleRenderError}
              />
            </PptxSelectionActionBar>
          </div>
        </div>

        <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-center gap-1 border-t border-border bg-surface/30 px-2 py-1.5 text-ui-base">
          {referenceSource ? (
            <Button
              type="button"
              size="sm"
              variant={selectionMode ? "secondary" : "ghost"}
              aria-pressed={selectionMode}
              aria-label={selectionMode ? labels.exitElementSelection : labels.selectElement}
              title={selectionMode ? labels.exitElementSelection : labels.selectElement}
              onClick={() => {
                setSelectionMode((current) => !current);
                setSelectedElement(null);
                setAiEditDraft(null);
              }}
            >
              <MousePointer2Icon className="size-4" />
              {selectionMode ? labels.exitElementSelection : labels.selectElement}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={labels.previousPage}
            title={labels.previousPage}
            disabled={pageNumber <= 1}
            onClick={() => goToPage(pageNumber - 1)}
          >
            <ChevronLeftIcon />
          </Button>
          <Input
            type="text"
            inputMode="numeric"
            aria-label={labels.pageInput}
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={commitPageInput}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitPageInput();
                event.currentTarget.blur();
              }
            }}
            className="w-12 text-center text-mobile-input-safe tabular-nums md:text-ui-base"
          />
          <span className="min-w-10 text-center tabular-nums text-foreground-subtle">
            / {document.pageCount}
          </span>
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={labels.nextPage}
            title={labels.nextPage}
            disabled={pageNumber >= document.pageCount}
            onClick={() => goToPage(pageNumber + 1)}
          >
            <ChevronRightIcon />
          </Button>
          <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={labels.zoomOut}
            title={labels.zoomOut}
            disabled={zoomPercent <= PPTX_MIN_ZOOM_PERCENT}
            onClick={() =>
              setZoomPercent((current) =>
                clampPresentationZoomPercent(current - PPTX_ZOOM_STEP_PERCENT),
              )
            }
          >
            <ZoomOutIcon />
          </Button>
          <span className="w-12 text-center tabular-nums text-foreground-subtle">
            {zoomPercent}%
          </span>
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={labels.zoomIn}
            title={labels.zoomIn}
            disabled={zoomPercent >= PPTX_MAX_ZOOM_PERCENT}
            onClick={() =>
              setZoomPercent((current) =>
                clampPresentationZoomPercent(current + PPTX_ZOOM_STEP_PERCENT),
              )
            }
          >
            <ZoomInIcon />
          </Button>
          {canExportPdf ? (
            <>
              <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
              <Button
                type="button"
                size="icon-md"
                variant="ghost"
                aria-label={exportingPdf ? labels.exportingPdf : labels.exportPdf}
                title={exportingPdf ? labels.exportingPdf : labels.exportPdf}
                disabled={exportingPdf}
                onClick={() => void handleExportPdf()}
              >
                {exportingPdf ? <Loader2Icon className="animate-spin" /> : <FileDownIcon />}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
