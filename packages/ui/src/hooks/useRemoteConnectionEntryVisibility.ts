export function useRemoteConnectionEntryVisibility(): boolean {
  // The SSH entry used to reuse the internal-only gate, hiding it in production
  // internet-facing setups too. But SSH availability depends on the target machine, network
  // path, and credentials — not on whether this client sits in a private network. Remote
  // connection is a generic SSH capability and must not be gated by a retired product's
  // intranet policy.
  return true;
}
