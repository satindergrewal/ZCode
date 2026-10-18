import { describe, expect, it } from "vitest";
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "../src/remote/detectEnv.js";

describe("remote detect env", () => {
  it("normalizes x86_64 / amd64 to x64", () => {
    expect(normalizeRemoteArch("x86_64")).toBe("x64");
    expect(normalizeRemoteArch("amd64")).toBe("x64");
  });

  it("normalizes aarch64 / arm64e to arm64", () => {
    expect(normalizeRemoteArch("aarch64")).toBe("arm64");
    expect(normalizeRemoteArch("arm64e")).toBe("arm64");
  });

  it("falls back to linux for a darwin plus linux kernel probe", () => {
    expect(resolveRemotePlatform("darwin", "linux")).toBe("linux");
  });

  it("never falls back on real darwin (no /proc kernel values)", () => {
    expect(resolveRemotePlatform("darwin", "")).toBe("darwin");
  });

  it("normalizes platform aliases", () => {
    expect(normalizeRemotePlatform("GNU/Linux")).toBe("linux");
    expect(normalizeRemotePlatform("Windows_NT")).toBe("win32");
  });
});
