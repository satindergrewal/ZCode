import { LOCAL_TTFT_TTL_MS } from "@zcode/shared";

const MAX_OBSERVATIONS = 1024;
const MAX_FACTS_PER_OBSERVATION = 512;

/** Egress-dedup identity only; at capacity, reject new details rather than evict observed root identities. */
export class LocalTtftExportDedupe {
  private readonly observations = new Map<string, { start: number; facts: Set<string> }>();
  constructor(private readonly now = Date.now) {}
  admit(
    renderer: string,
    observation: string,
    start: number,
  ): ((factId: string) => boolean) | undefined {
    const now = this.now();
    // Mirrors the renderer observation retention; retries outside the window never rebuild Histogram samples.
    if (now - start > LOCAL_TTFT_TTL_MS) return;
    for (const [id, entry] of this.observations)
      if (now - entry.start > LOCAL_TTFT_TTL_MS) this.observations.delete(id);
    const key = `${renderer}:${observation}`;
    let entry = this.observations.get(key);
    if (!entry) {
      if (this.observations.size >= MAX_OBSERVATIONS) return;
      entry = { start, facts: new Set() };
      this.observations.set(key, entry);
    }
    const facts = entry.facts;
    return (factId) => {
      if (facts.has(factId) || facts.size >= MAX_FACTS_PER_OBSERVATION) return false;
      facts.add(factId);
      return true;
    };
  }
}
