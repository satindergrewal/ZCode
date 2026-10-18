import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  isWSLAvailable: vi.fn(),
  listWSLDistros: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

vi.mock("@zcode/server/remote/wsl-detect.js", () => ({
  isWSLAvailable: mocks.isWSLAvailable,
  listWSLDistros: mocks.listWSLDistros,
}));

import { WSLBackend, buildWslArgs } from "../src/remote/wsl-backend.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function createSpawnChild(options?: { closeOnStdinFinish?: boolean }) {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    stderr: PassThrough;
    stdin: PassThrough;
    stdout: PassThrough;
  };
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close", 1));
    return true;
  });
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.resume();
  if (options?.closeOnStdinFinish !== false) {
    child.stdin.on("finish", () => queueMicrotask(() => child.emit("close", 0)));
  }
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  mocks.execFile.mockReset();
  mocks.isWSLAvailable.mockReset();
  mocks.listWSLDistros.mockReset();
  mocks.spawn.mockReset();
  mocks.isWSLAvailable.mockResolvedValue(true);
  mocks.listWSLDistros.mockResolvedValue([
    { isDefault: true, name: "Ubuntu-24.04", state: "Running", version: 2 },
  ]);
  mocks.execFile.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
    ) => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        callback(null, Buffer.from("Ubuntu-24.04\ntester\n/home/tester"), Buffer.alloc(0));
        child.emit("close", 0);
      });
      return child as never;
    },
  );
  mocks.spawn.mockImplementation(() => createSpawnChild());
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

