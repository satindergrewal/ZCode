import { describe, expect, it, vi } from "vitest";
import { ensureRemoteServerDeviceMid } from "../src/stdioDeviceMid.js";

describe("ensureRemoteServerDeviceMid", () => {
  it("ensures deviceMid on startup, returns it and stays quiet", async () => {
    const log = vi.fn();
    const ensureDeviceMid = vi.fn(async () => "device-mid-remote");

    await expect(ensureRemoteServerDeviceMid({ ensureDeviceMid, log })).resolves.toBe(
      "device-mid-remote",
    );

    expect(ensureDeviceMid).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("logs the cause and keeps starting when ensure fails, without throwing or fabricating an id", async () => {
    const log = vi.fn();
    const ensureDeviceMid = vi.fn(async () => {
      throw new Error("Telemetry state lock timeout");
    });

    await expect(ensureRemoteServerDeviceMid({ ensureDeviceMid, log })).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("X-Device-Mid");
    expect(String(log.mock.calls[0]?.[1])).toContain("Telemetry state lock timeout");
  });
});
