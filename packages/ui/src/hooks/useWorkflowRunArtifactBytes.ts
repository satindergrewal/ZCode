import { useEffect, useMemo, useRef, useState } from "react";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * Byte reading for content artifacts (`file` / `markdown`).
 *
 * Follows the `attachmentRead` chunking idiom verbatim: one chunk <= 512 KiB, done when
 * `nextOffset` is null. The cap for assembling the full payload in memory is
 * `ARTIFACT_CAPS.maxFileBytes` (= 20 MiB, same class as attachments). At that scale a single
 * Blob is far simpler than per-viewer range reads -- the viewers are existing leaf components
 * that want a Blob / ArrayBuffer, not a cursor.
 *
 * ```
 * offset 0 ──read──▶ {dataBase64, mediaType, totalBytes, nextOffset}
 *        ◀──────────  decode to Uint8Array, push into chunks[]
 *   nextOffset ──read──▶ …  until null
 *        ▼
 *   concat into one Uint8Array ─▶ Blob ─▶ objectUrl (revoked on unmount / version change)
 * ```
 */

/** Bytes per chunk. Reuse the attachment constant rather than minting a new one -- the gateway cap is exactly it. */
const CHUNK_BYTES = PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes;

/**
 * Max chunks read per artifact. 20 MiB / 512 KiB = 40 chunks; double headroom acts as the
 * infinite-loop brake: an implementation that never converges `nextOffset` to null must not
 * lock up the renderer thread.
 */
const MAX_CHUNKS = 96;

interface WorkflowRunArtifactBytesState {
  bytes: Uint8Array<ArrayBuffer> | null;
  blob: Blob | null;
  /** Object URL of the Blob; consumed by `<img src>` / PdfViewer. Revoked on unload and version change. */
  objectUrl: string | null;
  /** contentType from the journal record (not re-sniffed by the store) -- the exact-match contract renderer dispatch relies on. */
  mediaType: string | null;
  totalBytes: number | null;
  loading: boolean;
  error: string | null;
  /**
   * `bytes` 属于哪一版。换版本后、effect 清空旧状态之前有一帧 `version` 已是新值而 `bytes`
   * 还是旧版的；查看器闪一帧无妨，但「作为文件打开」的副本只写一次，拿错字节就永久错了——
   * 这类消费方必须核对它，而不是信任「当前渲染的 version」。
   */
  bytesVersion: number | null;
}

function emptyState(): WorkflowRunArtifactBytesState {
  return {
    bytes: null,
    blob: null,
    objectUrl: null,
    mediaType: null,
    totalBytes: null,
    loading: false,
    error: null,
    bytesVersion: null,
  };
}

/** base64 -> bytes. `atob` is always present in the renderer (Electron and browser are both Chromium). */
function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * bytes -> base64. The office viewers only accept `FileBinaryPreview.dataBase64`, so the
 * return path is required.
 *
 * Chunked (8 KiB) instead of `String.fromCharCode(...bytes)`: the spread would explode 20 MiB
 * into 20 million arguments and die with "Maximum call stack size exceeded".
 */
export function encodeBytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  const step = 0x2000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

export function useWorkflowRunArtifactBytes(options: {
  sessionId: string;
  runId: string;
  artifactId: string;
  version: number;
  /** When off, nothing is read and no object URL is left behind (preset boards and collapsed states skip the whole pipeline). */
  enabled?: boolean;
}): WorkflowRunArtifactBytesState {
  const { workflowRunArtifactRead } = useV4Conversation();
  const [state, setState] = useState<WorkflowRunArtifactBytesState>(emptyState);
  // Issued object URLs must be revoked on unmount and version change, or every version flip
  // leaks another 20 MiB.
  const objectUrlRef = useRef<string | null>(null);

  const { artifactId, runId, sessionId, version } = options;
  const enabled =
    options.enabled !== false &&
    sessionId.length > 0 &&
    runId.length > 0 &&
    artifactId.length > 0 &&
    version > 0;

  useEffect(() => {
    const revokePrevious = () => {
      if (objectUrlRef.current !== null) {
        if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        objectUrlRef.current = null;
      }
    };
    revokePrevious();
    setState(emptyState());
    if (!enabled) return;

    let alive = true;
    setState((current) => ({ ...current, loading: true }));
    void (async () => {
      try {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let offset = 0;
        let mediaType = "application/octet-stream";
        let totalBytes = 0;
        for (let index = 0; index < MAX_CHUNKS; index += 1) {
          const result = await workflowRunArtifactRead({
            sessionId,
            runId,
            artifactId,
            version,
            offset,
            limit: CHUNK_BYTES,
          });
          if (!alive) return;
          mediaType = result.mediaType;
          totalBytes = result.totalBytes;
          chunks.push(decodeBase64(result.dataBase64));
          if (result.nextOffset === null) break;
          offset = result.nextOffset;
        }
        if (!alive) return;
        const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const bytes = new Uint8Array(size);
        let cursor = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, cursor);
          cursor += chunk.length;
        }
        const blob = new Blob([bytes], { type: mediaType });
        // jsdom has no createObjectURL: a missing URL is not an error, just the `<img>` path
        // being unavailable. The Blob/bytes routes still work (PdfViewer and the office
        // viewers consume those).
        const objectUrl =
          typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(blob)
            : null;
        objectUrlRef.current = objectUrl;
        setState({
          bytes,
          blob,
          objectUrl,
          mediaType,
          totalBytes,
          loading: false,
          error: null,
          bytesVersion: version,
        });
      } catch (caught) {
        if (!alive) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.warn("[workflow-artifacts] Failed to read artifact bytes", {
          artifactId,
          error: message,
          runId,
          sessionId,
          version,
        });
        setState({ ...emptyState(), error: message });
      }
    })();

    return () => {
      alive = false;
      revokePrevious();
    };
  }, [artifactId, enabled, runId, sessionId, version, workflowRunArtifactRead]);

  return useMemo(() => state, [state]);
}
