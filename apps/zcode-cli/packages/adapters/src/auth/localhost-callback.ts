import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const LOCALHOST = "127.0.0.1";
const SUCCESS_TEXT = "Authorization successful! You may close this window and return to the CLI.";
const FAILURE_TEXT = "Authorization failed. You may close this window and return to the CLI.";

/** Stable error code used when the authorization server returns `error` per RFC 6749 4.1.2.1. */
export const MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE = "MCP_OAUTH_CALLBACK_DENIED";

export interface McpOAuthCallbackDeniedError extends Error {
  code: typeof MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE;
  oauthError: string;
  oauthErrorDescription?: string;
}

function createCallbackDeniedError(
  oauthError: string,
  oauthErrorDescription: string | null,
): McpOAuthCallbackDeniedError {
  // Never branch on error text: callers tell user-denied from timeout via the code/oauthError fields.
  const error = new Error(
    `OAuth authorization was rejected by the authorization server: ${oauthError}`,
  ) as McpOAuthCallbackDeniedError;
  error.code = MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE;
  error.oauthError = oauthError;
  if (oauthErrorDescription) error.oauthErrorDescription = oauthErrorDescription;
  return error;
}

export interface LocalhostOAuthCallback {
  code: string;
  url: string;
}

export interface LocalhostOAuthCallbackServer {
  callbackPath: string;
  callbackUrl: string;
  close(): Promise<void>;
  waitForCallback(): Promise<LocalhostOAuthCallback>;
}

export async function createLocalhostOAuthCallbackServer(input: {
  callbackPath: string;
  state: string;
}): Promise<LocalhostOAuthCallbackServer> {
  let resolveCallback: (value: LocalhostOAuthCallback) => void = () => undefined;
  let rejectCallback: (error: Error) => void = () => undefined;
  let settled = false;
  const callbackPromise = new Promise<LocalhostOAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${LOCALHOST}`);
      if (requestUrl.pathname !== input.callbackPath) {
        writeText(response, 404, FAILURE_TEXT);
        return;
      }

      // A state mismatch used to reject this transaction's callback promise. Concurrent grants,
      // stale authorize URLs left in the browser, or prefetches all reach this listener; one unknown state
      // could make the later correct callback never succeed. Now reply 400 and keep waiting for our state.
      const state = requestUrl.searchParams.get("state") ?? "";
      if (state !== input.state) {
        writeText(response, 400, FAILURE_TEXT);
        return;
      }

      // A state match means this is our grant response. On deny the server replies
      // error=access_denied; this used to wait for caller timeout, now settle immediately.
      const oauthError = requestUrl.searchParams.get("error");
      if (oauthError) {
        writeText(response, 400, FAILURE_TEXT);
        if (!settled) {
          settled = true;
          rejectCallback(
            createCallbackDeniedError(
              oauthError,
              requestUrl.searchParams.get("error_description"),
            ),
          );
        }
        return;
      }

      const code =
        requestUrl.searchParams.get("authCode") ?? requestUrl.searchParams.get("code") ?? "";
      if (!code) {
        // State matched but neither code nor error: malformed grant response, fail now
        // without consuming the rest of the grant window.
        writeText(response, 400, FAILURE_TEXT);
        if (!settled) {
          settled = true;
          rejectCallback(new Error("OAuth callback is missing an authorization code."));
        }
        return;
      }

      writeText(response, 200, SUCCESS_TEXT);
      if (!settled) {
        settled = true;
        resolveCallback({
          code,
          url: requestUrl.toString(),
        });
      }
    } catch (error) {
      writeText(response, 500, FAILURE_TEXT);
      if (!settled) {
        settled = true;
        rejectCallback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCALHOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!isAddressInfo(address)) {
    await closeServer(server);
    throw new Error("Unable to resolve localhost callback server address.");
  }

  const callbackUrl = `http://${LOCALHOST}:${address.port}${input.callbackPath}`;
  return {
    callbackPath: input.callbackPath,
    callbackUrl,
    close: async () => {
      await closeServer(server);
    },
    waitForCallback: () => callbackPromise,
  };
}

function writeText(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(message);
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function isAddressInfo(value: unknown): value is AddressInfo {
  return typeof value === "object" && value !== null && "port" in value;
}
