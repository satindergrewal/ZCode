export type OfficeFilePreviewKind = "excel" | "docx" | "doc";

export interface DocxPreviewFit {
  scale: number;
  width: number;
  height: number;
}

const EXCEL_FILE_EXTENSIONS = [".xlsx", ".xlsm", ".xls"] as const;
const DOCX_FILE_EXTENSIONS = [".docx"] as const;
const LEGACY_DOC_FILE_EXTENSIONS = [".doc"] as const;

export function getOfficeFilePreviewKind(path?: string): OfficeFilePreviewKind | null {
  if (!path) {
    return null;
  }

  const normalizedPath = path.trim().toLowerCase();
  if (DOCX_FILE_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension))) {
    return "docx";
  }
  if (LEGACY_DOC_FILE_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension))) {
    return "doc";
  }
  if (EXCEL_FILE_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension))) {
    return "excel";
  }
  return null;
}

export function calculateDocxPreviewFit({
  availableWidth,
  naturalHeight,
  naturalWidth,
}: {
  availableWidth: number;
  naturalHeight: number;
  naturalWidth: number;
}): DocxPreviewFit | null {
  if (
    !Number.isFinite(availableWidth) ||
    !Number.isFinite(naturalHeight) ||
    !Number.isFinite(naturalWidth) ||
    availableWidth <= 0 ||
    naturalHeight <= 0 ||
    naturalWidth <= 0
  ) {
    return null;
  }

  const scale = Math.min(1, availableWidth / naturalWidth);
  return {
    scale,
    width: naturalWidth * scale,
    height: naturalHeight * scale,
  };
}

export function decodeBase64ToArrayBuffer(dataBase64: string): ArrayBuffer {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

/**
 * Document content comes from untrusted OOXML relationships; never hand the Target to the
 * DOM as-is. Only plain web links and in-document anchors are allowed; every other protocol
 * degrades to non-clickable text.
 */
export function sanitizeDocumentHref(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const href = value.trim();
  if (!href) {
    return null;
  }

  // Control characters can disguise `java\nscript:` as a plausible-looking scheme; reject
  // up front instead of repairing. Char-by-char checks avoid no-control-regex lint warnings
  // from a hand-rolled safety regex.
  for (const character of href) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return null;
    }
  }

  if (href.startsWith("#")) {
    return href.length > 1 && !/[\s<>"']/u.test(href) ? href : null;
  }

  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/iu)?.[1]?.toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return null;
  }

  try {
    const parsed = new URL(href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

/**
 * Post-DOM-write safety pass in the renderer, covering HTML/SVG hyperlinks produced by the parser.
 */
const DOCUMENT_LINK_SELECTOR = "a[href], a[xlink\\:href]";

function sanitizeDocumentLinkElement(element: Element): void {
  for (const attribute of ["href", "xlink:href"] as const) {
    const value = element.getAttribute(attribute);
    if (value === null) {
      continue;
    }

    const safeHref = sanitizeDocumentHref(value);
    if (safeHref === null) {
      element.removeAttribute(attribute);
      if (element instanceof HTMLElement && element.tagName === "A") {
        element.setAttribute("aria-disabled", "true");
      }
      continue;
    }

    if (safeHref !== value) {
      element.setAttribute(attribute, safeHref);
    }
  }
}

export function sanitizeDocumentLinks(root: ParentNode): void {
  if (root instanceof Element && root.matches(DOCUMENT_LINK_SELECTOR)) {
    sanitizeDocumentLinkElement(root);
  }
  root.querySelectorAll(DOCUMENT_LINK_SELECTOR).forEach(sanitizeDocumentLinkElement);
}

/** Installs shared DOM sanitization and click interception for every Office renderer; returns the teardown. */
export function installDocumentLinkSafety(
  root: HTMLElement,
  onOpenBrowserUrl?: (url: string) => void,
): () => void {
  const handleClick = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (!target) {
      return;
    }

    const safeHref = sanitizeDocumentHref(
      target.getAttribute("href") ?? target.getAttribute("xlink:href"),
    );
    if (safeHref === null) {
      event.preventDefault();
      return;
    }
    if (safeHref.startsWith("#")) {
      return;
    }

    // External document links must not navigate the main renderer; route them through the
    // controlled Browser/external-browser entry points.
    event.preventDefault();
    onOpenBrowserUrl?.(safeHref);
  };

  sanitizeDocumentLinks(root);
  root.addEventListener("click", handleClick);
  const observer =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          const addedRoots = new Set<ParentNode>();
          for (const record of records) {
            if (record.type === "attributes" && record.target instanceof Element) {
              sanitizeDocumentLinkElement(record.target);
              continue;
            }
            for (const addedNode of record.addedNodes) {
              if (addedNode instanceof Element || addedNode instanceof DocumentFragment) {
                addedRoots.add(addedNode);
              }
            }
          }
          // Batched or virtualized remounts in third-party renderers used to rescan the
          // whole preview DOM per mutation batch, repeating O(whole-tree) scans on large
          // documents. Scan only the actually added subtrees.
          addedRoots.forEach(sanitizeDocumentLinks);
        });
  observer?.observe(root, {
    attributeFilter: ["href", "xlink:href"],
    attributes: true,
    childList: true,
    subtree: true,
  });

  return () => {
    observer?.disconnect();
    root.removeEventListener("click", handleClick);
  };
}
