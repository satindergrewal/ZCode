import { describe, expect, it } from "vitest";
import { McpUiServerScopeError } from "./contract.js";
import { createExampleSessionAccess } from "./contract.example.js";

describe("mcp-ui contract", () => {
  it("example session view rules ownership by serverName", async () => {
    const access = createExampleSessionAccess();
    await expect(access.hasMcpServer("plugin:example-plugin:widget")).resolves.toBe(true);
    await expect(access.hasMcpServer("plugin:other:srv")).resolves.toBe(false);
  });

  it("maps ownership errors to -32602", () => {
    const error = new McpUiServerScopeError("plugin:other:srv");
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("is not available in this session");
  });
});
