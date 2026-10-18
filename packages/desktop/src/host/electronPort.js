/**
 * Adapt Electron's MessagePortMain to the RPC layer's MessagePortLike interface.
 *
 * MessagePortMain uses Node EventEmitter style (.on/.off) while MessagePortLike uses the web
 * standard style (addEventListener/removeEventListener). This adapter bridges the two so
 * MessagePortProtocol runs directly inside a utilityProcess.
 */
export function wrapElectronPort(port) {
  return {
    addEventListener(_type, listener) {
      // MessagePortMain's message event is already { data }; forward verbatim.
      port.on("message", listener);
    },
    removeEventListener(_type, listener) {
      port.off("message", listener);
    },
    postMessage(data) {
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
//# sourceMappingURL=electronPort.js.map
