import { lazy, Suspense, useMemo } from "react";
import type { FileBinaryPreview } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildPresetLabels,
  isArtifactPresetKind,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { ArtifactPresetBody } from "@/app-shell/workflow-artifacts/ArtifactPresetBody.js";
import {
  ArtifactMetadataCard,
  ArtifactNotice,
  WorkflowArtifactHtmlCard,
} from "@/app-shell/workflow-artifacts/WorkflowArtifactCards.js";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/index.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";
import { encodeBytesToBase64 } from "@/hooks/useWorkflowRunArtifactBytes.js";
import { usePdfViewerLabels, usePptxViewerLabels } from "@/hooks/usePreviewViewerLabels.js";
import type { Theme } from "@/useTheme.js";

/**
 * Body of the workflow-artifact tab.
 *
 * Terminology: artifact = output the script publishes to the user via artifact.*.
 *
 * Zero new render dependencies: pdf/image/markdown/office/text all ride the existing leaf viewers and preset
 * boards use the four 4b renderers. Dispatch keys on the journal record's contentType, computed by the driver
 * from its extension table and overridable via opts.contentType; it is the only type truth on this path (the
 * store re-sniffs on read-back and that value is deliberately unused).
 *
 * Deliberately no iframes: the renderer has no CSP, and an allow-scripts allow-same-origin sandbox equals an
 * escape. html therefore uses the existing browser tab (see WorkflowArtifactHtmlCard).
 */

// All three heavyweight viewers lazy-load: pdf.js / docx-preview / the xlsx wasm are hundreds of KB each and
// most sessions never open the artifact tab. The existing previewPane* wrappers already carry Suspense.
const PdfPreviewContent = lazy(() =>
  import("@/previewPanePdfContent.js").then((module) => ({ default: module.PdfPreviewContent })),
);
const PptxPreviewContent = lazy(() =>
  import("@/previewPanePptxContent.js").then((module) => ({ default: module.PptxPreviewContent })),
);
const PreviewPaneOfficeContent = lazy(() =>
  import("@/previewPaneOfficeContent.js").then((module) => ({
    default: module.PreviewPaneOfficeContent,
  })),
);

const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Text-like types render in the monospace code viewer; text/markdown is not here, it goes through MessageResponse. */
function textLanguageFor(contentType: string): string | undefined {
  if (contentType === "application/json") return "json";
  if (contentType === "text/csv") return "csv";
  if (contentType === "text/plain") return "text";
  if (contentType.startsWith("text/")) return "text";
  return undefined;
}

interface WorkflowArtifactBodyProps {
  artifact: WorkflowRunArtifactView;
  /** The version being viewed; content-artifact bytes read against it. */
  version: number;
  bytes: Uint8Array<ArrayBuffer> | null;
  blob: Blob | null;
  objectUrl: string | null;
  /** Byte-read state: loading and error render here (each viewer's own loading only covers parsing). */
  loading: boolean;
  error: string | null;
  /** The preset board's entry stream; always empty for content artifacts. */
  items: readonly ArtifactItem[];
  theme: Theme;
  resolvedTheme: "light" | "dark";
  /** html's open-in-browser action; absent means the hint only. */
  onOpenBrowserUrl?: (url: string) => void;
  /** Absolute path on the local filesystem (only when desktop-local AND sourcePath present). */
  localSourcePath?: string;
  /** Reveal in workspace: file-tree reveal with path prebound; absent means no such button on renderer-less cards. */
  onReveal?: () => void;
  /** Whether this is the latest version; older versions' workspace originals were overwritten long ago, so html preview is latest-only. */
  isLatestVersion: boolean;
  /** Metadata (incl. the preset board spec) still loading; the preset body distinguishes not-yet from really-absent by it. */
  metadataLoading: boolean;
}

export function WorkflowArtifactBody(props: WorkflowArtifactBodyProps) {
  const { intl } = useZCodeIntl();
  const { artifact } = props;

  // Preset boards read no bytes; draw directly.
  if (isArtifactPresetKind(artifact.kind)) {
    const labels = buildPresetLabels((descriptor, values) =>
      intl.formatMessage(descriptor, values),
    );
    return (
      <div className="h-full min-h-0 overflow-auto p-4" data-artifact-body="preset">
        <ArtifactPresetBody
          artifact={artifact}
          items={props.items}
          labels={labels}
          invalidLabel={intl.formatMessage({
            id: "chat.toolCall.workflow.run.artifacts.presetInvalid",
          })}
          // Only the journal query returns the spec, so never claim unreadable before metadata finishes loading,
          // or every board flashes an error line on open.
          {...(props.metadataLoading
            ? {}
            : {
                missingLabel: intl.formatMessage({
                  id: "chat.toolCall.workflow.run.artifacts.unavailable",
                }),
              })}
        />
      </div>
    );
  }

  if (props.error !== null) {
    return (
      <ArtifactNotice
        testId="workflow-artifact-error"
        tone="error"
        text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loadError" })}
        detail={props.error}
      />
    );
  }
  if (props.loading || props.bytes === null) {
    return (
      <ArtifactNotice
        testId="workflow-artifact-loading"
        text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loading" })}
      />
    );
  }

  return <WorkflowArtifactContent {...props} bytes={props.bytes} />;
}

/**
 * Dispatch once bytes are ready. A second component because of hooks: markdown decoding and the office base64
 * round-trip need useMemo and must not be skipped on the no-bytes-yet frame (hook counts must stay constant).
 */
