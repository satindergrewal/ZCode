/* eslint-disable max-lines -- Off-Peak credential resolution, support matrix, and Request Auth share one contract set; splitting blurs the dual-credential/Team identity boundaries. */
/* At dispatch, build per-request auth material from the current ticket; Provider/Model static facts come from Built-in Config. */
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  resolveOffPeakProviderId,
  buildRuntimeZCodeApiUrl,
  type OffPeakCodingPlanKind,
  type OffPeakCodingPlanSupport,
  type OffPeakCodingPlanUnsupportedReason,
  type ZCodeAccountAccess,
} from "@zcode/shared";
import { isOffPeakMockEnabled, startOffPeakMockGateway } from "./offPeakMockGateway.js";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { AccountRequestCredentialUnavailableError } from "../model-provider/accountProviderRequestAuthService.js";
import type { IAccountRequestAuthService } from "../model-provider/accountRequestAuthService.js";

/** Deterministic config errors only; the host maps types to permanent, never branching on error text. */
export class OffPeakPermanentDispatchError extends Error {
  readonly failureKind = "permanent" as const;

  constructor(message: string) {
    super(message);
    this.name = "OffPeakPermanentDispatchError";
  }
}

/** Typed dual-credential resolution failure (UI can prompt sign-in/coding-plan setup). */
export class OffPeakCredentialsUnavailableError extends OffPeakPermanentDispatchError {
  constructor(readonly missing: "jwt" | "codingPlanApiKey") {
    super(
      missing === "jwt"
        ? "off-peak requires zcode login (jwt missing)"
        : "off-peak requires a coding plan provider api key",
    );
    this.name = "OffPeakCredentialsUnavailableError";
  }
}

/** Current provider family / selected connection is outside the Off-Peak support matrix. */
export class OffPeakCodingPlanUnavailableError extends OffPeakPermanentDispatchError {
  constructor(readonly reason: OffPeakCodingPlanUnsupportedReason) {
    super(`off-peak selected coding plan unavailable: ${reason}`);
    this.name = "OffPeakCodingPlanUnavailableError";
  }
}

/** Typed error stopping ticket burn when the resident/idle-plan model is missing. */
export class OffPeakModelUnavailableError extends OffPeakPermanentDispatchError {
  constructor(readonly scope: "idlePlan" | "workspaceUser") {
    super(
      scope === "idlePlan"
        ? "off-peak dispatch has no usable model (Built-in Provider models empty)"
        : "off-peak dispatch has no usable user workspace model",
    );
    this.name = "OffPeakModelUnavailableError";
  }
}

const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ACTIVE_OAUTH_PROVIDER_KEY = "oauth:active_provider";

export interface OffPeakCredentialSnapshot {
  jwt: string;
  codingPlanApiKey: string;
  accountScope?: string;
  kind: OffPeakCodingPlanKind;
  providerFamily: "zai" | "bigmodel";
  providerId: string;
  /** BigModel Team org/project identity; both must exist before entering request headers. */
  organizationId?: string;
  projectId?: string;
  /** In-process mock proxying of the really selected Coding Plan upstream; never over RPC nor persisted. */
  providerBaseURL?: string;
}

interface OffPeakCredentialResolverDeps {
  credentialService: { load(key: string): Promise<string | null | undefined> };
  accountRequestAuthService: IAccountRequestAuthService;
  resolveAccountProvider(): Promise<{
    readonly providerId: string;
    readonly access: ZCodeAccountAccess;
    readonly baseURL?: string;
  } | null>;
  env?: NodeJS.ProcessEnv;
}

type SelectedOffPeakCodingPlan = Pick<
  OffPeakCredentialSnapshot,
  "kind" | "providerFamily" | "providerId" | "organizationId" | "projectId"
>;

function resolveSelectedOffPeakCodingPlan(
  provider: Awaited<ReturnType<OffPeakCredentialResolverDeps["resolveAccountProvider"]>>,
): SelectedOffPeakCodingPlan {
  if (!provider) {
    throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
  }
  const { access, providerId } = provider;
  if (access.planKind === "start-plan") {
    throw new OffPeakCodingPlanUnavailableError("start_plan_not_supported");
  }
  if (access.planKind === "individual-coding-plan") {
    return {
      kind: access.family === "zai" ? "zai-personal" : "bigmodel-personal",
      providerFamily: access.family,
      providerId,
    };
  }
  if (access.planKind !== "team-coding-plan") {
    throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
  }
  return {
    kind: access.family === "zai" ? "zai-team" : "bigmodel-team",
    providerFamily: access.family,
    providerId,
    organizationId: access.organizationId,
    projectId: access.projectId,
  };
}

