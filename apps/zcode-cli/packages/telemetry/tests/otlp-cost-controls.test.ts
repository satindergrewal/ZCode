import { ROOT_CONTEXT, SpanKind, TraceFlags, trace } from "@opentelemetry/api";
import { AggregationType } from "@opentelemetry/sdk-metrics";
import { SamplingDecision } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  AGENT_METRIC_EXPORT_INTERVAL_MS,
  AGENT_TRACE_SAMPLE_RATIO,
  createAgentTraceSampler,
  metricViews,
} from "../src/otlp-exporter.js";

const TRACE_ID = "1234567890abcdef1234567890abcdef";
const SPAN_ID = "1234567890abcdef";

describe("OTLP ARMS cost controls", () => {
  it("defaults the metric interval to 5 minutes and samples root traces at a steady 10%", () => {
    expect(AGENT_METRIC_EXPORT_INTERVAL_MS).toBe(300_000);
    expect(AGENT_TRACE_SAMPLE_RATIO).toBe(0.1);
  });

  it("child spans inherit the parent sampling decision, keeping the trace tree intact", () => {
    const sampler = createAgentTraceSampler(0);
    const sampledParent = trace.setSpanContext(ROOT_CONTEXT, {
      isRemote: false,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      traceId: TRACE_ID,
    });
    const unsampledParent = trace.setSpanContext(ROOT_CONTEXT, {
      isRemote: false,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.NONE,
      traceId: TRACE_ID,
    });

    expect(
      sampler.shouldSample(sampledParent, TRACE_ID, "agent_step", SpanKind.INTERNAL, {}, [])
        .decision,
    ).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(
      sampler.shouldSample(unsampledParent, TRACE_ID, "agent_step", SpanKind.INTERNAL, {}, [])
        .decision,
    ).toBe(SamplingDecision.NOT_RECORD);
    expect(
      createAgentTraceSampler(0).shouldSample(
        ROOT_CONTEXT,
        TRACE_ID,
        "agent_turn",
        SpanKind.INTERNAL,
        {},
        [],
      ).decision,
    ).toBe(SamplingDecision.NOT_RECORD);
    expect(
      createAgentTraceSampler(1).shouldSample(
        ROOT_CONTEXT,
        TRACE_ID,
        "agent_turn",
        SpanKind.INTERNAL,
        {},
        [],
      ).decision,
    ).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it("disables Histogram Min/Max and keeps at most 10 buckets per instrument", () => {
    const histogramViews = metricViews().filter(
      (view) => view.aggregation?.type === AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
    );

    expect(histogramViews.length).toBeGreaterThan(0);
    for (const view of histogramViews) {
      expect(view.aggregation).toMatchObject({
        options: { recordMinMax: false },
      });
      if (view.aggregation?.type === AggregationType.EXPLICIT_BUCKET_HISTOGRAM) {
        expect(view.aggregation.options.boundaries).toHaveLength(
          Math.min(view.aggregation.options.boundaries.length, 10),
        );
      }
    }

    const attempts = histogramViews.find(
      (view) => view.instrumentName === "zcode.model.call.attempts",
    );
    expect(attempts?.aggregation).toMatchObject({
      options: { boundaries: [1, 2, 3, 5, 8] },
    });
  });
});
