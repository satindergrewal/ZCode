import { randomUUID } from "node:crypto";
import { HostResponseTypes } from "@zcode/shared";
import type {
  BrowserBackendDescriptor,
  BrowserClientMode,
  BrowserCommand,
  BrowserCommandResult,
  BrowserRecordingArtifact,
} from "@zcode/shared";

/**
 * host-main browser execution bridge. The host side sends one command to main over parentPort (executed via WebContentsView+CDP),
 * correlating the result by requestId. Mirrors the pending-map pattern of createFullFeedbackLogArchiveViaMain.
 *
 * Injectable postMessage and no globals, for easy unit testing with a fake parentPort.
 */

interface BrowserExecuteRequestMessage {
  type: typeof HostResponseTypes.BrowserExecuteRequest;
  requestId: string;
  browserId: string;
  browserGeneration: number;
  sessionId: string;
  turnId?: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode: BrowserClientMode;
  sessionContext: "live" | "cached";
  command: BrowserCommand;
}

interface BrowserExecuteResultMessage {
  requestId: string;
  result: BrowserCommandResult;
}

interface PendingEntry {
  resolve: (result: BrowserCommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
  method: BrowserCommand["method"];
  startedAt: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  outputPath?: string;
}

/**
 * host-to-main browser subcommand budget. The outer node_repl MCP tool allows 60s; keep 30s here, leaving headroom for JS
 * finalization, image normalization, and structured error returns; the two deadlines must not race.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

function mayHaveSideEffects(command: BrowserCommand): boolean {
  if (command.method === "playwright" && command.action.name === "locator") {
    return [
      "click",
      "dblclick",
      "downloadMedia",
      "fill",
      "press",
      "selectOption",
      "setChecked",
    ].includes(command.action.operation);
  }
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "recordingStart",
    "recordingCancel",
    "handleDialog",
    "close",
    "finalize",
    "newTab",
  ].includes(command.method);
}

interface BrowserControlMainBridge {
  list(): Promise<BrowserBackendDescriptor[]>;
  execute(input: {
    requestId?: string;
    browserId?: string;
    browserGeneration?: number;
    sessionId: string;
    turnId?: string;
    workspaceKey?: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode?: BrowserClientMode;
    sessionContext?: "live" | "cached";
    command: BrowserCommand;
  }): Promise<BrowserCommandResult>;
  /** Invoked by host message dispatch when main returns a result. */
  handleResult(message: BrowserExecuteResultMessage): Promise<void>;
  dispose(): void;
}

