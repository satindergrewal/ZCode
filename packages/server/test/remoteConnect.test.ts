import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Emitter, ChannelClient, SocketProtocol, type IDisposable, type Event } from "@zcode/rpc";
import { ZCODE_VERSION, TOPIC_RESOURCE_RELAY_CHANNEL } from "@zcode/shared";
import { wrapStdioStream } from "../src/remote/stdio-socket.js";
import { connectRemote, pickRemoteRuntimeEnv } from "../src/remote/connect.js";
import type { IRemoteBackend, RemoteDisconnectEvent, StdioStream } from "../src/remote/backend.js";

class FakeConnectBackend implements IRemoteBackend {
  stream?: StdioStream;
  readonly commands: string[] = [];
  disposeCount = 0;
  private readonly closeListeners: Array<(code: number) => void> = [];
  private readonly disconnectEmitter = new Emitter<RemoteDisconnectEvent>();

  readonly onDidDisconnect = this.disconnectEmitter.event;

  constructor(
    private readonly launchFailure?: {
      code: number;
      stderr: string;
    },
  ) {}

  dispose(): void {
    this.disposeCount += 1;
    this.disconnectEmitter.dispose();
  }

  async detect() {
    return { platform: "linux", arch: "arm64" };
  }

  async upload(): Promise<void> {}

  async exec(command: string): Promise<StdioStream> {
    this.commands.push(command);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const onClose: Event<number> = (listener): IDisposable => {
      this.closeListeners.push(listener);
      return {
        dispose: () => {
          const index = this.closeListeners.indexOf(listener);
          if (index >= 0) {
            this.closeListeners.splice(index, 1);
          }
        },
      };
    };

    if (this.launchFailure) {
      setTimeout(() => {
        stderr.write(this.launchFailure?.stderr);
        this.fireStreamClose(this.launchFailure?.code ?? 1);
      }, 0);
    } else {
      queueMicrotask(() => {
        stdout.write(
          `${JSON.stringify({
            type: "zcode-hello",
            version: ZCODE_VERSION,
            platform: "linux",
            arch: "arm64",
            pid: 123,
          })}\n`,
        );
      });
    }

    this.stream = { stdin, stdout, stderr, onClose };
    return this.stream;
  }

  async exists(): Promise<boolean> {
    return true;
  }

  async readFile(): Promise<string> {
    return `${ZCODE_VERSION}\n`;
  }

  async resolveRuntimeProxy(proxyUrl: string): Promise<string> {
    return proxyUrl;
  }

  fireStreamClose(code: number): void {
    for (const listener of this.closeListeners) {
      listener(code);
    }
  }

  fireDisconnect(event: RemoteDisconnectEvent): void {
    this.disconnectEmitter.fire(event);
  }
}