describe("buildWslArgs", () => {
  it("reaps via disposeAndWait the wsl.exe that execFile spawned during detect", async () => {
    let child!: EventEmitter & { kill: ReturnType<typeof vi.fn>; stdin: null };
    mocks.execFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        child = Object.assign(new EventEmitter(), {
          stdin: null,
          kill: vi.fn(() => {
            callback(new Error("killed"), Buffer.alloc(0), Buffer.alloc(0));
            child.emit("close", 1);
            return true;
          }),
        });
        return child as never;
      },
    );
    mocks.isWSLAvailable.mockImplementationOnce(
      async (executor: (args: string[]) => Promise<Buffer>) => {
        await executor(["--status"]);
        return true;
      },
    );
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });
    const detecting = backend.detect();
    const detectionError = detecting.catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    try {
      const disposing = backend.disposeAndWait({ graceTimeoutMs: 300, killWaitTimeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(300);
      await disposing;

      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(mocks.execFile.mock.calls.flatMap((call) => call[1] as string[])).not.toContain(
        "--terminate",
      );
      await expect(detectionError).resolves.toMatchObject({ message: "killed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaps via disposeAndWait the wsl.exe that execFile spawned for the distro list", async () => {
    let child!: EventEmitter & { kill: ReturnType<typeof vi.fn>; stdin: null };
    mocks.execFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        child = Object.assign(new EventEmitter(), {
          stdin: null,
          kill: vi.fn(() => {
            callback(new Error("list killed"), Buffer.alloc(0), Buffer.alloc(0));
            child.emit("close", 1);
            return true;
          }),
        });
        return child as never;
      },
    );
    mocks.listWSLDistros.mockImplementationOnce(
      async (executor: (args: string[]) => Promise<Buffer>) => {
        await executor(["-l", "-v", "--all"]);
        return [];
      },
    );
    const backend = new WSLBackend({ kind: "wsl" });
    const detecting = backend.detect();
    const detectionError = detecting.catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    try {
      const disposing = backend.disposeAndWait({ graceTimeoutMs: 300, killWaitTimeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(300);
      await disposing;

      expect(child.kill).toHaveBeenCalledTimes(1);
      await expect(detectionError).resolves.toMatchObject({
        message: "WSL backend disposed; cannot start new commands",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to start new WSL children once disposal began", async () => {
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await backend.disposeAndWait();

    await expect(backend.exec("zcode-server")).rejects.toThrow("WSL backend disposed");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("starts no WSL children after disposal completes with discovery pending", async () => {
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });
    await backend.resolveIdentity();
    let resumeDiscovery!: (available: boolean) => void;
    mocks.isWSLAvailable.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resumeDiscovery = resolve;
        }),
    );

    const executing = backend.exec("zcode-server");
    await vi.waitFor(() => expect(mocks.isWSLAvailable).toHaveBeenCalledTimes(2));
    await backend.disposeAndWait();
    resumeDiscovery(true);

    await expect(executing).rejects.toThrow("WSL backend disposed");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("reaps only the wsl.exe children this backend created", async () => {
    let usingFakeTimers = false;
    try {
      let child!: ReturnType<typeof createSpawnChild>;
      mocks.spawn.mockImplementationOnce(() => {
        child = createSpawnChild({ closeOnStdinFinish: false });
        return child;
      });
      const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

      await backend.exec("zcode-server");
      vi.useFakeTimers();
      usingFakeTimers = true;
      const disposing = backend.disposeAndWait({ graceTimeoutMs: 300, killWaitTimeoutMs: 100 });

      expect(child.stdin.writableEnded).toBe(true);
      expect(child.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(300);
      await disposing;
      expect(child.kill).toHaveBeenCalledTimes(1);
    } finally {
      if (usingFakeTimers) {
        vi.useRealTimers();
      }
    }
  });

  it("skips kill when the child exits cleanly after EOF", async () => {
    let child!: ReturnType<typeof createSpawnChild>;
    mocks.spawn.mockImplementationOnce(() => {
      child = createSpawnChild();
      return child;
    });
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await backend.exec("zcode-server");
    await backend.disposeAndWait({ graceTimeoutMs: 300, killWaitTimeoutMs: 100 });

    expect(child.kill).not.toHaveBeenCalled();
  });

  it("uses the default distro user when no WSL user is provided", () => {
    expect(buildWslArgs(["bash", "-lc", "pwd"], "Ubuntu-24.04", null)).toEqual([
      "-d",
      "Ubuntu-24.04",
      "--",
      "bash",
      "-lc",
      "pwd",
    ]);
  });

  it("resolves the canonical distro name and actual Linux user", async () => {
    const backend = new WSLBackend({ kind: "wsl", distro: "ubuntu-24.04" });

    await expect(backend.resolveIdentity()).resolves.toEqual({
      distro: "Ubuntu-24.04",
      user: "tester",
    });
    expect(mocks.execFile).toHaveBeenCalledWith(
      "wsl.exe",
      expect.arrayContaining(["-d", "Ubuntu-24.04", "bash", "-lc"]),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("passes an explicit WSL user to wsl.exe", () => {
    expect(buildWslArgs(["bash", "-lc", "pwd"], "Ubuntu-24.04", "root")).toEqual([
      "-d",
      "Ubuntu-24.04",
      "-u",
      "root",
      "--",
      "bash",
      "-lc",
      "pwd",
    ]);
  });

  it("rewrites unreachable loopback proxies to the host gateway under WSL NAT", async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        const shellCommand = args.at(-1) ?? "";
        const stdout = shellCommand.includes("/dev/tcp/172.21.240.1/")
          ? "reachable"
          : shellCommand.includes("/dev/tcp/")
            ? "unreachable"
            : shellCommand.includes("ip route show default")
              ? "route=172.21.240.1"
              : "Ubuntu-24.04\ntester\n/home/tester";
        const child = new EventEmitter();
        queueMicrotask(() => {
          callback(null, Buffer.from(stdout), Buffer.alloc(0));
          child.emit("close", 0);
        });
        return child as never;
      },
    );
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await expect(backend.resolveRuntimeProxy("http://127.0.0.1:7890")).resolves.toBe(
      "http://172.21.240.1:7890/",
    );
  });

  it("keeps the loopback proxy under WSL mirrored networking or when it is reachable", async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        const shellCommand = args.at(-1) ?? "";
        const stdout = shellCommand.includes("/dev/tcp/")
          ? "reachable"
          : "Ubuntu-24.04\ntester\n/home/tester";
        const child = new EventEmitter();
        queueMicrotask(() => {
          callback(null, Buffer.from(stdout), Buffer.alloc(0));
          child.emit("close", 0);
        });
        return child as never;
      },
    );
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await expect(backend.resolveRuntimeProxy("http://localhost:7890")).resolves.toBe(
      "http://localhost:7890/",
    );
  });

  it("leaves non-loopback proxies and proxy credentials untouched", async () => {
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await expect(
      backend.resolveRuntimeProxy("http://user:pass@proxy.example.com:7890/path"),
    ).resolves.toBe("http://user:pass@proxy.example.com:7890/path");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("keeps the loopback config when the gateway probe cannot confirm the port", async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        const shellCommand = args.at(-1) ?? "";
        const stdout = shellCommand.includes("/dev/tcp/")
          ? "unreachable"
          : shellCommand.includes("ip route show default")
            ? "route=172.21.240.1"
            : "Ubuntu-24.04\ntester\n/home/tester";
        const child = new EventEmitter();
        queueMicrotask(() => {
          callback(null, Buffer.from(stdout), Buffer.alloc(0));
          child.emit("close", 0);
        });
        return child as never;
      },
    );
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await expect(backend.resolveRuntimeProxy("http://127.0.0.1:7890")).resolves.toBe(
      "http://127.0.0.1:7890/",
    );
  });

  it("lets the systemd-resolved loopback stub fall through to the resolv.conf fallback", async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        const shellCommand = args.at(-1) ?? "";
        const stdout = shellCommand.includes("/dev/tcp/172.21.240.1/")
          ? "reachable"
          : shellCommand.includes("/dev/tcp/")
            ? "unreachable"
            : shellCommand.includes("ip route show default")
              ? "resolv=127.0.0.53 resolv=172.21.240.1"
              : "Ubuntu-24.04\ntester\n/home/tester";
        const child = new EventEmitter();
        queueMicrotask(() => {
          callback(null, Buffer.from(stdout), Buffer.alloc(0));
          child.emit("close", 0);
        });
        return child as never;
      },
    );
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await expect(backend.resolveRuntimeProxy("http://127.0.0.1:7890")).resolves.toBe(
      "http://172.21.240.1:7890/",
    );
  });

  it("never probes custom public DNS as the host gateway", async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        const shellCommand = args.at(-1) ?? "";
        const stdout = shellCommand.includes("/dev/tcp/")
          ? "unreachable"
          : shellCommand.includes("ip route show default")
            ? "resolv=8.8.8.8"
            : "Ubuntu-24.04\ntester\n/home/tester";
        const child = new EventEmitter();
        queueMicrotask(() => {
          callback(null, Buffer.from(stdout), Buffer.alloc(0));
          child.emit("close", 0);
        });
        return child as never;
      },
    );
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await expect(backend.resolveRuntimeProxy("http://127.0.0.1:7890")).resolves.toBe(
      "http://127.0.0.1:7890/",
    );
    expect(
      mocks.execFile.mock.calls.some((call) =>
        (call[1] as string[]).at(-1)?.includes("/dev/tcp/8.8.8.8/"),
      ),
    ).toBe(false);
  });

  it("streams via wsl exec pipe and reports bytes with the progress option", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "wsl-upload-progress-"));
    const localPath = join(tempDir, "attachment.bin");
    await writeFile(localPath, Buffer.alloc(80 * 1024, "a"));
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });
    const progress: Array<{ uploadedBytes: number; totalBytes: number }> = [];

    await backend.upload(localPath, "~/.zcode/tmp/attachment.bin", {
      onProgress: (event) => progress.push(event),
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      "wsl.exe",
      [
        "-d",
        "Ubuntu-24.04",
        "-u",
        "tester",
        "--",
        "bash",
        "-lc",
        "mkdir -p '/home/tester/.zcode/tmp' && cat > '/home/tester/.zcode/tmp/attachment.bin'",
      ],
      expect.any(Object),
    );
    expect(progress.at(-1)).toEqual({
      uploadedBytes: 80 * 1024,
      totalBytes: 80 * 1024,
    });
  });

  it("never starts the upload process for an already-cancelled signal", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "wsl-upload-abort-"));
    const localPath = join(tempDir, "attachment.bin");
    await writeFile(localPath, "attachment");
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });
    const controller = new AbortController();
    controller.abort();

    await expect(
      backend.upload(localPath, "~/.zcode/tmp/attachment.bin", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