export function createBrowserControlMainBridge(deps: {
  postToMain: (message: BrowserExecuteRequestMessage) => void;
  timeoutMs?: number;
  materializeRecording?(input: {
    artifact: BrowserRecordingArtifact;
    localPath: string;
    outputPath: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<BrowserRecordingArtifact>;
}): BrowserControlMainBridge {
  const pending = new Map<string, PendingEntry>();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const browserId = `iab:${randomUUID()}`;
  const browserGeneration = Date.now();
  const deletePendingIfCurrent = (requestId: string, entry: PendingEntry): boolean => {
    if (pending.get(requestId) !== entry) return false;
    pending.delete(requestId);
    return true;
  };
  const descriptor: BrowserBackendDescriptor = {
    id: browserId,
    generation: browserGeneration,
    type: "iab",
    name: "ZCode In-app Browser",
    capabilities: {
      // capability collection lists optional capabilities only; tabs/cua/screenshot/dialog are core API and
      // must not masquerade as capabilities. viewport is core Playwright-like Tab API; the browser capability
      // currently keeps only visibility; pageAssets/cdp are unimplemented and hidden.
      browser: [
        {
          id: "visibility",
          description:
            "Use to show or hide the browser to the user, and to determine the browser's current visibility. Keep browser work in the background unless the user asks to see it or live viewing is useful. When the browser should be visible, call set(true).",
        },
      ],
      tab: [],
    },
    apiSupportOverrides: {
      "BrowserUser.claimTab": true,
      "Tabs.finalize": true,
      "Tab.markDeliverable": true,
      "Tab.markHandoff": true,
      "BrowserRecordingAPI.start": true,
      "BrowserRecordingAPI.status": true,
      "BrowserRecordingAPI.cancel": true,
    },
    metadata: {
      provider: "zcode-desktop-iab",
    },
  };

  return {
    async list(): Promise<BrowserBackendDescriptor[]> {
      return [descriptor];
    },

    async execute({
      requestId: inputRequestId,
      browserId: requestedBrowserId,
      browserGeneration: requestedBrowserGeneration,
      sessionId,
      turnId,
      workspaceKey = sessionId,
      workspacePath = workspaceKey,
      workspaceIdentity,
      remoteSessionId,
      clientMode = "desktop-continuous",
      sessionContext = "live",
      command,
    }): Promise<BrowserCommandResult> {
      if (requestedBrowserId && requestedBrowserId !== browserId) {
        return {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: `browser backend '${requestedBrowserId}' is no longer available`,
          },
          elapsedMs: 0,
        };
      }
      if (
        requestedBrowserGeneration !== undefined &&
        requestedBrowserGeneration !== browserGeneration
      ) {
        return {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: `browser backend '${browserId}' generation ${requestedBrowserGeneration} is stale`,
          },
          elapsedMs: 0,
        };
      }
      const requestId = inputRequestId ?? randomUUID();
      if (pending.has(requestId)) {
        // requestId is the correlation key between result and promise. Overwriting a same-key entry
        // hands an old result to the new promise and lets the old timer/finally delete the new request. Fail before transport.
        return {
          ok: false,
          error: {
            code: "duplicate_request_id",
            message: `browser requestId '${requestId}' is already running`,
            sideEffect: "none",
          },
          elapsedMs: 0,
        };
      }
      const startedAt = Date.now();
      // The fixed-wait transport budget is request duration plus 2s, covering the wait itself and transport overhead.
      // Otherwise waitForTimeout(>=30s) is misjudged as timed out by the host bridge before its timer completes.
      const requestTimeoutMs =
        command.method === "playwrightWaitForTimeout"
          ? command.timeoutMs + 2_000
          : command.method === "playwright"
            ? ("timeoutMs" in command.action
                ? (command.action.timeoutMs ?? timeoutMs)
                : timeoutMs) + 2_000
            : timeoutMs;
      return await new Promise<BrowserCommandResult>((resolve) => {
        let entry: PendingEntry;
        const timer = setTimeout(() => {
          // Only the current entry may settle its own lifecycle; keeps future paths from reintroducing same-key overwrite where
          // an old timer deletes or cancels a later-registered request.
          if (!deletePendingIfCurrent(requestId, entry)) return;
          // Previously the host only ended its local wait while the main/backend action kept running, with the caller
          // already holding a timeout. A reverse cancel now goes out on the same scope; when dispatch cannot be proven,
          // the outcome must be marked uncertain per the operation-result contract, never claimed side-effect-free.
          const cancelRequestId = randomUUID();
          try {
            deps.postToMain({
              type: HostResponseTypes.BrowserExecuteRequest,
              requestId: cancelRequestId,
              browserId,
              browserGeneration,
              sessionId,
              turnId,
              workspaceKey,
              workspacePath,
              workspaceIdentity,
              remoteSessionId,
              clientMode,
              sessionContext,
              command: { method: "cancelRequest", requestId },
            });
          } catch {
            // The original request already timed out; a failed cancel transport must not overwrite the more useful timeout result.
          }
          resolve({
            ok: false,
            error: {
              code: "timeout",
              message: `browser command ${command.method} timed out (${requestTimeoutMs}ms)`,
              sideEffect: mayHaveSideEffects(command) ? "uncertain" : "none",
            },
            elapsedMs: Date.now() - startedAt,
          });
        }, requestTimeoutMs);
        entry = {
          resolve,
          timer,
          method: command.method,
          startedAt,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          ...(command.method === "recordingStatus" && command.outputPath
            ? { outputPath: command.outputPath }
            : {}),
        };
        pending.set(requestId, entry);
        try {
          deps.postToMain({
            type: HostResponseTypes.BrowserExecuteRequest,
            requestId,
            browserId,
            browserGeneration,
            sessionId,
            turnId,
            workspaceKey,
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
            clientMode,
            sessionContext,
            command,
          });
        } catch (error) {
          clearTimeout(timer);
          deletePendingIfCurrent(requestId, entry);
          resolve({
            ok: false,
            error: {
              code: "backend_unavailable",
              message: error instanceof Error ? error.message : String(error),
            },
            elapsedMs: Date.now() - startedAt,
          });
        }
      });
    },

    async handleResult(message): Promise<void> {
      const entry = pending.get(message.requestId);
      if (!entry) {
        // Late result after timeout cleanup: ignore.
        return;
      }
      clearTimeout(entry.timer);
      if (!deletePendingIfCurrent(message.requestId, entry)) return;
      const artifact = message.result.recording?.artifact;
      if (
        message.result.ok &&
        message.result.recording?.status === "completed" &&
        artifact &&
        entry.outputPath
      ) {
        if (!deps.materializeRecording) {
          entry.resolve({
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "browser recording artifact materialization is unavailable",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - entry.startedAt,
          });
          return;
        }
        try {
          const materialized = await deps.materializeRecording({
            artifact,
            localPath: artifact.path,
            outputPath: entry.outputPath,
            workspacePath: entry.workspacePath,
            ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
            ...(entry.remoteSessionId ? { remoteSessionId: entry.remoteSessionId } : {}),
          });
          entry.resolve({
            ...message.result,
            recording: { ...message.result.recording, artifact: materialized },
          });
        } catch (error) {
          entry.resolve({
            ok: false,
            error: {
              code: "execution_error",
              message: error instanceof Error ? error.message : String(error),
              sideEffect: "none",
            },
            elapsedMs: Date.now() - entry.startedAt,
          });
        }
        return;
      }
      if (message.result.recording?.status === "completed" && artifact && !entry.outputPath) {
        const { artifact: _mainTemporaryArtifact, ...recording } = message.result.recording;
        entry.resolve({
          ...message.result,
          recording,
        });
        return;
      }
      entry.resolve(message.result);
    },

    dispose(): void {
      for (const [requestId, entry] of pending) {
        if (!deletePendingIfCurrent(requestId, entry)) continue;
        clearTimeout(entry.timer);
        // Clearing the map outright would hang every awaiting caller forever. Bridge shutdown must
        // settle each promise, flagging backend-executed as undecidable.
        entry.resolve({
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "browser bridge disposed while command was pending",
            sideEffect: "uncertain",
          },
          elapsedMs: Date.now() - entry.startedAt,
        });
      }
    },
  };
}
