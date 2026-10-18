import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadZCodeBuiltinRelease } from "../src/zcode-builtin-download.js";

const release = {
  schemaVersion: 1,
  revision: 7,
  config: {
    providerConfigRules: { templateRules: [], providerRules: [] },
    modelConfigRules: {
      modelRules: [],
      modelApiRules: [],
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [],
    },
  },
};
const input = {
  endpointOrigin: "https://control.example",
  appVersion: "test-version",
  platform: "darwin-aarch64",
};
const envelope = (field: unknown) =>
  JSON.stringify({
    code: 0,
    data: { configs: { builtin_provider_config_json: field, other: "unchanged" } },
  });
const cdn = "https://cdn.example/release-7.json";
afterEach(() => vi.useRealTimers());

describe("built-in shared-URL download boundary", () => {
  it("shares one signal across both phases, sends no CDN credentials and returns the official release", async () => {
    const request = vi.fn(
      async (url: string | URL) =>
        new Response(
          String(url).startsWith(input.endpointOrigin) ? envelope(cdn) : JSON.stringify(release),
        ),
    );
    const result = await downloadZCodeBuiltinRelease({ ...input, request });
    expect(result?.revision).toBe(7);
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[0][0])).toBe(
      "https://control.example/api/v1/client/configs?app_version=test-version&platform=darwin-aarch64",
    );
    expect(String(request.mock.calls[1][0])).toBe(cdn);
    const calls = request.mock.calls as unknown as [URL, RequestInit][];
    expect(calls[1][1]).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
    expect(new Headers(calls[1][1].headers).has("authorization")).toBe(false);
    expect(calls[1][1].signal).toBe(calls[0][1].signal);
  });
  it.each([
    null,
    3,
    {},
    "",
    "http://cdn.example/a",
    "https://user:secret@cdn.example/a",
    "file:///tmp/a",
    '{"revision":7}',
  ])("rejectes invalid URL field %j", async (field) => {
    const request = vi.fn(async () => new Response(envelope(field)));
    await expect(downloadZCodeBuiltinRelease({ ...input, request })).rejects.toThrow(
      /client-config/,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("downloads nothing and clears nothing for absent or legacy inline fields", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 0, data: { configs: { zcodeBuiltin: release } } })),
    );
    await expect(downloadZCodeBuiltinRelease({ ...input, request })).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["http", "json", "schema", "regex", "cel"])(
    "keeps CDN %s failures diagnosable",
    async (kind) => {
      const invalid = structuredClone(release);
      if (kind === "schema") invalid.schemaVersion = 99;
      if (kind === "regex")
        (invalid.config.modelConfigRules.modelRules as unknown[]).push({
          modelMatch: "[",
          config: {},
        });
      if (kind === "cel")
        (invalid.config.modelConfigRules.modelRules as unknown[]).push({
          modelMatch: ".*",
          config: { optionSpecs: { reasoningLevel: { map: "{" } } },
        });
      const request = vi
        .fn()
        .mockResolvedValueOnce(new Response(envelope(cdn)))
        .mockResolvedValueOnce(
          new Response(kind === "json" ? "{" : JSON.stringify(invalid), {
            status: kind === "http" ? 500 : 200,
          }),
        );
      await expect(downloadZCodeBuiltinRelease({ ...input, request })).rejects.toThrow(/cdn/);
    },
  );
  it.each([10_000_000, 10_000_001])(
    "counts actual bytes and never trusts Content-Length at the %d-byte boundary",
    async (size) => {
      const json = JSON.stringify(release);
      const body = json + " ".repeat(size - new TextEncoder().encode(json).length);
      const request = vi
        .fn()
        .mockResolvedValueOnce(new Response(envelope(cdn)))
        .mockResolvedValueOnce(new Response(body, { headers: { "Content-Length": "1" } }));
      const pending = downloadZCodeBuiltinRelease({ ...input, request });
      if (size === 10_000_000) await expect(pending).resolves.toMatchObject({ revision: 7 });
      else await expect(pending).rejects.toThrow(/limit/);
    },
  );
  it("budgets 20s across both header and body phases; on timeout cancels the reader and frees it", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel,
    });
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(new Response(envelope(cdn))), 12_000)),
      )
      .mockResolvedValueOnce(new Response(body));
    const pending = downloadZCodeBuiltinRelease({ ...input, request });
    const rejected = expect(pending).rejects.toThrow(/cdn.*timeout/);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels the header wait on exit instead of awaiting an Abort-oblivious network double", async () => {
    const controller = new AbortController();
    const request = vi.fn(() => new Promise<Response>(() => {}));
    const pending = downloadZCodeBuiltinRelease({ ...input, request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
  });
});
