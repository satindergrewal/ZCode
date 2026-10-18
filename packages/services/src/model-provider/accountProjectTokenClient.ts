import {
  ApiError,
  ProjectAccessTokenClient,
  ProjectAccessTokenTransientError,
  type ApiClient,
} from "@zcode/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readApiJson } from "#src/providers/api/apiJson.js";

const PROJECT_TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("project-access-token");

/** Local and legacy remote-attach entries share one HTTP/ID-store contract; one instance per auth owner. */
export function createAccountProjectTokenClient(
  apiClient: ApiClient,
  credentialService: Pick<ICredentialService, "load" | "save" | "delete">,
): ProjectAccessTokenClient {
  return new ProjectAccessTokenClient({
    request: async (url, init) => {
      try {
        return await readApiJson(apiClient, url, {
          ...init,
          timeoutMs: PROJECT_TOKEN_REQUEST_TIMEOUT_MS,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return { code: 404 };
        // Only transport faults, internal timeouts, and transient HTTP statuses retry; parse/unknown errors never restore the old PAT.
        if (
          error instanceof ApiError &&
          (error.status === 429 ||
            (error.status !== undefined && error.status >= 500 && error.status < 600) ||
            (error.status === undefined &&
              (error.cause instanceof TypeError ||
                (error.cause instanceof DOMException &&
                  ["AbortError", "TimeoutError"].includes(error.cause.name)))))
        )
          throw new ProjectAccessTokenTransientError();
        throw error;
      }
    },
    locationStore: credentialService,
    observe: (event) =>
      log.warn(
        undefined,
        event.code === "project_token_refresh_deferred"
          ? "Project token pre-refresh deferred"
          : "Failed to fetch project token",
        event,
      ),
  });
}