function createOffPeakSelectionFingerprint(
  provider: Awaited<ReturnType<OffPeakCredentialResolverDeps["resolveAccountProvider"]>>,
): string {
  return JSON.stringify(provider ?? null);
}

/**
 * Resolve the Off-Peak dual credentials of the current selected connection.
 *
 * Dispatch credentials must match the UI-selected Coding Plan, so ZAI/Team tasks never misuse a personal BigModel key.
 * settings family + selectedKey is the only selection source; dynamic credentials resolve via
 * the auth source injected at the execution entry.
 * Team keys keep the Account Request Auth org/project resolver and never fall back to personal keys.
 */
export async function resolveOffPeakCredentials(
  deps: OffPeakCredentialResolverDeps,
  options: { allowMockCredentials?: boolean } = {},
): Promise<OffPeakCredentialSnapshot> {
  const env = deps.env ?? process.env;
  if (options.allowMockCredentials !== false && env["ZCODE_OFFPEAK_MOCK"] === "1") {
    if (env["ZCODE_OFFPEAK_MOCK_NO_PLAN"] === "1") {
      throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
    }
    // The mock gateway validates no credentials; deterministic metadata keeps UI/ticket/runtime on one support shape.
    return {
      jwt: "offpeak-mock-jwt",
      codingPlanApiKey: "offpeak-mock-key",
      kind: "bigmodel-personal",
      providerFamily: "bigmodel",
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    };
  }

  // settings may flip during account-provider resolution. On fingerprint mismatch re-read once; never splice two generations.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const provider = await deps.resolveAccountProvider();
    const selection = resolveSelectedOffPeakCodingPlan(provider);
    const activeProvider =
      (await deps.credentialService.load(ACTIVE_OAUTH_PROVIDER_KEY))?.trim() ?? "";
    if (activeProvider !== selection.providerFamily) {
      // The zcode JWT mirrors the current app login globally; checking selectedKey only could splice
      // a ZAI JWT with a BigModel key (or reverse) into one request, rejected server-side only at ticketing.
      throw new OffPeakCodingPlanUnavailableError("provider_identity_mismatch");
    }
    const jwt = (await deps.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() ?? "";
    if (!jwt) {
      throw new OffPeakCredentialsUnavailableError("jwt");
    }
    const [latestProvider, latestActiveProvider] = await Promise.all([
      deps.resolveAccountProvider(),
      deps.credentialService.load(ACTIVE_OAUTH_PROVIDER_KEY),
    ]);
    if (
      createOffPeakSelectionFingerprint(provider) !==
        createOffPeakSelectionFingerprint(latestProvider) ||
      activeProvider !== latestActiveProvider?.trim()
    ) {
      continue;
    }

    if (
      !provider ||
      provider.access.family !== selection.providerFamily ||
      (selection.kind.endsWith("-team")
        ? provider.access.planKind !== "team-coding-plan"
        : provider.access.planKind !== "individual-coding-plan")
    ) {
      throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
    }
    let codingPlanApiKey = "";
    let accountScope: string | undefined;
    try {
      const auth = await deps.accountRequestAuthService.resolveCurrent({
        providerId: selection.providerId,
        modelId: resolveOffPeakProviderId(selection.providerFamily),
        accountAccess: provider.access,
        reason: "off-peak",
      });
      codingPlanApiKey = auth.apiKey?.trim() ?? "";
      accountScope = auth.accountScope;
    } catch (error) {
      if (error instanceof AccountRequestCredentialUnavailableError) {
        throw new OffPeakCredentialsUnavailableError("codingPlanApiKey");
      }
      throw error;
    }
    if (!codingPlanApiKey) {
      throw new OffPeakCredentialsUnavailableError("codingPlanApiKey");
    }
    return {
      ...selection,
      jwt,
      codingPlanApiKey,
      ...(accountScope ? { accountScope } : {}),
      ...(provider.baseURL ? { providerBaseURL: provider.baseURL } : {}),
    };
  }

  throw new OffPeakCodingPlanUnavailableError("selection_changed");
}

/**
 * BigModel Team org/project and the auth credential must come from one selected-connection resolution.
 *
 * Off-Peak used to send only JWT + Coding Plan key; without the BigModel access key the server
 * cannot look up the Team Plan organization/project. Legacy connection keys may hold only projectId:
 * never send half an identity header set, or the server validates against the wrong org.
 */
export function buildOffPeakPlanIdentityHeaders(
  credentials: OffPeakCredentialSnapshot,
): Record<string, string> {
  if (credentials.kind !== "bigmodel-team") {
    return {};
  }
  const organizationId = credentials.organizationId?.trim() ?? "";
  const projectId = credentials.projectId?.trim() ?? "";
  if (!organizationId || !projectId) {
    return {};
  }
  return {
    "bigmodel-organization": organizationId,
    "bigmodel-project": projectId,
  };
}

