import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const productionRoots = [
  "packages/provider/src",
  "packages/provider-node/src",
  "packages/services/src",
  "packages/ui/src",
  "packages/desktop/src",
  "packages/shared/src",
  "apps/zcode-cli/packages/adapters/src",
  "apps/zcode-cli/packages/bootstrap/src",
  "apps/zcode-cli/packages/cli/src",
  "apps/zcode-cli/packages/contracts/src",
  "apps/zcode-cli/packages/core/src",
  "apps/zcode-cli/packages/tui/src",
] as const;

const legacyDtoOwners = new Set([
  "packages/services/src/model-provider/legacyModelProviderSerialized.ts",
  "packages/services/src/model-provider/legacyZCodeConfigProviderReader.ts",
  "packages/services/src/model-provider/legacyPersonalProviderConfigImporter.ts",
  "packages/services/src/model-provider/providerConfigRuntime.ts",
]);
const legacyDtoTestOwners = new Set([
  "packages/services/test/legacyZCodeConfigProviderReader.test.ts",
  "packages/services/test/legacyPersonalProviderConfigImporter.test.ts",
  "packages/services/test/providerConfigRuntime.test.ts",
  "packages/ui/test/providerSettingsFormBoundary.test.ts",
]);
const legacyApiFormatOwners = new Set([
  "packages/services/src/model-provider/legacyModelProviderSerialized.ts",
  "packages/services/src/model-provider/legacyZCodeConfigProviderReader.ts",
]);
const testRoots = [
  "packages/desktop/test",
  "packages/services/test",
  "packages/shared/test",
  "packages/ui/test",
] as const;

describe("M2 completion boundary", () => {
  it("confines the legacy provider DTO to the one-shot physical migration boundary", async () => {
    const matches = await findProductionFilesMatching(/\bModelProviderConfig\b/u);
    expect(matches).toEqual([...legacyDtoOwners].sort());
  });

  it("keeps legacy provider DTOs out of non-migration test fixtures", async () => {
    const matches = await findFilesMatching(testRoots, /\bModelProviderConfig\b/u);
    expect(matches).toEqual([...legacyDtoTestOwners].sort());
  });

  it("stops production from reading legacy provider store paths", async () => {
    expect(await findProductionFilesContaining("model-providers.json")).toEqual([]);
  });

  it("keeps legacy API format types out of the production provider consumption path", async () => {
    const matches = await findProductionFilesMatching(/\bModelProviderApiFormat\b/u);
    expect(matches).toEqual([...legacyApiFormatOwners].sort());
  });

  it("confines the legacy runtime model config to one-shot import and compatibility parsing", async () => {
    const matches = await findProductionFilesMatching(/\bRuntimeModelConfig\b/u);
    expect(matches).toEqual([]);
  });

  it("never lets hardcoded model-name defaults back into the Process Registry or official models", async () => {
    const matches = await findProductionFilesMatching(
      /\b(?:resolveModelCapabilityDefaults|createDefaultModelCapability|applyModelCapabilityDefaults)\b/u,
    );
    expect(matches).toEqual([]);
  });

  it.each([
    "ZCodeProviderRegistrySnapshot",
    "workspace/updateProviderRegistry",
    "RuntimeModelOverlayManager",
    "ModelProviderService",
    "modelProviderServiceStorage",
    "providerSettingsLegacyProjection",
    "workspaceModelCatalogs",
    "workspaceModelMirror",
    "setModelCatalogOverlay",
    "ZCodeWorkspaceModelCatalogState",
    "setProviderRuntimeHeaders",
    "session/updateRuntimeModelConfig",
    "hasProcessProviderRegistry",
    "bootstrapModelConfig",
    "includeLegacyProviderModels",
    "BUILTIN_MODEL_PROVIDER_ORDER",
    "ModelProviderDisplayOrderState",
    "Workspace model catalog",
    "workspace model catalog",
    "appliedProviderRevision",
    "providerRevision",
    "createRuntimeAiSdkModelRegistryConfig",
    "modelCatalog: options.modelCatalog",
  ])("keeps retired boundary %s out of production sources", async (retiredBoundary) => {
    expect(await findProductionFilesContaining(retiredBoundary)).toEqual([]);
  });

  it.each([
    "isModelProviderEnabled",
    "getModelProviderModelId",
    "getModelProviderModelLabel",
    "findModelProviderModel",
    "mapModelProviderKindToSupportedFormat",
    "resolveModelSupportedFormatsForModel",
    "hasRemoteProviderModelFacts",
    "migrateLegacyOpenAiCompatibleReasoningOptions",
    "isSystemDisabledCodingPlanProvider",
    "isUserDisabledCodingPlanProvider",
  ])(
    "keeps the orphaned legacy helper %s unexported and unconsumed in production sources",
    async (retiredHelper) => {
      expect(
        await findProductionFilesMatching(new RegExp(`\\b${escapeRegExp(retiredHelper)}\\b`, "u")),
      ).toEqual([]);
    },
  );
});

async function findProductionFilesContaining(needle: string): Promise<string[]> {
  return findProductionFilesMatching(new RegExp(escapeRegExp(needle), "u"));
}

async function findProductionFilesMatching(pattern: RegExp): Promise<string[]> {
  return findFilesMatching(productionRoots, pattern);
}

async function findFilesMatching(roots: readonly string[], pattern: RegExp): Promise<string[]> {
  const files = (
    await Promise.all(roots.map((root) => collectSourceFiles(resolve(repositoryRoot, root))))
  ).flat();
  const matches: string[] = [];
  for (const file of files) {
    if (pattern.test(await readFile(file, "utf-8"))) {
      // Paths act as cross-platform module ids; compare with POSIX separators (Windows readdir yields \).
      matches.push(relative(repositoryRoot, file).replaceAll("\\", "/"));
    }
  }
  return matches.sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(path);
      return extname(entry.name) === ".ts" || extname(entry.name) === ".tsx" ? [path] : [];
    }),
  );
  return files.flat();
}
