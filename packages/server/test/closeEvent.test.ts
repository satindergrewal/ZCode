import { describe, expect, it } from "vitest";
import { createCloseEventController } from "../src/remote/closeEvent.js";

describe("close event controller", () => {
  it("delivers the close code when subscribing before the fire", async () => {
    const controller = createCloseEventController();
    const code = await new Promise<number>((resolve) => {
      controller.event((nextCode) => resolve(nextCode));
      controller.fire(17);
    });
    expect(code).toBe(17);
  });

  it("replays the close code when subscribing after the fire", async () => {
    const controller = createCloseEventController();
    controller.fire(0);
    const code = await new Promise<number>((resolve) => {
      controller.event((nextCode) => resolve(nextCode));
    });
    expect(code).toBe(0);
  });

  it("fires once and never lets later fires overwrite the first result", async () => {
    const controller = createCloseEventController();
    controller.fire(1);
    controller.fire(2);
    const code = await new Promise<number>((resolve) => {
      controller.event((nextCode) => resolve(nextCode));
    });
    expect(code).toBe(1);
  });
});
