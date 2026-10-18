// Renderer-local monotonic generation for the remote workspace service proxy.
// The session-registration entry pre-allocates; async consumers read the same generation by object
// identity, so out-of-order effect re-entry cannot flip back to an older service.
const generations = new WeakMap<object, number>();
let nextGeneration = 1;

export function remoteAgentServiceGeneration(agentService: object): number {
  const existing = generations.get(agentService);
  if (existing !== undefined) return existing;

  const generation = nextGeneration++;
  generations.set(agentService, generation);
  return generation;
}
