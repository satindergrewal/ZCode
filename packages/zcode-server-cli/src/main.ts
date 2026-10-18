import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runServerCli } from "./cli.js";
import { resolveBundledAgentWiring } from "./runtime/agentWiring.js";

// The auto wiring is passed only as an explicit dependency of this CLI, never leaked into global env;
// when a candidate release starts, the Supervisor recomputes it from the candidate runtime
// instead of inheriting the old release zcode.cjs.
const bundledAgentWiring = await resolveBundledAgentWiring(
  dirname(fileURLToPath(import.meta.url)),
  process.env,
);

void runServerCli(
  process.argv.slice(2),
  {
    stdout: process.stdout,
    stderr: process.stderr,
    confirm: async (prompt) => {
      process.stdout.write(prompt);
      return await new Promise<string>((resolve) => {
        process.stdin.once("data", (chunk) => resolve(String(chunk).trim()));
      });
    },
  },
  { bundledAgentWiring },
).then((exitCode) => {
  process.exitCode = exitCode;
});
