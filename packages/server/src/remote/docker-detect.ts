import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { DockerContainerInfo } from "@zcode/shared";
export type { DockerContainerInfo } from "@zcode/shared";

const DOCKER_COMMAND = "docker";
const DOCKER_EXEC_MAX_BUFFER = 8 * 1024 * 1024;

type DockerCommandResolutionOptions = {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  isExecutable?: (candidate: string) => boolean;
  platform?: NodeJS.Platform;
};

function normalizeDockerOutput(raw: string): string {
  return raw.replace(/\r/g, "");
}

function defaultIsExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getPathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function joinExecutablePath(
  platform: NodeJS.Platform,
  directory: string,
  executableName: string,
): string {
  return platform === "win32"
    ? win32.join(directory, executableName)
    : posix.join(directory, executableName);
}

function getDockerExecutableNames(platform: NodeJS.Platform): string[] {
  return platform === "win32"
    ? ["docker.exe", "docker.cmd", "docker.bat", DOCKER_COMMAND]
    : [DOCKER_COMMAND];
}

function getFallbackDockerCommands(platform: NodeJS.Platform, userHomeDir: string): string[] {
  if (platform === "darwin") {
    return [
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker",
      "/Applications/OrbStack.app/Contents/MacOS/xbin/docker",
      posix.join(userHomeDir, ".orbstack/bin/docker"),
      "/Applications/Docker.app/Contents/Resources/bin/docker",
    ];
  }

  if (platform === "linux") {
    return ["/usr/local/bin/docker", "/usr/bin/docker", "/snap/bin/docker"];
  }

  if (platform === "win32") {
    return [
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "C:\\ProgramData\\DockerDesktop\\version-bin\\docker.exe",
    ];
  }

  return [];
}

export function resolveDockerCommand(options: DockerCommandResolutionOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const pathValue = env.PATH ?? "";
  const pathDelimiter = getPathDelimiter(platform);

  for (const directory of pathValue.split(pathDelimiter)) {
    const trimmedDirectory = directory.trim();
    if (!trimmedDirectory) {
      continue;
    }

    for (const executableName of getDockerExecutableNames(platform)) {
      const candidate = joinExecutablePath(platform, trimmedDirectory, executableName);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  // macOS GUI apps launched from Dock/Finder usually do not inherit the shell
  // PATH, while the OrbStack/Docker Desktop docker wrapper still sits at those
  // stable locations. Check PATH, then common install locations, so a healthy
  // daemon is not misread as "Docker unavailable".
  for (const candidate of getFallbackDockerCommands(platform, options.homeDir ?? homedir())) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return DOCKER_COMMAND;
}

async function execDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveDockerCommand(),
      args,
      {
        encoding: "utf8",
        maxBuffer: DOCKER_EXEC_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(normalizeDockerOutput(stderr).trim() || error.message));
          return;
        }

        resolve(normalizeDockerOutput(stdout));
      },
    );
  });
}

export function parseDockerContainerList(rawOutput: string): DockerContainerInfo[] {
  return normalizeDockerOutput(rawOutput)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as {
          ID?: string;
          Image?: string;
          Names?: string;
          State?: string;
          Status?: string;
        };

        if (!parsed.ID || !parsed.Names) {
          return [];
        }

        return [
          {
            id: parsed.ID,
            image: parsed.Image ?? "",
            name: parsed.Names,
            state: parsed.State ?? "",
            status: parsed.Status ?? "",
          },
        ];
      } catch {
        return [];
      }
    });
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execDocker(["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    // Availability used to mean only "the docker binary exists", so a stopped
    // daemon still looked usable and the UI kept the Docker entry until connect
    // time failed. Any probe failure now returns false, keeping the entry state
    // honest about actual connectability.
    return false;
  }
}

export async function listDockerContainers(options?: {
  all?: boolean;
}): Promise<DockerContainerInfo[]> {
  const args = ["ps"];
  if (options?.all) {
    args.push("-a");
  }
  args.push("--format", "{{json .}}");

  const output = await execDocker(args);
  return parseDockerContainerList(output);
}
