import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWebRemoteControlRoutePath } from "../src/webRemoteControlRoute.js";

describe("resolveWebRemoteControlRoutePath", () => {
  it("pins the page entry to /remote/v4 when the route var is injected, letting asset bases carry version dirs", () => {
    expect(
      resolveWebRemoteControlRoutePath({
        VITE_WEB_REMOTE_CONTROL_ROUTE_PATH: "/remote/v4",
        BASE_URL: "/remote/v4/3.13.0/",
      }),
    ).toBe("/remote/v4");
    expect(
      resolveWebRemoteControlRoutePath({
        VITE_WEB_REMOTE_CONTROL_ROUTE_PATH: "/remote/v4/",
        BASE_URL: "/remote/v4/latest/",
      }),
    ).toBe("/remote/v4");
  });

  it("keeps the BASE_URL derivation when absent or blank, preserving Docker, v3 and dev entries", () => {
    expect(resolveWebRemoteControlRoutePath({ BASE_URL: "/remote/v4/" })).toBe("/remote/v4");
    expect(
      resolveWebRemoteControlRoutePath({
        VITE_WEB_REMOTE_CONTROL_ROUTE_PATH: "   ",
        BASE_URL: "/remote/v3/",
      }),
    ).toBe("/remote/v3");
    expect(resolveWebRemoteControlRoutePath({ BASE_URL: "/" })).toBe("/remote");
  });

  it("keeps the source variable the release script matches on to detect versioned bases", async () => {
    // remote-frontend-build-source.mjs greps this file for the variable to decide legacy-base fallback for old tags.
    const source = await readFile(
      resolve(import.meta.dirname, "../src/webRemoteControlRoute.ts"),
      "utf8",
    );
    expect(source).toContain("VITE_WEB_REMOTE_CONTROL_ROUTE_PATH");
    const main = await readFile(resolve(import.meta.dirname, "../src/main.tsx"), "utf8");
    expect(main).toContain("resolveWebRemoteControlRoutePath(import.meta.env)");
  });
});
