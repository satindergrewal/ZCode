// Map and Set are not JSON-serializable -- reject. Two distinct asks, two findings.
interface WithMap {
  index: Map<string, number>;
}
interface WithSet {
  seen: Set<string>;
}

const g = agent("g");
const a = await g.ask<WithMap>("map"); // error
const b = await g.ask<WithSet>("set"); // error
log(JSON.stringify(a) + JSON.stringify(b));
