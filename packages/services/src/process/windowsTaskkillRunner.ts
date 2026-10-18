import { execFile } from "node:child_process";
import type { WindowsTaskkillRunner } from "#src/process/processTreeTypes.js";

export const defaultWindowsTaskkillRunner: WindowsTaskkillRunner = ({ force, pid, timeoutMs }) =>
  new Promise((resolve) => {
    // On multi-workspace shutdown a synchronous taskkill would block the host per agent;
    // the async runner lets trees wind down concurrently, results feeding the awaiting state machine.
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
      (error, _stdout, stderr) => {
        resolve({ ...(error ? { error } : {}), ...(stderr ? { stderr } : {}) });
      },
    );
  });
