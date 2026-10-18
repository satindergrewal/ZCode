import type { AccountProviderUnavailableReason } from "@zcode/shared/account-provider-state";

/**
 * Why an account is unavailable -- answers exactly that question and nothing else.
 *
 * Since the provider refactor the UI only sees availability=unavailable + entitled=false:
 * signed-out, disconnected, credential fetch/verify failure, and a server-side missing plan
 * collapse into one blob, so a signed-in user without a plan shows as
 * disconnected. The reason must ship with the State so the UI never needs a second request
 * to guess (an unavailable provider never re-runs the entitlement query).
 */
export type { AccountProviderUnavailableReason } from "@zcode/shared/account-provider-state";

/**
 * Live account facts -- not a config Overlay, never written to user settings.
 * current means matching the active account context: Start may be true alongside the paid
 * plan; Off-Peak defines none.
 */
export interface AccountProviderState {
  readonly availability: "available" | "pending" | "unavailable" | "unknown";
  readonly entitled: boolean;
  /** Meaningful only when availability === "unavailable"; unknown = undetermined this round. */
  readonly unavailableReason?: AccountProviderUnavailableReason;
  readonly current?: boolean;
  /** Account/connection identity of this snapshot, for change isolation only; not persisted, no credentials. */
  readonly connectionKey?: string;
  /** Unix seconds; same unit as billing effective_at. */
  readonly effectiveAt?: number;
}

export type AccountProviderStates = Readonly<Record<string, AccountProviderState>>;
