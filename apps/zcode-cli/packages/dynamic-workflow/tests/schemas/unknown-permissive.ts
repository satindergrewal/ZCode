// unknown -> a permissive empty schema; mixed with concrete fields, only unknown passes.
interface Payload {
  id: string;
  data: unknown;
  meta: Record<string, unknown>;
}

const g = agent("g");
const payload = await g.ask<Payload>("emit a payload");
const raw = await g.ask<unknown>("emit anything");
log(JSON.stringify(payload) + String(raw));
