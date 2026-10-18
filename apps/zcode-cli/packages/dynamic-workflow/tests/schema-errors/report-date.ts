// report(item) args pass the same serializability verdict as ask<T> results: Date is a host object, not data.
// A reported item and an artifact cross journal and protocol boundaries for exactly the same reasons.
const g = agent("g");
const out = await g.ask<string>("go");
report(new Date(out)); // error
