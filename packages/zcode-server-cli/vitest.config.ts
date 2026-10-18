import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Bug fix: root `tsc -b` writes composite artifacts into dist, and the default vitest include once
    // re-ran compiled copies under dist/test (stale artifacts could also false-positive). Collect source tests only.
    include: ["test/**/*.test.ts"],
    // Integration cases may wait out a real Supervisor/Core start; this package script must share the root config's
    // limit so a loaded machine does not get cut off by Vitest's default 5s timeout first.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // This package's integration cases really start tsx/Supervisor/Core; running the package script standalone must also
    // run serially so concurrent start pressure never flips the ready barrier, while keeping in-process
    // mock semantics (forks workers change timing of some node module mocks).
    pool: "threads",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
