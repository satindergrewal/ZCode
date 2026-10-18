import { describe, expect, it } from "vitest";
import {
  ProviderEndpointIdentityCache,
  sanitizeProviderEndpoint,
} from "../src/provider-endpoint.js";

describe("sanitizeProviderEndpoint", () => {
  it("keeps the stable route and strips credentials, query, and fragment", () => {
    expect(
      sanitizeProviderEndpoint(
        "https://user:pass@Gateway.Example.com:443/team-a/v1/messages?api_key=secret#part",
      ),
    ).toMatchObject({
      origin: "https://gateway.example.com",
      route: "/team-a/v1/messages",
      sanitizerVersion: "1",
    });
  });

  it("sanitizes email, UUID, long-number, hash, and token-style segments", () => {
    const endpoint = sanitizeProviderEndpoint(
      "https://api.example.com/alice@example.com/550e8400-e29b-41d4-a716-446655440000/123456789/abcdef0123456789/Abcdef0123456789TOKEN/v1",
    );
    expect(endpoint?.route).toBe("/{email}/{uuid}/{id}/{hash}/{token}/v1");
  });

  it("fails closed on invalid URLs", () => {
    expect(sanitizeProviderEndpoint("not-a-url?token=secret")).toBeUndefined();
    expect(
      sanitizeProviderEndpoint(`https://api.example.com/${"sensitive".repeat(1_000)}`),
    ).toBeUndefined();
  });

  it("bounds the length of retained custom route segments", () => {
    const segment = "route".repeat(40);
    const endpoint = sanitizeProviderEndpoint(`https://api.example.com/${segment}/v1/messages`);
    expect(endpoint?.route).toBe(`/${segment.slice(0, 128)}/v1/messages`);
  });
});

describe("ProviderEndpointIdentityCache", () => {
  it("uses a bounded LRU and returns a stable result for the same endpoint", () => {
    const cache = new ProviderEndpointIdentityCache(2);
    const first = cache.resolve("anthropic", "https://a.example.com/v1/messages");
    expect(cache.resolve("anthropic", "https://a.example.com/v1/messages")).toEqual(first);
    cache.resolve("openai", "https://b.example.com/v1");
    cache.resolve("custom", "https://c.example.com/v1");
    expect(cache.size).toBe(2);
  });
});
