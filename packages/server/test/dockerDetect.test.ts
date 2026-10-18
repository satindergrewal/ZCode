import { describe, expect, it } from "vitest";
import { parseDockerContainerList, resolveDockerCommand } from "../src/remote/docker-detect.js";

describe("docker detect", () => {
  it("falls back to common macOS install paths when the GUI PATH lacks docker", () => {
    const command = resolveDockerCommand({
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      homeDir: "/Users/demo",
      isExecutable: (candidate) => candidate === "/usr/local/bin/docker",
      platform: "darwin",
    });

    expect(command).toBe("/usr/local/bin/docker");
  });

  it("prefers the PATH binary when docker is already on the PATH", () => {
    const command = resolveDockerCommand({
      env: { PATH: "/custom/bin:/usr/local/bin" },
      homeDir: "/Users/demo",
      isExecutable: (candidate) => candidate === "/custom/bin/docker",
      platform: "darwin",
    });

    expect(command).toBe("/custom/bin/docker");
  });

  it("preserves Docker JSON line parsing", () => {
    const containers = parseDockerContainerList(
      [
        JSON.stringify({
          ID: "931b148d01e8",
          Image: "ubuntu:24.04",
          Names: "zcode-ssh-linux-amd64",
          State: "running",
          Status: "Up 2 minutes",
        }),
        "",
      ].join("\n"),
    );

    expect(containers).toEqual([
      {
        id: "931b148d01e8",
        image: "ubuntu:24.04",
        name: "zcode-ssh-linux-amd64",
        state: "running",
        status: "Up 2 minutes",
      },
    ]);
  });
});
