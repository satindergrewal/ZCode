import { describe, expect, it } from "vitest";
import {
  claimSanitizedTelemetryError,
  sanitizeErrorMessage,
  sanitizeTelemetryError,
} from "../src/error-sanitizer.js";

describe("telemetry error sanitizer", () => {
  it("sanitizes nested network causes without double-recording plain errors", () => {
    const cause = Object.assign(
      new Error("socket reset request=req-42 authorization: Bearer secret-token"),
      { code: "ECONNRESET" },
    );
    expect(sanitizeTelemetryError(new Error("terminated", { cause }))).toMatchObject({
      message: "terminated",
      cause: {
        code: "ECONNRESET",
        message: "socket reset request=req-42 authorization: {redacted}",
        type: "Error",
      },
    });
    expect(sanitizeTelemetryError(new Error("plain"))).not.toHaveProperty("cause");
  });

  it("walks adapterError/error wrappers to the root cause, claiming each source error once", () => {
    const source = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const wrapper = { message: "terminated", adapterError: { error: source } };
    expect(claimSanitizedTelemetryError(wrapper)).toMatchObject({
      cause: { message: "socket reset", code: "ECONNRESET" },
    });
    expect(claimSanitizedTelemetryError(new Error("outer", { cause: source }))).toBeUndefined();
  });

  it("prefers cause and keeps unrelated wrapper fields out of the causal chain", () => {
    const preferred = new Error("preferred");
    const ignored = new Error("ignored");
    expect(sanitizeTelemetryError({ cause: preferred, adapterError: ignored })).toMatchObject({
      cause: { message: "preferred" },
    });
  });

  it("bounds cycles and wrapping past eight levels; self-reference invents no phantom root cause", () => {
    const self = new Error("self");
    self.cause = self;
    expect(sanitizeTelemetryError(self)).not.toHaveProperty("cause");
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    first.cause = second;
    expect(sanitizeTelemetryError(first)).toMatchObject({ cause: { message: "second" } });
    let deep = new Error("level-10");
    for (let level = 9; level >= 1; level -= 1) {
      deep = new Error(`level-${level}`, { cause: deep });
    }
    expect(sanitizeTelemetryError(deep)).toMatchObject({ cause: { message: "level-8" } });
  });

  it("strips credentials, emails, local paths, and URL queries while keeping diagnostic IDs, IPs, and API routes", () => {
    const sanitized = sanitizeErrorMessage(
      [
        "POST https://tenant@example.com/v1/messages?api_key=secret-value",
        "authorization: Bearer abc.def.ghi",
        "x-arms-license-key=test-license-secret-123456",
        "raw sk-super-private-token-123456",
        "raw ghp_123456789012345678901234567890",
        "raw demo1234@abcdef1234567890",
        "user@example.com",
        "request 123e4567-e89b-12d3-a456-426614174000 from 10.2.3.4",
        "at /Users/alice/private/project/index.ts",
        "at /workspace/private-project/src/index.ts",
        "at C:\\private-project\\src\\index.ts",
      ].join("\n"),
    );

    expect(sanitized).toContain("https://example.com/v1/messages");
    expect(sanitized).toContain("authorization: {redacted}");
    expect(sanitized).not.toContain("secret-value");
    expect(sanitized).not.toContain("test-license-secret");
    expect(sanitized).not.toContain("super-private-token");
    expect(sanitized).not.toContain("123456789012345678901234567890");
    expect(sanitized).not.toContain("abcdef1234567890");
    expect(sanitized).not.toContain("user@example.com");
    expect(sanitized).toContain("123e4567-e89b-12d3-a456-426614174000");
    expect(sanitized).toContain("10.2.3.4");
    expect(sanitized).not.toContain("/Users/alice");
    expect(sanitized).not.toContain("private-project");
    expect(sanitized).not.toContain("\n");
  });

  it("keeps error codes verbatim while error types still require stable identifiers", () => {
    const sanitized = sanitizeTelemetryError({
      code: "private code with spaces",
      message: "failed",
      type: "private/type",
    });

    expect(sanitized.code).toBe("private code with spaces");
    expect(sanitized.type).toBe("UnknownError");
  });

  it("keeps the sanitized diagnostic at the end of a wrapped-error causal chain", () => {
    const cause = Object.assign(
      new Error("socket reset request=req-42 authorization: Bearer secret-token"),
      { code: "ECONNRESET" },
    );
    const sanitized = sanitizeTelemetryError(new Error("terminated", { cause }));

    expect(sanitized).toMatchObject({
      cause: {
        code: "ECONNRESET",
        message: "socket reset request=req-42 authorization: {redacted}",
        type: "Error",
      },
    });
  });
});
