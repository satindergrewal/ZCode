import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  fork: vi.fn(),
  registerService: vi.fn(async () => {
    throw new Error("service manager unavailable");
  }),
  unregisterService: vi.fn(async () => undefined),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  fork: serviceMocks.fork,
}));

vi.mock("../src/platform/serviceManager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform/serviceManager.js")>()),
  registerService: serviceMocks.registerService,
  unregisterService: serviceMocks.unregisterService,
}));

import { runServerCli } from "../src/cli.js";
import { createControlServer } from "../src/ipc/controlServer.js";
import { createServiceDescriptor } from "../src/platform/serviceManager.js";
import { resolveCanonicalServerLayout, resolveServerLayout } from "../src/runtime/paths.js";
import { DataRootLock } from "../src/runtime/lock.js";

async function writeStatusSnapshot(statusFile: string, status: unknown): Promise<void> {
  // Bug cause: a plain writeFile(status.json) truncates before writing, so waitForServerStopped can read invalid JSON mid-flight.
  // Use the same temp-file-plus-rename atomic swap as the production status persister so tests never fabricate corruption production cannot produce.
  const temporary = `${statusFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.test.tmp`;
  await writeFile(temporary, `${JSON.stringify(status)}\n`, "utf8");
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, statusFile);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const retryDelay = [25, 50, 100, 200, 400][attempt];
        if (
          retryDelay === undefined ||
          (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

describe("daemon service registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns registration failure without starting a disguised fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-daemon-registration-"));
    const errors: string[] = [];
    vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "0");

    const exit = await runServerCli(["serve", "--daemon", "--server-root", join(root, "server")], {
      stderr: { write: (value) => errors.push(value) },
    });

    expect(exit).toBe(1);
    expect(errors.join("")).toContain("service manager unavailable");
    expect(serviceMocks.registerService).toHaveBeenCalledOnce();
    expect(serviceMocks.fork).not.toHaveBeenCalled();
  });

  it("stops and unregisters a same-root legacy service before registering the root-scoped identity", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zdr-"));
    const layout = resolveServerLayout(join(root, "server"));
    const platform =
      process.platform === "darwin" || process.platform === "linux" ? process.platform : "win32";
    const kind =
      platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : "task-scheduler";
    const legacyDescriptor = createServiceDescriptor({
      platform,
      command: join(layout.stableBinDir, platform === "win32" ? "zcode.cmd" : "zcode"),
      args: ["serve", "--supervisor", "--server-root", layout.serverRoot],
    });
    await mkdir(layout.serviceDir, { recursive: true });
    await writeFile(join(layout.serviceDir, `${kind}.service`), legacyDescriptor.content, "utf8");
    const readyStatus = {
      protocolVersion: 1 as const,
      state: "ready" as const,
      pid: 42,
      port: 43123,
      host: "127.0.0.1",
      version: "test",
      generation: 1,
      startedAt: Date.now(),
      lastExitReason: null,
      serviceRegistered: true,
      runningTaskCount: 0,
      crashBudget: { crashCount: 0, nextRestartDelayMs: 0, exhausted: false },
      updatedAt: Date.now(),
    };
    const commands: string[] = [];
    let stopCompleted: Promise<void> = Promise.resolve();
    const fallbackLock = new DataRootLock(layout.lockFile);
    await fallbackLock.acquire();
    let lockAtRegistration: Awaited<ReturnType<DataRootLock["inspect"]>> | undefined;
    serviceMocks.registerService.mockImplementationOnce(async () => {
      lockAtRegistration = await new DataRootLock(layout.lockFile).inspect();
      throw new Error("service manager unavailable");
    });
    await writeStatusSnapshot(layout.statusFile, {
      ...readyStatus,
      state: "stopped",
      pid: null,
      updatedAt: readyStatus.updatedAt,
    });
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      commands.push(request.command);
      if (request.command === "status") return readyStatus;
      if (request.command === "stop") {
        // Fix reason: the old fixture fired and forgot the status write, so the rename could still run after teardown,
        // raising an unhandled EPERM on Windows and starved the CLI's lock wait. Hold the full stop lifecycle explicitly.
        stopCompleted = new Promise((resolve) => setTimeout(resolve, 100)).then(async () => {
          await writeStatusSnapshot(layout.statusFile, {
            ...readyStatus,
            state: "stopped",
            pid: null,
            updatedAt: Date.now() + 1,
          });
          await fallbackLock.release();
        });
        return { stopping: true };
      }
      throw new Error(`Unexpected command: ${request.command}`);
    });
    const errors: string[] = [];
    vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "0");
    try {
      const exit = await runServerCli(["serve", "--daemon", "--server-root", layout.serverRoot], {
        stderr: { write: (value) => errors.push(value) },
      });
      expect(exit).toBe(1);
      expect(errors.join("")).toContain("service manager unavailable");
      expect(commands).toEqual(["status", "stop"]);
      const canonicalLayout = await resolveCanonicalServerLayout(layout.serverRoot);
      expect(serviceMocks.unregisterService).toHaveBeenCalledWith(
        expect.objectContaining({ name: "com.zhipu.zcode.server" }),
        join(canonicalLayout.serviceDir, `${kind}.service`),
      );
      expect(serviceMocks.registerService).toHaveBeenCalledOnce();
    } finally {
      await stopCompleted;
      await control.close();
      await fallbackLock.release();
    }
    expect(lockAtRegistration?.state).toMatch(/missing|stale/);
  });
});