function WorkflowArtifactContent({
  artifact,
  bytes,
  blob,
  objectUrl,
  theme,
  resolvedTheme,
  onOpenBrowserUrl,
  onReveal,
  localSourcePath,
  isLatestVersion,
}: WorkflowArtifactBodyProps & { bytes: Uint8Array<ArrayBuffer> }) {
  const { intl } = useZCodeIntl();
  const pdfLabels = usePdfViewerLabels();
  const pptxLabels = usePptxViewerLabels();
  const contentType = artifact.contentType ?? "application/octet-stream";

  // The three text shapes (markdown / code / html source) share one decode. TextDecoder is always present in the renderer.
  const text = useMemo(() => {
    if (
      contentType !== "text/markdown" &&
      contentType !== "text/html" &&
      textLanguageFor(contentType) === undefined
    ) {
      return undefined;
    }
    return new TextDecoder().decode(bytes);
  }, [bytes, contentType]);

  // Office viewers only eat FileBinaryPreview.dataBase64, so pay one encoding round-trip here.
  // Compute only for actual office files; 20 MiB of base64 must not be computed for a pdf.
  const officePreview = useMemo<FileBinaryPreview | null>(() => {
    if (contentType !== DOCX_CONTENT_TYPE && contentType !== XLSX_CONTENT_TYPE) return null;
    return {
      path: artifact.sourcePath ?? artifact.id,
      dataBase64: encodeBytesToBase64(bytes),
      totalBytes: bytes.length,
    };
  }, [artifact.id, artifact.sourcePath, bytes, contentType]);

  // The pptx viewer eats ArrayBuffer. slice out an independent buffer: a Uint8Array's buffer may be offset.
  const pptxBuffer = useMemo(
    () =>
      contentType === PPTX_CONTENT_TYPE
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : null,
    [bytes, contentType],
  );

  if (contentType === "text/markdown") {
    return (
      // markdown must receive theme: portfolio fixed dark-bg dark-text once (the renderer picks code colors from theme).
      <div className="h-full min-h-0 overflow-y-auto px-4 py-4" data-artifact-body="markdown">
        <MessageResponse
          className="mx-auto w-full min-w-0 max-w-4xl break-words text-foreground"
          theme={theme}
        >
          {text ?? ""}
        </MessageResponse>
      </div>
    );
  }

  if (contentType === "application/pdf") {
    return (
      <div className="h-full min-h-0" data-artifact-body="pdf">
        <Suspense fallback={<ArtifactNotice text={pdfLabels.loading} />}>
          {/* PdfViewerSource takes a Blob; no need to materialize a file or use the range transport. */}
          <PdfPreviewContent labels={pdfLabels} source={blob ?? new Blob([bytes])} />
        </Suspense>
      </div>
    );
  }

  if (contentType.startsWith("image/")) {
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background-alt p-4"
        data-artifact-body="image"
      >
        {objectUrl === null ? (
          <ArtifactNotice
            text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loadError" })}
            tone="error"
          />
        ) : (
          <img
            alt={artifact.title ?? artifact.id}
            className="max-h-full max-w-full object-contain"
            data-testid="workflow-artifact-image"
            src={objectUrl}
          />
        )}
      </div>
    );
  }

  if (contentType === PPTX_CONTENT_TYPE && pptxBuffer !== null) {
    return (
      <div className="h-full min-h-0" data-artifact-body="pptx">
        <Suspense fallback={<ArtifactNotice text={pptxLabels.loading} />}>
          <PptxPreviewContent
            data={pptxBuffer}
            fileName={artifact.sourcePath ?? artifact.id}
            labels={pptxLabels}
            {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          />
        </Suspense>
      </div>
    );
  }

  if (officePreview !== null) {
    return (
      <div className="h-full min-h-0" data-artifact-body="office">
        <Suspense fallback={<ArtifactNotice text={pdfLabels.loading} />}>
          <PreviewPaneOfficeContent
            error={null}
            kind={contentType === XLSX_CONTENT_TYPE ? "excel" : "docx"}
            loading={false}
            preview={officePreview}
            resolvedTheme={resolvedTheme}
            sourcePath={artifact.sourcePath ?? artifact.id}
            {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          />
        </Suspense>
      </div>
    );
  }

  if (contentType === "text/html") {
    return (
      <WorkflowArtifactHtmlCard
        artifact={artifact}
        bytes={bytes.length}
        isLatestVersion={isLatestVersion}
        {...(localSourcePath === undefined ? {} : { localSourcePath })}
        {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
        {...(onReveal === undefined ? {} : { onReveal })}
      />
    );
  }

  const language = textLanguageFor(contentType);
  if (language !== undefined && text !== undefined) {
    return (
      <div className="h-full min-h-0 overflow-auto" data-artifact-body="text">
        <CodeBlock appTheme={theme} code={text} language={language} showLineNumbers />
      </div>
    );
  }

  // Off-table types (application/octet-stream and anything unrecognized) get a metadata card,
  // without pretending to render. It carries reveal-in-workspace; open-in-app lives in the tab header's split button.
  return (
    <ArtifactMetadataCard
      artifact={artifact}
      bytes={bytes.length}
      note={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.unsupported" })}
      testId="workflow-artifact-unsupported"
      {...(onReveal === undefined
        ? {}
        : {
            action: {
              label: intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" }),
              onActivate: onReveal,
              testId: "workflow-artifact-unsupported-reveal",
            },
          })}
    />
  );
}
