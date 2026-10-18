type OAuthCallback = (url: string) => void | Promise<void>;

export function createOAuthCallbackHandler(callback: OAuthCallback, notifyHandled: () => void) {
  return async (_event: unknown, url: string): Promise<void> => {
    try {
      await callback(url);
    } catch {
      // This preload only bridges the OAuth callback handshake; never let renderer callback errors escape as unhandled rejections.
      // The renderer renders its own errors; the handled ACK must reach main on success and failure alike.
    } finally {
      notifyHandled();
    }
  };
}
