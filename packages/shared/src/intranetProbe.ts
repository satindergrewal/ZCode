export interface IntranetProbeTcpTarget {
  /// Target unique id; defaults to host:port when absent
  id?: string;
  kind?: "tcp";
  host: string;
  /// Default 22 (SSH)
  port?: number;
  /// Per-probe timeout, default 800ms
  timeoutMs?: number;
}

export interface IntranetProbeServiceTarget {
  /// Target unique id; defaults to url when absent
  id?: string;
  kind: "service";
  /// Intranet probe service URL, provided by the caller via env
  url: string;
  /// Marker the service must return (optional)
  expectedMarker?: string;
  /// Shared token (optional); sent as the x-zcode-intranet-token header
  token?: string;
  /// Per-probe timeout, default 800ms
  timeoutMs?: number;
}

export type IntranetProbeTarget = IntranetProbeTcpTarget | IntranetProbeServiceTarget;

export interface IntranetProbeRequest {
  targets: IntranetProbeTarget[];
  /// Max retries per target, default 2, range [1, 3]
  attempts?: number;
  /**
   * Hits needed to rule "intranet".
   * Default 1 (any reachable target suffices).
   */
  requiredSuccessCount?: number;
}

export interface IntranetProbeTcpTargetResult {
  targetId: string;
  kind: "tcp";
  host: string;
  port: number;
  reachable: boolean;
  /// Attempts actually made
  attemptCount: number;
  /// Millis when reachable, else null
  latencyMs: number | null;
  /// Last failure reason
  error?: string;
}

export interface IntranetProbeServiceTargetResult {
  targetId: string;
  kind: "service";
  url: string;
  reachable: boolean;
  /// Attempts actually made
  attemptCount: number;
  /// Millis when reachable, else null
  latencyMs: number | null;
  /// Marker returned by the service (if any)
  marker?: string;
  /// Last failure reason
  error?: string;
}

export type IntranetProbeTargetResult =
  | IntranetProbeTcpTargetResult
  | IntranetProbeServiceTargetResult;

export interface IntranetProbeResult {
  /// Final intranet verdict
  isIntranet: boolean;
  /// Targets probed successfully
  reachedTargetCount: number;
  /// Verdict threshold
  requiredSuccessCount: number;
  /// Total targets probed
  totalTargets: number;
  /// Timestamp (ms)
  checkedAt: number;
  /// Active probe policy
  strategy: "tcp-connect" | "service-http" | "mixed";
  results: IntranetProbeTargetResult[];
}

export interface IntranetProbeServiceResponse {
  ok: boolean;
  marker?: string;
}
