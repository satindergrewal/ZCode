/**
 * Sample source for the Chromium family (main/renderer/gpu/utility).
 *
 * Reads app.getAppMetrics() every 10s, aggregates by role, feeds the window aggregator.
 * Zero external processes: in-process APIs only.
 */

import { app, type ProcessMetric } from "electron";
import os from "node:os";
import { normalizeElectronCpuToMachinePercent } from "./electronCpuNormalization.js";
import {
  aggregateChromiumProcessRoles,
  sumChromiumRoleAggregates,
  type ChromiumProcessMetricSample,
} from "./processResourceRoleClassifier.js";
import { collectChromiumProcessRolePids } from "./resourceManagerWindow.js";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";

function toNormalizedSample(
  metric: ProcessMetric,
  logicalCpuCount: number,
): ChromiumProcessMetricSample {
  return {
    pid: metric.pid,
    type: metric.type,
    cpuPercent: normalizeElectronCpuToMachinePercent(metric.cpu.percentCPUUsage, {
      logicalCpuCount,
    }),
    // getAppMetrics memory.workingSetSize is KB.
    rssKb: metric.memory.workingSetSize ?? 0,
    creationTime: metric.creationTime,
  };
}

export const chromiumProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "chromium",
  sample(context) {
    const metrics = app.getAppMetrics();
    const logicalCpuCount = os.cpus().length;
    const aggregates = aggregateChromiumProcessRoles({
      processes: metrics.map((metric) => toNormalizedSample(metric, logicalCpuCount)),
      pids: collectChromiumProcessRolePids(),
      now: context.now,
    });

    // ChromiumRoleAggregate is the Chromium subset of ProcessRoleSample (no heap/mcpId/hardware);
    // field-by-field copying would silently break when either side renames a field.
    for (const aggregate of aggregates) {
      context.addRoleSample(aggregate);
    }
    // The device-level app total needs this tick's exact sum; if sampling throws, this line never runs,
    // the tick has no device sample -- stale readings never pass as current.
    context.addAppProcessTotals(sumChromiumRoleAggregates(aggregates));
  },
};
