import { mcpProcessResourceSampleSource } from "./processResourceMcpTelemetrySource.js";
/**
 * Resource sample-source registry.
 *
 * To add a source: create its file and append one line below,
 * keeping parallel-work merge conflicts line-local.
 * Array order carries no dependency; same-tick facts for device sources arrive via the phase-2 sampleDevice context.
 */

import { chromiumProcessResourceSampleSource } from "./processResourceChromiumSource.js";
import { cliProcessResourceSampleSource } from "./processResourceCliSource.js";
import { rendererHeapProcessResourceSampleSource } from "./processResourceRendererHeapSource.js";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";
import { selfHeapProcessResourceSampleSource } from "./processResourceSelfHeapSource.js";
import { systemProcessResourceSampleSource } from "./processResourceSystemSource.js";

export const PROCESS_RESOURCE_SAMPLE_SOURCES: readonly ProcessResourceSampleSource[] = [
  chromiumProcessResourceSampleSource,
  systemProcessResourceSampleSource,
  selfHeapProcessResourceSampleSource,
  rendererHeapProcessResourceSampleSource,
  cliProcessResourceSampleSource,
  mcpProcessResourceSampleSource,
];
