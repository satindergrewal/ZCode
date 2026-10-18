import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IModelSelectionService, IZCodeAgentService } from "@zcode/services";
import {
  disposeServiceResourcesAndWait,
  resolveDefaultZCodeAgentCommand,
  setDataBaseDir,
  type ZCodeAgentCommand,
  type ZCodeAgentCommandResolverContext,
} from "@zcode/services/node";
import {
  SERVICE_AUTHORITY_MODE_ENV,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStdioServices, resolveRemoteAgentNetworkFromEnv } from "../src/stdioServices.js";

const originalHome = process.env.HOME;
const originalCommand = process.env.ZCODE_AGENT_SERVER_COMMAND;
const originalArgsJson = process.env.ZCODE_AGENT_SERVER_ARGS_JSON;
const originalDesktopContextPromptEnabled = process.env[ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("stdio Desktop presentation surface", () => {
  const tempHomes: string[] = [];

  afterEach(async () => {
    setDataBaseDir(null);
    restoreEnv("HOME", originalHome);
    restoreEnv("ZCODE_AGENT_SERVER_COMMAND", originalCommand);
    restoreEnv("ZCODE_AGENT_SERVER_ARGS_JSON", originalArgsJson);
    restoreEnv(ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV, originalDesktopContextPromptEnabled);
    vi.restoreAllMocks();
    await Promise.all(
      tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  });

  it("reads the one-shot WSL Agent network config only from the authoritative Host flag", () => {
    expect(
      resolveRemoteAgentNetworkFromEnv({
        [ZCODE_REMOTE_HTTP_PROXY_ENV_KEY]: " http://172.21.240.1:7890 ",
        [ZCODE_REMOTE_NO_PROXY_ENV_KEY]: " localhost,127.0.0.1 ",
      }),
    ).toBeUndefined();
    expect(
      resolveRemoteAgentNetworkFromEnv({
        [ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]: "1",
        [ZCODE_REMOTE_HTTP_PROXY_ENV_KEY]: " http://172.21.240.1:7890 ",
        [ZCODE_REMOTE_NO_PROXY_ENV_KEY]: " localhost,127.0.0.1 ",
      }),
    ).toEqual({
      httpProxy: "http://172.21.240.1:7890",
      noProxy: "localhost,127.0.0.1",
    });
  });

  it("threads the desktop-attached remote authority through stdio wiring and emits the Desktop Agent command", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-stdio-desktop-surface-"));
    tempHomes.push(home);
    process.env.HOME = home;
    setDataBaseDir(home);
    // Bugfix: dev machines may export ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED=0 (e.g. a local ZCode install's shell integration),
    // which would wipe the desktop-attached-remote presentationSurface to undefined and
    // make the threading assertion environment-sensitive; pin 1 to keep the case hermetic.
    process.env[ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV] = "1";
    process.env.ZCODE_AGENT_SERVER_COMMAND = process.execPath;
    process.env.ZCODE_AGENT_SERVER_ARGS_JSON = JSON.stringify([
      "zcode.cjs",
      "app-server",
      "--stdio",
    ]);
    const zcodeBuiltinProviderConfigFilePath = join(home, "zcode-builtin.json");
    const personalConfigFilePath = join(home, ".zcode", "v2", "provider_config.json");
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await writeFile(
      personalConfigFilePath,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "test-provider",
                templateId: "test-template",
                providerName: "Test Provider",
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey: "test-key" },
                  personalModelIds: ["test-model"],
                },
              },
            ],
          },
          // Use the real envelopes and grouping; stale intermediate shapes are rejected before wiring and cannot cover this remote path.
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      }),
      "utf8",
    );
    await writeFile(
      zcodeBuiltinProviderConfigFilePath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: {
            providerRules: [],
            templateRules: [
              {
                templateId: "test-template",
                templateNameMap: { "en-US": "Test Provider" },
                config: {
                  access: { type: "api-key" },
                  api: {
                    type: "openai-chat-completions",
                    baseUrl: "https://example.com/v1",
                  },
                  builtinModelIds: ["test-model"],
                },
              },
            ],
          },
          modelConfigRules: {
            modelRules: [],
            modelApiRules: [],
            providerSiteRules: [],
            builtinProviderModelRules: [],
            templateModelRules: [
              {
                templateId: "test-template",
                modelId: "test-model",
                config: {
                  enabled: true,

                  properties: {
                    requiresMfjsToolSchema: false,
                    contextWindow: 128000,
                    inputFormat: {
                      supportsText: true,
                      supportsImage: false,
                      supportsVideo: false,
                      supportsAudio: false,
                      supportsPdf: false,
                    },
                    outputFormat: { supportsText: true },
                    supportsToolCall: true,
                    supportsJsonSchemaOutput: true,
                    supportsNativeWebSearch: false,
                    supportsMidConversationSystem: false,
                  },
                  optionSpecs: {
                    reasoningLevel: {
                      values: ["disabled"],
                      map: "{}",
                    },
                    maxOutputTokens: {
                      max: 8192,
                      map: "{'max_completion_tokens': maxOutputTokens}",
                    },
                  },
                },
              },
            ],
          },
        },
      }),
      "utf8",
    );

    let resolvedCommand: ZCodeAgentCommand | null = null;
    const commandResolver = vi.fn((context: ZCodeAgentCommandResolverContext) => {
      resolvedCommand = resolveDefaultZCodeAgentCommand(context);
      // The integration test only asserts entry wiring and the final command; no long-lived agent child is spawned.
      return null;
    });
    const bootstrap = createStdioServices({
      env: {
        [SERVICE_AUTHORITY_MODE_ENV]: "desktop-attached-remote",
      },
      zcodeBuiltinProviderConfigFilePath,
      zcodeAgentCommandResolver: commandResolver,
    });

    try {
      await expect(bootstrap.services.get(IModelSelectionService).getView()).resolves.toMatchObject(
        {
          revision: 1,
          providers: [
            {
              providerId: "test-provider",
              models: [{ modelId: "test-model" }],
            },
          ],
        },
      );
      await expect(
        bootstrap.services.get(IZCodeAgentService).initialize({
          workspaceIdentity: "ssh://host/workspace/project",
          workspacePath: "/workspace/project",
        }),
      ).resolves.toMatchObject({
        available: false,
        reason: expect.stringContaining("ZCode agent server command is not configured"),
      });

      expect(bootstrap.authorityModeParseResult.mode).toBe("desktop-attached-remote");
      expect(commandResolver).toHaveBeenCalledWith(
        expect.objectContaining({
          presentationSurface: "desktop",
          workspaceIdentity: "ssh://host/workspace/project",
          workspaceKey: "ssh://host/workspace/project",
          workspacePath: "/workspace/project",
        }),
      );
      expect(resolvedCommand).toEqual({
        args: ["zcode.cjs", "app-server", "--stdio", "--surface", "desktop"],
        command: process.execPath,
        cwd: "/workspace/project",
        // The env-override command reuses the packaged bundle for Host storage preparation.
        storagePreparationEntry: expect.any(String),
        supportsStorageStartup: true,
      });
    } finally {
      // Wait for async persistence and disposal so the temp dir cleanup never races background re-creation.
      await disposeServiceResourcesAndWait(bootstrap.services);
      setDataBaseDir(null);
    }
  });
});
