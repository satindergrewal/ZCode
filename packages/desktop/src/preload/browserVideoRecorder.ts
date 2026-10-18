import { ipcRenderer } from "electron";

const RECORDER_PORT_CHANNEL = "zcode-browser-video-recorder:port";

// MessagePorts cannot cross contextBridge; this dedicated preload only hands the main-sent port to
// the one trusted recorder document, exposing no ipcRenderer or general Electron surface.
ipcRenderer.once(RECORDER_PORT_CHANNEL, (event) => {
  const [port] = event.ports;
  if (port) window.postMessage(RECORDER_PORT_CHANNEL, "*", [port]);
});
