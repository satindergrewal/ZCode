import { createProtocolProcessLifecycle } from "../../src/protocol-lifecycle.js";
import { installProtocolStderrBoundary } from "../../src/protocol-stderr.js";
import { installStderrConsoleBoundary } from "../../src/protocol-console.js";
import { installCliProcessErrorBoundary } from "../../src/process-errors.js";

const mode = process.argv[2];
installProtocolStderrBoundary(process.stderr);
installStderrConsoleBoundary(process.stderr);
const lifecycle = createProtocolProcessLifecycle({ timeoutMs: 500 });
installCliProcessErrorBoundary({
  onFatal: (reason) => {
    lifecycle.requestShutdown(new Error("Fatal", { cause: reason }));
  },
});
const frame = (value: string) =>
  process.stdout.write(JSON.stringify({ id: value, result: {} }) + "\n");
// Deliberately simulates a startup/handler that never returns; the deadline must start at input invalidation, not at run return.
if (mode !== "startup-hung" && mode !== "handler-hung") {
  lifecycle.signal.addEventListener("abort", () => {
    void lifecycle.complete(0);
  });
}
if (mode !== "startup-hung") {
  lifecycle.input.on("data", (chunk) => {
    const command = chunk.toString().trim();
    if (command === "throw")
      setImmediate(() => {
        throw new Error("uncaught child error");
      });
    else if (command === "reject") void Promise.reject(new Error("unhandled child rejection"));
    else if (command === "log") {
      console.error("diagnostic after reader closes");
      setTimeout(() => {
        for (let i = 0; i < 100; i++) process.stderr.write("late diagnostic\n");
        frame("healthy");
      }, 30);
    } else if (command === "output") frame("output");
    else if (command === "ping") frame("pong");
  });
}
frame("ready");
setInterval(() => {}, 1_000);