/**
 * Build the dynamic auth material of one off-peak run. Endpoint, model capability, and reasoning statics come from
 * Built-in Provider/Model Config, never pushed per dispatch.
 */
export function buildOffPeakRequestAuth(params: {
  credentials: OffPeakCredentialSnapshot;
  ticketId: string;
}): { apiKey: string; headers: Record<string, string>; accountScope?: string } {
  return {
    // Anthropic-compatible clients send x-api-key; the server still rules via Authorization + plan key.
    apiKey: params.credentials.jwt,
    ...(params.credentials.accountScope ? { accountScope: params.credentials.accountScope } : {}),
    headers: {
      Authorization: `Bearer ${params.credentials.jwt}`,
      "X-Coding-Plan-Api-Key": params.credentials.codingPlanApiKey,
      "X-Off-Peak-Ticket-ID": params.ticketId,
      ...buildOffPeakPlanIdentityHeaders(params.credentials),
    },
  };
}

/** Renderer-visible masked support snapshot; raw credentials stay in host/service memory. */
export async function resolveOffPeakCodingPlanSupport(
  deps: OffPeakCredentialResolverDeps,
): Promise<OffPeakCodingPlanSupport> {
  try {
    const snapshot = await resolveOffPeakCredentials(deps);
    return {
      supported: true,
      kind: snapshot.kind,
      providerFamily: snapshot.providerFamily,
      providerId: snapshot.providerId,
    };
  } catch (error) {
    if (error instanceof OffPeakCodingPlanUnavailableError) {
      return { supported: false, reason: error.reason };
    }
    if (error instanceof OffPeakCredentialsUnavailableError) {
      return {
        supported: false,
        reason: error.missing === "jwt" ? "jwt_missing" : "connection_unavailable",
      };
    }
    throw error;
  }
}

/**
 * Mock-gateway upstream resolution: proxy admitted messages to the user coding plan's anthropic
 * compatible endpoint (real model, user's own key; dev/demo only).
 */
export async function resolveOffPeakMockUpstream(deps: {
  credentialService: OffPeakCredentialResolverDeps["credentialService"];
  accountRequestAuthService: OffPeakCredentialResolverDeps["accountRequestAuthService"];
  resolveAccountProvider: OffPeakCredentialResolverDeps["resolveAccountProvider"];
  env?: NodeJS.ProcessEnv;
}): Promise<{ url: string; headers: Record<string, string> }> {
  const credentials = await resolveOffPeakCredentials(deps, {
    // The mock's own placeholder must not proxy upstream; force-resolve the real selected connection.
    allowMockCredentials: false,
  });
  if (!credentials.providerBaseURL) {
    throw new Error("off-peak mock upstream requires a selected coding plan provider endpoint");
  }
  return {
    url: `${credentials.providerBaseURL.replace(/\/$/, "")}/v1/messages`,
    headers: {
      "x-api-key": credentials.codingPlanApiKey,
      authorization: `Bearer ${credentials.codingPlanApiKey}`,
    },
  };
}

/**
 * origin resolver (memoized): mock mode lazily starts the in-process gateway (fixed port, instances share state via
 * EADDRINUSE), real mode points at the zcode API origin. One resolver per side (node assembly, host dispatch) is safe -
 * whoever binds first owns the gateway; the other reuses it externally.
 */
export function createOffPeakOriginResolver(deps: {
  logger: ServiceLogger;
  resolveUpstream: () => Promise<{ url: string; headers: Record<string, string> }>;
  env?: NodeJS.ProcessEnv;
}): { resolveOrigin: () => Promise<string>; close: () => Promise<void> } {
  const env = deps.env ?? process.env;
  let originPromise: Promise<string> | null = null;
  let closeGateway: (() => Promise<void>) | null = null;
  return {
    resolveOrigin: () => {
      if (!originPromise) {
        originPromise = (async () => {
          if (!isOffPeakMockEnabled(env)) {
            return new URL(buildRuntimeZCodeApiUrl(env, "/")).origin;
          }
          const gateway = await startOffPeakMockGateway({
            logger: deps.logger,
            resolveUpstream: deps.resolveUpstream,
          });
          if (!gateway.external) closeGateway = gateway.close;
          return gateway.origin;
        })().catch((error) => {
          originPromise = null; // retry allowed after failure (e.g. transient port occupation)
          throw error;
        });
      }
      return originPromise;
    },
    close: async () => {
      const close = closeGateway;
      closeGateway = null;
      if (close) await close();
    },
  };
}
