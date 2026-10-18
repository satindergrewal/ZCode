// tui-prompt-handler.ts hit the oxlint max-lines cap (400), so the process-level prep inside createApp --
// read dotenv -> locate the session to resume -> load bootstrap modules -> start the Provider Registry
// resident runtime -> load the default model choice -- moved into this file;
// the public surface is still exported from tui-prompt-handler.ts.
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import { createCliProviderRefreshReporter } from "./provider-runtime-env.js";
import { resolveResumeSession } from "./resume.js";
import type { CliResumeRequest, RunDependencies } from "./cli-types.js";

type ProviderRegistryRuntime = Awaited<
  ReturnType<NonNullable<RunDependencies["startProcessProviderRegistryRuntime"]>>
>;

// Process-level handles reused across app replacements (/new, /resume, /fork): exactly one per Prompt Handler lifetime,
// shut down symmetrically only on terminal close. Previously three let closure variables inside createTuiSubmitPrompt.
interface TuiProcessRuntimeState {
  providerEndpointRoutingPort: ZCodeAppOptions["providerEndpointRoutingPort"];
  providerRegistryRuntimePromise: Promise<ProviderRegistryRuntime> | undefined;
  shutdownTelemetry: (() => Promise<void>) | undefined;
}

export const createTuiProcessRuntimeState = (): TuiProcessRuntimeState => ({
  providerEndpointRoutingPort: undefined,
  providerRegistryRuntimePromise: undefined,
  shutdownTelemetry: undefined,
});

// Let inference type the return: inside createApp these are inferred locals, and a hand-written interface would narrow the
// branded types (SessionId) and createZCodeApp's union signature incorrectly.
export async function prepareTuiAppRuntime(
  deps: RunDependencies,
  version: string,
  request: CliResumeRequest,
  state: TuiProcessRuntimeState,
) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
    cwd: workingDirectory,
    env,
  });

  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }

  const sessionId = await resolveResumeSession(request, workingDirectory, env, deps);
  const bootstrapModule = deps.createZCodeApp ? undefined : await loadBootstrapModule();
  const createAppFactory = deps.createZCodeApp ?? bootstrapModule?.createZCodeApp;
  if (!createAppFactory) throw new Error("ZCode app factory is unavailable.");
  const prepareTelemetry =
    deps.prepareZCodeTelemetryEnv ?? bootstrapModule?.prepareZCodeTelemetryEnv;
  if (prepareTelemetry) {
    state.shutdownTelemetry =
      deps.shutdownZCodeTelemetry ?? bootstrapModule?.shutdownZCodeTelemetry;
  }
  const appEnv = prepareTelemetry
    ? await prepareTelemetry(env, {
        cliVersion: version,
        productVersion: env.ZCODE_APP_VERSION,
      })
    : env;
  const startProviderRegistryRuntime =
    deps.startProcessProviderRegistryRuntime ??
    bootstrapModule?.startProcessProviderRegistryRuntime;
  if (!startProviderRegistryRuntime) {
    throw new Error("Provider Registry runtime is unavailable.");
  }
  state.providerRegistryRuntimePromise ??= startProviderRegistryRuntime(
    appEnv,
    deps.skipUserConfig
      ? {}
      : {
          standalone: {
            ...createCliProviderRefreshReporter(),
            ...(deps.userConfigPath ? { legacyCliUserConfigFilePath: deps.userConfigPath } : {}),
          },
        },
  );
  const providerRegistryRuntime = await state.providerRegistryRuntimePromise;
  const configuredDefaultModelSelection = providerRegistryRuntime?.modelSelectionConfigRepository
    ? await providerRegistryRuntime.modelSelectionConfigRepository.read()
    : providerRegistryRuntime?.configuredDefaultModelSelection;
  const createProviderEndpointRoutingPort =
    deps.createProviderEndpointRoutingPort ??
    bootstrapModule?.createDefaultProviderEndpointRoutingPort;
  state.providerEndpointRoutingPort ??= createProviderEndpointRoutingPort?.({
    appVersion: version,
    env,
    projectConfigPath: deps.projectConfigPath,
    skipUserConfig: deps.skipUserConfig,
    userConfigPath: deps.userConfigPath,
    workingDirectory,
  });

  return {
    appEnv,
    configuredDefaultModelSelection,
    createAppFactory,
    providerRegistryRuntime,
    sessionId,
    workingDirectory,
  };
}
