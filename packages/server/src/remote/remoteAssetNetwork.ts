export interface RemoteAssetNetworkPort {
  fetch: typeof globalThis.fetch;
}

export function resolveRemoteAssetFetch(
  network: RemoteAssetNetworkPort | undefined,
): typeof globalThis.fetch {
  // Desktop Host remote-asset downloads used to call global fetch directly,
  // bypassing the settings-page proxy. A standalone server has no Desktop settings
  // authority, so keep the existing contract of direct connection when unset.
  return network?.fetch ?? globalThis.fetch.bind(globalThis);
}
