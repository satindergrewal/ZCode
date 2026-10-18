import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTelemetryRuntimeOwner } from "@zcode/contracts/telemetry";
import {
  createModelTelemetry,
  parseOtlpHeaders,
  prepareModelTelemetryEnv,
  resolveOtlpMetricEndpoint,
  resolveOtlpTraceEndpoint,
  shutdownPreparedModelTelemetry,
} from "../src/bootstrap.js";
import { NoopAgentExecutionTelemetry } from "../src/agent-trace-runtime.js";

afterEach(async () => {
  await shutdownPreparedModelTelemetry();
});

describe("Telemetry V4 bootstrap", () => {
  it("explicitly injected process owner wins; session close only abandons and flushes", async () => {
    const execution = new NoopAgentExecutionTelemetry();
    const flush = vi.fn(async () => {});
    const shutdown = vi.fn(async () => {});
    const abandon = vi.spyOn(execution, "abandonSession");
    const owner: AgentTelemetryRuntimeOwner = {
      abandonSession: abandon,
      agentExecution: execution,
      enabled: true,
      flush,
      modelExecution: execution,
      shutdown,
      updateIdentity() {},
    };

    const telemetry = createModelTelemetry({ owner, sessionId: "session-1" });
    expect(telemetry.enabled).toBe(true);
    expect(telemetry.agentExecution).toBe(execution);
    await telemetry.shutdown();
    expect(abandon).toHaveBeenCalledWith("session-1");
    expect(flush).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("disabled mode needs no endpoint and still provides a safe noop port", async () => {
    const telemetry = createModelTelemetry();
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.agentExecution.captureCausation()).toBeUndefined();
    await telemetry.shutdown();
  });

  it("honors OTLP traces/metrics/common endpoints and percent-encoded header rules", () => {
    expect(
      resolveOtlpTraceEndpoint({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example/v1/traces",
      }),
    ).toBe("https://arms.example/v1/traces");
    expect(
      resolveOtlpTraceEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://arms.example/otlp/",
      }),
    ).toBe("https://arms.example/otlp/v1/traces");
    expect(
      resolveOtlpMetricEndpoint({
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://arms.example/v1/metrics",
      }),
    ).toBe("https://arms.example/v1/metrics");
    expect(
      resolveOtlpMetricEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://arms.example/otlp/",
      }),
    ).toBe("https://arms.example/otlp/v1/metrics");
    expect(
      resolveOtlpMetricEndpoint({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example/apm/trace/opentelemetry",
      }),
    ).toBe("https://arms.example/apm/trace/opentelemetry");
    expect(parseOtlpHeaders("x-a=one%2Ctwo,x-b=hello%20world")).toEqual({
      "x-a": "one,two",
      "x-b": "hello world",
    });
  });

  it("standalone mode generates and reuses a random installation id asynchronously", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-telemetry-"));
    const env = {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:1/v1/traces",
      ZCODE_HOME: home,
    };
    const [first, second] = await Promise.all([
      prepareModelTelemetryEnv(env, {
        cliVersion: "0.16.1",
        productVersion: "3.6.1",
      }),
      prepareModelTelemetryEnv(env, {
        cliVersion: "0.16.1",
        productVersion: "3.6.1",
      }),
    ]);

    expect(first.ZCODE_TELEMETRY_DEVICE_MID).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second.ZCODE_TELEMETRY_DEVICE_MID).toBe(first.ZCODE_TELEMETRY_DEVICE_MID);
    const state = JSON.parse(await readFile(join(home, "v2", "telemetry-state.json"), "utf8")) as {
      deviceMid: string;
    };
    expect(state.deviceMid).toBe(first.ZCODE_TELEMETRY_DEVICE_MID);
  });
});
