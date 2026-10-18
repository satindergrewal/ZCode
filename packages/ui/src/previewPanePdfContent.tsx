import { Suspense, lazy } from "react";
import type { PdfViewerLabels, PdfViewerSource } from "@/components/ui/pdf-viewer.js";

// react-pdf (pdf.js plus worker) is heavy; lazy-loading keeps it out of the bundle until the
// first PDF preview so sessions without PDFs do not pay for it at startup.
const PdfViewer = lazy(() =>
  import("@/components/ui/pdf-viewer.js").then((module) => ({
    default: module.PdfViewer,
  })),
);

interface PdfPreviewContentProps {
  source: PdfViewerSource;
  labels: PdfViewerLabels;
}

export function PdfPreviewContent({ source, labels }: PdfPreviewContentProps) {
  return (
    <Suspense
      fallback={<div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>}
    >
      <PdfViewer source={source} labels={labels} className="h-full" />
    </Suspense>
  );
}
