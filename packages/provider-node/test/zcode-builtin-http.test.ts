import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { downloadZCodeBuiltinRelease } from "../src/zcode-builtin-download.js";

it("closes the connection at the 20s budget when headers landed but the body stalls, leaving the next try free", async () => {
  let closed = false;
  let finish = false;
  const release = {
    schemaVersion: 1,
    revision: 1,
    config: {
      providerConfigRules: { templateRules: [], providerRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  };
  const server = createServer((req, res) => {
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
    if (req.url?.startsWith("/api/v1/client/configs")) {
      res.end(
        JSON.stringify({
          code: 0,
          data: { configs: { builtin_provider_config_json: "https://cdn.example/test.json" } },
        }),
      );
      return;
    }
    if (finish) {
      res.end(JSON.stringify(release));
      return;
    }
    res.writeHead(200);
    res.write("{");
    res.on("close", () => {
      closed = true;
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Only the test transport destination is swapped; production HTTPS checks stay. This case proves real socket/body cancellation.
  const options = {
    endpointOrigin: origin,
    appVersion: "test",
    platform: "test",
    request: (url: string | URL, init: RequestInit) =>
      fetch(String(url).startsWith("https://cdn.example") ? `${origin}/cdn` : url, init),
  };
  try {
    const start = Date.now();
    await expect(downloadZCodeBuiltinRelease(options)).rejects.toThrow("cdn: timeout");
    expect(Date.now() - start).toBeLessThan(23_000);
    await vi.waitFor(() => expect(closed).toBe(true));
    finish = true;
    await expect(downloadZCodeBuiltinRelease(options)).resolves.toMatchObject({ revision: 1 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 28_000);
