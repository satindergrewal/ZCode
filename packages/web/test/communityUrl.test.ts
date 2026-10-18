import { describe, expect, it, vi } from "vitest";
import { resolveWebCommunityUrl, resolveWebHelpConfig } from "../src/communityUrl.js";

const LOCAL_CONFIG = {
  community_urls: {
    "zh-CN": "https://local.example.com/feishu",
    "en-US": "https://local.example.com/discord",
  },
};

describe("resolveWebCommunityUrl", () => {
  it.each([404, 500, 503])(
    "falls back to the built-in same-language entry on HTTP %i",
    async (status) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
        ok: false,
        status,
      } as Response);

      await expect(
        resolveWebCommunityUrl("zh-CN", { fetchImpl, localConfig: LOCAL_CONFIG }),
      ).resolves.toBe("https://local.example.com/feishu");
      await expect(
        resolveWebCommunityUrl("en-US", { fetchImpl, localConfig: LOCAL_CONFIG }),
      ).resolves.toBe("https://local.example.com/discord");
    },
  );

  it("falls back to the built-in entry when the remote lacks the current language", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          configs: {
            feedbackUrl: {
              community_urls: { "zh-CN": "https://remote.example.com/feishu" },
            },
          },
        },
      }),
    } as Response);

    await expect(
      resolveWebCommunityUrl("en-US", { fetchImpl, localConfig: LOCAL_CONFIG }),
    ).resolves.toBe("https://local.example.com/discord");
  });
});

it("uses the deployed endpoint's new API and extracts the feedback address", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      code: 0,
      data: {
        configs: {
          feedbackUrl: {
            feedback_url: "https://remote.feedback",
            community_urls: { "zh-CN": "https://remote.community" },
          },
        },
      },
    }),
  );
  expect(
    (await resolveWebHelpConfig({ fetchImpl, endpointOrigin: "https://test.example.com" }))
      .feedback_url,
  ).toBe("https://remote.feedback");
  expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.has("platform")).toBe(false);
  expect(fetchImpl.mock.calls[0][0]).toContain("https://test.example.com/api/v1/client/configs?");
  expect(await resolveWebCommunityUrl("zh-CN", { fetchImpl })).toBe("https://remote.community");
});
