import { AccountProviderService, ProviderConfigMap } from "@zcode/provider";
import { NodeProviderRegistryRuntime } from "../../src/provider-registry-runtime.js";

// The real child only consumes shared files, mimicking a Worker that owns no downloader; Account uses locally controlled facts.
let account!: AccountProviderService;
const runtime = new NodeProviderRegistryRuntime({
  zcodeBuiltinFilePath: process.argv[2]!,
  personalFilePath: process.argv[3]!,
  personalPollingIntervalMs: false,
  createAccountSource(configSource) {
    account = new AccountProviderService({
      configSource,
      resolve: async () => ({ providers: ProviderConfigMap.empty(), states: {} }),
    });
    return account;
  },
});
function report() {
  const snapshot = runtime.registryService.getSnapshot()!;
  process.send?.({
    pid: process.pid,
    builtin: snapshot.config.zcodeBuiltinRevision,
    account: snapshot.account.basedOnZCodeBuiltinRevision,
  });
}
runtime.registryService.onDidChange(report);
await runtime.start();
report();
process.on("message", () => {
  runtime.dispose();
  account.dispose();
  process.disconnect();
});
process.on("disconnect", () => {
  runtime.dispose();
  account.dispose();
});
