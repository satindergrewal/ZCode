import { randomUUID } from "node:crypto";
import { ipcMain, session, webContents, type BrowserWindow, type UtilityProcess } from "electron";
import { HostMessageTypes, PlatformChannels, type NetworkCaptureBatch } from "@zcode/shared";
import { createNodeNetworkCapture } from "@zcode/shared/node";
import { NetworkCaptureBuffer } from "./networkCaptureBuffer.js";
import { subscribeBeforeRequest } from "./observeBeforeRequest.js";

const buffer = new NetworkCaptureBuffer();
const nodeCapture = createNodeNetworkCapture("main", (batch) => buffer.ingest(batch));
let captureId: string | null = null;
let ownerId: number | null = null;
let currentHosts: (() => Iterable<UtilityProcess>) | null = null;
let disposers: Array<() => void> = [];

export function configureNetworkCaptureHost(child: UtilityProcess): void {
  if (!captureId) return;
  sendControl(child);
}

function sendControl(child: UtilityProcess): void {
  try {
    child.postMessage({ type: HostMessageTypes.NetworkCapture, control: { captureId } });
  } catch {
    /* Host exited; observation never restarts processes */
  }
}

export function startResourceManagerNetwork(
  senderId: number,
  hosts: () => Iterable<UtilityProcess>,
): void {
  if (captureId) return;
  captureId = randomUUID();
  ownerId = senderId;
  currentHosts = hosts;
  buffer.start(captureId);
  nodeCapture.setCaptureId(captureId);
  // Subscribe only to sessions the app owns; embedded-browser/recording sessions stay out of capture.
  const sessions = [
    session.defaultSession,
    session.fromPartition("persist:zcode-coding-plan"),
    session.fromPartition("persist:zcode-rewards"),
  ];
  for (const appSession of sessions) {
    disposers.push(
      subscribeBeforeRequest(
        appSession.webRequest,
        ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"],
        (details) => {
          if (!captureId) return;
          const contents =
            details.webContents ??
            (details.webContentsId ? webContents.fromId(details.webContentsId) : null);
          if (contents?.isDestroyed() || contents?.getType() === "remote") return;
          buffer.ingest({
            captureId,
            dropped: 0,
            records: [
              {
                timestamp: Date.now(),
                processType: contents ? "renderer" : "main",
                pid: contents ? contents.getOSProcessId() : process.pid,
                method: details.method,
                url: details.url,
              },
            ],
          });
        },
      ),
    );
  }
  for (const host of hosts()) configureNetworkCaptureHost(host);
}

export function stopResourceManagerNetwork(hosts: Iterable<UtilityProcess>): void {
  if (!captureId) return;
  captureId = null;
  ownerId = null;
  currentHosts = null;
  nodeCapture.setCaptureId(null);
  for (const dispose of disposers) dispose();
  disposers = [];
  buffer.stop();
  for (const host of hosts) sendControl(host);
}

export function observeNetworkWindow(
  window: BrowserWindow,
  hosts: () => Iterable<UtilityProcess>,
): void {
  startResourceManagerNetwork(window.webContents.id, hosts);
  const stop = () => stopResourceManagerNetwork(hosts());
  window.on("closed", stop);
  window.webContents.on("render-process-gone", stop);
  window.webContents.on("destroyed", stop);
}

export function ingestHostNetworkCapture(batch: NetworkCaptureBatch, hostPid: number): void {
  buffer.ingest({
    ...batch,
    records: batch.records
      .filter((record) => record.processType === "host" || record.processType === "cli")
      .map((record) => (record.processType === "host" ? { ...record, pid: hostPid } : record)),
  });
}

export function registerResourceManagerNetworkIpc(): void {
  const authorize = (senderId: number) => {
    if (senderId !== ownerId || !captureId) throw new Error("Network capture is inactive");
  };
  ipcMain.handle(PlatformChannels.GetNetworkCaptureSnapshot, (event) => {
    authorize(event.sender.id);
    return buffer.snapshot();
  });
  ipcMain.handle(PlatformChannels.ClearNetworkCapture, (event) => {
    authorize(event.sender.id);
    // Clearing must rotate captureId, or in-flight Host/CLI batches repopulate the list.
    captureId = randomUUID();
    buffer.start(captureId);
    nodeCapture.setCaptureId(captureId);
    for (const host of currentHosts?.() ?? []) configureNetworkCaptureHost(host);
  });
}
