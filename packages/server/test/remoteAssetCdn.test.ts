import { describe, expect, it } from "vitest";
import {
  buildComponentArtifactUrlCandidates,
  buildReleaseAssetUrlCandidates,
} from "@zcode/server/remote/remoteAssetCdn.js";

describe("remoteAssetCdn URL encoding", () => {
  it("encodes '+' in component paths as %2B", () => {
    const urls = buildComponentArtifactUrlCandidates(
      ["https://cdn.example.com/zcode/electron/releases/1.3.0"],
      "components/linux-arm64/server-bundle/v1.3.0+7138ea7a9b45.tar.gz",
      "1.3.0",
    );

    expect(urls).toEqual([
      "https://cdn.example.com/zcode/electron/releases/components/linux-arm64/server-bundle/v1.3.0%2B7138ea7a9b45.tar.gz",
      "https://cdn.example.com/zcode/electron/releases/1.3.0/components/linux-arm64/server-bundle/v1.3.0%2B7138ea7a9b45.tar.gz",
    ]);
  });

  it("falls back from the versioned manifest base to the cross-version components root", () => {
    const urls = buildComponentArtifactUrlCandidates(
      [
        "https://cdn.example.com/zcode/electron/releases/1.3.0",
        "https://backup.example.com/zcode/electron/releases/1.3.0",
      ],
      "components/linux-arm64/server-bundle/v1.3.0.tar.gz",
      "1.3.0",
    );

    expect(urls).toEqual([
      "https://cdn.example.com/zcode/electron/releases/components/linux-arm64/server-bundle/v1.3.0.tar.gz",
      "https://cdn.example.com/zcode/electron/releases/1.3.0/components/linux-arm64/server-bundle/v1.3.0.tar.gz",
      "https://backup.example.com/zcode/electron/releases/components/linux-arm64/server-bundle/v1.3.0.tar.gz",
      "https://backup.example.com/zcode/electron/releases/1.3.0/components/linux-arm64/server-bundle/v1.3.0.tar.gz",
    ]);
  });

  it("does not double-encode already-encoded paths", () => {
    const urls = buildReleaseAssetUrlCandidates(
      ["https://cdn.example.com/zcode/electron/releases/1.3.0"],
      ["components/linux-arm64/server-bundle/v1.3.0%2B7138ea7a9b45.tar.gz"],
    );

    expect(urls).toEqual([
      "https://cdn.example.com/zcode/electron/releases/1.3.0/components/linux-arm64/server-bundle/v1.3.0%2B7138ea7a9b45.tar.gz",
    ]);
  });
});
