import type { MessagePortMain } from "electron";
import type { MessagePortLike, MessagePortPayload } from "@zcode/rpc";

/**
 * Adapts the Electron MessagePortMain to the RPC layer's MessagePortLike interface.
 *
 * Electron's MessagePortMain uses Node EventEmitter style (.on/.off),
 * while MessagePortLike uses the Web standard style (addEventListener/removeEventListener).
 * This adapter bridges the two so MessagePortProtocol works directly inside a utilityProcess.
 */
export function wrapElectronPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      // MessagePortMain's message event already carries the { data } shape; forward as-is.
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}
