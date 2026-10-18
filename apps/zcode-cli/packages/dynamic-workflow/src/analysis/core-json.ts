import type { OrderTrace } from "./causality-order.js";
import type { AnalysisCore, CoreSites } from "./core.js";
import type { TaintOcc } from "./domain.js";

/**
  * JSON codecs for AnalysisCore.
 *
  * core is already position-free pure data; the only JSON.stringify blockers are the Maps in facts and types --
  * they would serialize as empty objects. Each Map becomes an **ordered** key-value entry list:
  * arrays keep insertion order and the decoder restores via new Map of entries, so serializeCore(decode(encode(c)))
  * equals serializeCore(c) byte for byte, and graphs computed over the frozen artifact match the export instant.
 *
  * sites and trace hold plain objects, arrays, and optionals, passing through: JSON.stringify drops
  * undefined-valued properties and the decoder does **not** restore them -- every projection judges field-absent, never
  * field-undefined; the two shapes are equivalent. The one exception is the joinPortTypes values: undefined inside a
  * string-or-undefined array becomes null in JSON, so encoding writes null explicitly and decoding restores
  * undefined -- the this-port-type-unknown hole stays undefined, not null, across the round trip.
 */

/** Ordered Map entries: array order is the Map's insertion order. */
export type MapEntries<V> = [string, V][];

export interface AnalysisCoreJson {
    /** Format version; the decoder knows only versions it recognizes -- others throw, no guessing. */
  version: 1;
  sites: CoreSites;
  facts: {
    askData: MapEntries<TaintOcc[]>;
    askActor: MapEntries<TaintOcc[]>;
    worldReadData: MapEntries<TaintOcc[]>;
    joinIn: MapEntries<TaintOcc[]>;
    fanoutIn: MapEntries<TaintOcc[]>;
    /** 留白提示的 sink（2026-09-28 加入）；早于它冻结的样例包没有这个键，解码按空表补。 */
    holeData?: MapEntries<TaintOcc[]>;
    returnData: TaintOcc[];
  };
  trace: OrderTrace;
  types: {
    siteType: MapEntries<string>;
        /** A port-type hole (undefined) is null here -- JSON arrays have no undefined. */
    joinPortTypes: MapEntries<(string | null)[]>;
  };
}

const VERSION = 1;

/** Core as a directly stringifiable plain object; sites and trace share the original references. */
export function encodeAnalysisCore(core: AnalysisCore): AnalysisCoreJson {
  return {
    facts: {
      askActor: [...core.facts.askActor],
      askData: [...core.facts.askData],
      fanoutIn: [...core.facts.fanoutIn],
      holeData: [...core.facts.holeData],
      joinIn: [...core.facts.joinIn],
      returnData: core.facts.returnData,
      worldReadData: [...core.facts.worldReadData],
    },
    sites: core.sites,
    trace: core.trace,
    types: {
      joinPortTypes: [...core.types.joinPortTypes].map(([id, ports]) => [
        id,
        ports.map((port) => (port === undefined ? null : port)),
      ]),
      siteType: [...core.types.siteType],
    },
    version: VERSION,
  };
}

/** Rebuild core from its JSON form (Maps keep their insertion order). Unknown versions throw a plain Error. */
export function decodeAnalysisCore(json: AnalysisCoreJson): AnalysisCore {
  if (json.version !== VERSION) {
    throw new Error(`unsupported AnalysisCoreJson version ${String(json.version)} (expected ${VERSION})`);
  }
  return {
    facts: {
      askActor: new Map(json.facts.askActor),
      askData: new Map(json.facts.askData),
      fanoutIn: new Map(json.facts.fanoutIn),
      holeData: new Map(json.facts.holeData ?? []),
      joinIn: new Map(json.facts.joinIn),
      returnData: json.facts.returnData,
      worldReadData: new Map(json.facts.worldReadData),
    },
    // 留白站点表同样是后加的键：老样例包按「没有留白」解码。
    sites: { ...json.sites, holes: json.sites.holes ?? [] },
    trace: json.trace,
    types: {
      joinPortTypes: new Map(
        json.types.joinPortTypes.map(([id, ports]) => [id, ports.map((port) => (port === null ? undefined : port))]),
      ),
      siteType: new Map(json.types.siteType),
    },
  };
}