describe("connectRemote", () => {
  it("serves a private reverse channel on the existing stdio connection", async () => {
    const backend = new FakeConnectBackend();
    const call = vi.fn(async () => ({ valid: true }));
    const connection = await connectRemote(backend, {
      clientId: "test-client",
      skipDeploy: true,
      topicResourceChannel: {
        call,
        listen() {
          throw new Error("No events");
        },
      },
    });
    const stream = backend.stream!;
    // hello-ack is a text handshake; the reverse RPC reuses the raw byte stream that follows it.
    const stdin = stream.stdin as PassThrough;
    const buffered = stdin.read() as Buffer;
    const boundary = buffered.indexOf(10) + 1;
    const remaining = buffered.subarray(boundary);
    const inverse = wrapStdioStream({
      ...stream,
      stdin: stream.stdout as PassThrough,
      stdout: stdin,
    });
    const protocol = new SocketProtocol(inverse);
    const remote = new ChannelClient(protocol);
    if (remaining.length) stdin.unshift(remaining);
    try {
      expect(
        await remote.getChannel(TOPIC_RESOURCE_RELAY_CHANNEL).call("validate", { taskId: "task" }),
      ).toEqual({ valid: true });
      expect(call).toHaveBeenCalledOnce();
    } finally {
      remote.dispose();
      connection.dispose();
    }
  });
  it("forwards Desktop SP rollout results to the remote server but drops non-allowlisted vars", () => {
    expect(
      pickRemoteRuntimeEnv({
        ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED: "1",
        ZCODE_OAUTH_TOKEN: "secret",
      }),
    ).toEqual({
      ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED: "1",
    });
  });

  // DWG-06 (docs/dynamic-workflow/launch.md "Gray release"): the Dynamic Workflow tier is
  // written by Desktop Main and the remote Host must observe the same value so preview-package remote workspaces match local.
  it("forwards the Desktop Main Dynamic Workflow rollout tier", () => {
    expect(
      pickRemoteRuntimeEnv({
        ZCODE_DYNAMIC_WORKFLOW_MODE: "alwaysOn",
        ZCODE_OAUTH_TOKEN: "secret",
      }),
    ).toEqual({
      ZCODE_DYNAMIC_WORKFLOW_MODE: "alwaysOn",
    });
    // Main drops this key in production builds, so the remote receives nothing.
    expect(pickRemoteRuntimeEnv({})).toEqual({});
  });

  it("releases the backend when connection setup fails", async () => {
    const backend = new FakeConnectBackend();
    vi.spyOn(backend, "detect").mockRejectedValueOnce(new Error("detect failed"));

    await expect(
      connectRemote(backend, { clientId: "test-client", skipDeploy: true }),
    ).rejects.toThrow("detect failed");
    expect(backend.disposeCount).toBe(1);
  });

  it("rejects immediately and releases the backend when setup is cancelled mid-flight", async () => {
    const backend = new FakeConnectBackend();
    vi.spyOn(backend, "detect").mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const outcome = connectRemote(backend, {
      clientId: "test-client",
      signal: controller.signal,
      skipDeploy: true,
    }).then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({
        kind: "rejected" as const,
        name: error instanceof Error ? error.name : "UnknownError",
      }),
    );

    controller.abort();
    await Promise.resolve();
    await Promise.resolve();

    await expect(
      Promise.race([
        outcome,
        new Promise<{ kind: "pending" }>((resolve) => {
          setTimeout(() => resolve({ kind: "pending" }), 10);
        }),
      ]),
    ).resolves.toEqual({ kind: "rejected", name: "AbortError" });
    expect(backend.disposeCount).toBe(1);
  });

  it("never starts the remote server from a late detect result after cancellation", async () => {
    const backend = new FakeConnectBackend();
    let resolveDetect!: (value: { platform: string; arch: string }) => void;
    vi.spyOn(backend, "detect").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDetect = resolve;
        }),
    );
    const controller = new AbortController();
    const connecting = connectRemote(backend, {
      clientId: "test-client",
      signal: controller.signal,
      skipDeploy: true,
    });

    controller.abort();
    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    resolveDetect({ platform: "linux", arch: "arm64" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(backend.commands).toEqual([]);
  });

  it("closes stdin first in disposeAndWait, then awaits the remote stdio close", async () => {
    const backend = new FakeConnectBackend();
    const connection = await connectRemote(backend, {
      clientId: "test-client",
      skipDeploy: true,
    });

    let settled = false;
    const disposing = connection.disposeAndWait({ timeoutMs: 1_000 }).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(backend.disposeCount).toBe(0);

    backend.fireStreamClose(0);
    await disposing;
    expect(settled).toBe(true);
    expect(backend.disposeCount).toBe(1);
  });

  it("force-releases the backend when the disposeAndWait wait times out", async () => {
    vi.useFakeTimers();
    try {
      const backend = new FakeConnectBackend();
      const connection = await connectRemote(backend, {
        clientId: "test-client",
        skipDeploy: true,
      });

      const disposing = connection.disposeAndWait({ timeoutMs: 250 });
      await vi.advanceTimersByTimeAsync(250);
      await disposing;

      expect(backend.disposeCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no longer injects the retired proxy runtime env vars when starting the remote server", async () => {
    const backend = new FakeConnectBackend();
    const retiredProxyEnvName = ["ZCODE", `${"A"}${"CP"}`, "PROXY", "RUNTIME", "PATH"].join("_");

    const connection = await connectRemote(backend, {
      clientId: "test-client",
      skipDeploy: true,
    });
    connection.dispose();

    expect(backend.commands[0]).toContain('ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcode/server"');
    expect(backend.commands[0]).not.toContain(retiredProxyEnvName);
  });

  it("injectes the service-authoritative mode for desktop-attached remote servers", async () => {
    const backend = new FakeConnectBackend();

    const connection = await connectRemote(backend, {
      clientId: "test-client",
      skipDeploy: true,
    });
    connection.dispose();

    expect(backend.commands[0]).toContain('ZCODE_SERVICE_AUTHORITY_MODE="desktop-attached-remote"');
  });

  it("shell-quotes the app version when injecting it into the remote server command", async () => {
    const backend = new FakeConnectBackend();

    const connection = await connectRemote(backend, {
      appVersion: "2.13.1+build'7",
      clientId: "test-client",
      skipDeploy: true,
    });
    connection.dispose();

    expect(backend.commands[0]).toContain(`ZCODE_APP_VERSION='2.13.1+build'"'"'7'`);
  });

  it("injects only allowlisted test-env endpoint vars into the remote server", async () => {
    const backend = new FakeConnectBackend();

    const connection = await connectRemote(backend, {
      clientId: "test-client",
      skipDeploy: true,
      remoteRuntimeEnv: {
        ZCODE_ENV: "test",
        ZCODE_BASE_URL: "https://zcode.z.ai/api/v1",
        ZAI_OAUTH_ORIGIN: "https://chat.z.ai",
        ZAI_OAUTH_CLIENT_ID: "client_'test",
        ZAI_OAUTH_APP_SECRET: "must-not-cross-ssh",
      },
    });
    connection.dispose();

    expect(backend.commands[0]).toContain("ZCODE_ENV='test'");
    expect(backend.commands[0]).toContain("ZCODE_BASE_URL='https://zcode.z.ai/api/v1'");
    expect(backend.commands[0]).toContain("ZAI_OAUTH_ORIGIN='https://chat.z.ai'");
    expect(backend.commands[0]).toContain(`ZAI_OAUTH_CLIENT_ID='client_'"'"'test'`);
    expect(backend.commands[0]).not.toContain("ZAI_OAUTH_APP_SECRET");
    expect(backend.commands[0]).not.toContain("must-not-cross-ssh");
  });

  it("injects only the explicit WSL runtime proxy into the remote server command", async () => {
    const backend = new FakeConnectBackend();
    const resolveRuntimeProxy = vi
      .spyOn(backend, "resolveRuntimeProxy")
      .mockResolvedValue("http://172.21.240.1:7890/");

    const connection = await connectRemote(backend, {
      clientId: "test-client",
      skipDeploy: true,
      remoteRuntimeNetwork: {
        authoritative: true,
        httpProxy: "http://127.0.0.1:7890",
        noProxy: "localhost,127.0.0.1",
      },
    });
    connection.dispose();

    expect(resolveRuntimeProxy).toHaveBeenCalledWith("http://127.0.0.1:7890");
    expect(backend.commands[0]).toContain("ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY='1'");
    expect(backend.commands[0]).toContain("ZCODE_REMOTE_HTTP_PROXY='http://172.21.240.1:7890/'");
    expect(backend.commands[0]).toContain("ZCODE_REMOTE_NO_PROXY='localhost,127.0.0.1'");
  });

  it("reports the remote close on backend loss even while stdio stays open", async () => {
    const backend = new FakeConnectBackend();
    const closeEvents: Array<{ code: number }> = [];

    const connection = await connectRemote(backend, {
      clientId: "test-client",
      skipDeploy: true,
      onDidRemoteClose: (event) => {
        closeEvents.push(event);
      },
    });

    backend.fireDisconnect({ reason: "close" });

    expect(closeEvents).toEqual([{ code: -1 }]);

    connection.dispose();
  });

  it("reports once when backend loss and stdio close land together", async () => {
    const backend = new FakeConnectBackend();
    const closeEvents: Array<{ code: number }> = [];

    const connection = await connectRemote(backend, {
      clientId: "test-client",
      skipDeploy: true,
      onDidRemoteClose: (event) => {
        closeEvents.push(event);
      },
    });

    backend.fireDisconnect({ reason: "error", error: new Error("socket reset") });
    backend.fireStreamClose(7);

    expect(closeEvents).toEqual([{ code: -1 }]);

    connection.dispose();
  });

  it("logs error details on backend-error disconnects", async () => {
    const backend = new FakeConnectBackend();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const connection = await connectRemote(backend, {
      clientId: "test-client",
      skipDeploy: true,
    });

    try {
      backend.fireDisconnect({ reason: "error", error: new Error("socket reset") });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[connectRemote]"),
        expect.stringContaining("socket reset"),
      );
    } finally {
      connection.dispose();
      logSpy.mockRestore();
    }
  });

  it("surfaces stderr and the exit code when the remote server dies before the handshake", async () => {
    const backend = new FakeConnectBackend({
      code: 126,
      stderr: "/bin/sh: 1: /root/.zcode/server/node: Text file busy\n",
    });

    await expect(
      connectRemote(backend, {
        clientId: "test-client",
        skipDeploy: true,
      }),
    ).rejects.toThrow(/Stream closed before handshake completed.*exit code 126.*Text file busy/s);
  });
});
