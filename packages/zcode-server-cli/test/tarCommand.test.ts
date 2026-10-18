import { describe, expect, it, vi } from "vitest";
import { isTarCommand, resolveHostTarCommand } from "../src/packaging/tarCommand.js";

function stubPlatform(platform: NodeJS.Platform) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

describe("resolveHostTarCommand", () => {
  it("returns the PATH-resolved tar untouched on non-Windows hosts, never System32 (CR review regression)", () => {
    stubPlatform("linux");
    // System32/tar.exe used to be resolved before the platform check, throwing outright for POSIX archives.
    expect(resolveHostTarCommand()).toBe("tar");
    stubPlatform("darwin");
    expect(resolveHostTarCommand()).toBe("tar");
  });

  it("fails fast on Windows when System32 tar.exe is missing instead of falling back to PATH", () => {
    stubPlatform("win32");
    const original = process.env.SystemRoot;
    process.env.SystemRoot = "Z:\\definitely-missing";
    try {
      expect(() => resolveHostTarCommand()).toThrow(/System32 tar\.exe missing/u);
    } finally {
      process.env.SystemRoot = original;
    }
  });

  it("matches both bare tar and the absolute System32 path in isTarCommand", () => {
    expect(isTarCommand("tar")).toBe(true);
    expect(isTarCommand("C:\\Windows\\System32\\tar.exe")).toBe(true);
    expect(isTarCommand("/usr/bin/tar")).toBe(true);
    expect(isTarCommand("zip")).toBe(false);
  });
});
