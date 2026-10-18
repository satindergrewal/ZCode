// ============================================================
// Model-reference resolution (the `subagent_model` string → one selection)
// ============================================================
//
// Pure function, zero I/O: host facts arrive via `ModelCatalogPort` (contracts
// `interfaces/model-catalog.port.ts`); the resolution itself stays in core. The split exists for **testability** —
// three-tier matching, casing, level checks and the not-resolvable wording are the only parts churned regularly,
// and mixed into the port implementation they could only be pinned by integration tests.
//
// One call site: `CreateWorkflow` / `AmendWorkflow` `resolveInput`. Resolution must happen
// **before** the dialog — it shows the model that will apply, and an unresolvable call should never open one.

import type { ModelCatalogEntry, ModelSelection } from "@zcode/contracts";
import {
  ZCODE_MODEL_REASONING_SEPARATOR,
  formatModelPickerValue,
  parseModelPickerValue,
} from "@zcode/shared/model-selection";

/**
 * The resolution result. Failures always carry `candidates`: after a wrong guess, the most useful next step is knowing
 * what exists here; otherwise it re-spells and guesses again.
 */
type ModelReferenceResolution =
  | { ok: true; selection: ModelSelection; entry: ModelCatalogEntry; canonical: string }
  | {
      ok: false;
      reason: "not_found" | "ambiguous" | "disabled" | "reasoning_level_unknown";
      message: string;
      candidates: ModelCatalogEntry[];
    };

/**
 * Line cap for the `not_found` list. A catalog with dozens of providers can list hundreds of rows, and this text goes
 * straight into the model context — overflow becomes one line: call ListModels for the rest, the path that sees everything;
 * a truncated list is not.
 */
const MODEL_REFERENCE_CANDIDATE_LINES = 40;

/**
 * Resolve a user-uttered model name into one selection. Three tiers, most specific first (the order is part of the spec):
 *
 *   1. exact match on the full `providerId/modelId`;
 *   2. bare `modelId` under exactly one provider;
 *   3. bare `modelId` under several providers → the current-session one if present, else `ambiguous`.
 *
 * All comparisons are case-insensitive: the registry has no display name apart from `modelId`, so there is no
 * by-label tier — the uttered name differs from the id only by case and provider prefix.
 *
 * Disabled entries **never match silently**: disabled-only matches return `disabled` with each reason. Quietly
 * skipping to another model hands the user one they never asked for; quietly selecting it blows up when the subagent first speaks.
 *
 * A present `$level` must be legal for that model (else `reasoning_level_unknown`); absent, the registry default applies
 * (no options when the model has no levels). `canonical` is the picker form, spelled as the registry does — it flows
 * through the journal `run-launched` event, both read faces and the dialog.
 */
export function resolveModelReference(
  text: string,
  entries: ModelCatalogEntry[],
): ModelReferenceResolution {
  const { reference, level } = splitReasoningLevel(text.trim());
  const matches = matchEntries(reference, entries);
  if (matches.length === 0) return notFoundResolution(text, entries);

  const enabled = matches.filter((entry) => entry.disabledReason === undefined);
  if (enabled.length === 0) return disabledResolution(text, matches);

  // Tier 3. Fully-qualified names land here too: the same provider/model twice in a catalog is a host bug, and silently taking the first
  // leaves which-one-did-I-pick unanswered.
  const entry = enabled.length === 1 ? enabled[0]! : enabled.find((candidate) => candidate.current);
  if (entry === undefined) return ambiguousResolution(text, enabled);

  const options = resolveReasoningOptions(entry, level);
  if (options === undefined) {
    // `resolveReasoningOptions` returns undefined only for a mismatched given level, so level is present here.
    return reasoningLevelUnknownResolution(text, entry, level ?? "");
  }

  const selection: ModelSelection = {
    // The registry spelling, not the user: `canonical` must round-trip verbatim into the next call.
    providerId: entry.providerId,
    modelId: entry.modelId,
    ...options,
  };
  return { ok: true, selection, entry, canonical: formatModelPickerValue(selection) };
}

/**
 * Normalized `subagent_model` → structured selection. **Handler-only**: any string arriving there already passed
 * `resolveInput`, so a failure here means a bypassed normalization — a wiring fault, raised as one,
 * not a silent drop of the requested model (the subagent would quietly run on the session model, invisible to everyone).
 */
export function parseWorkflowSubagentModel(canonical: string | undefined): ModelSelection | undefined {
  if (canonical === undefined) return undefined;
  try {
    return parseModelPickerValue(canonical);
  } catch (cause) {
    throw new Error(
      `workflow subagent_model reached the handler un-canonicalised: ${canonical}`,
      { cause },
    );
  }
}

/**
 * One result-text sentence for the effective subagent model (shared by `CreateWorkflow` / `AmendWorkflow`, shaped after
 * `describeWorkflowConcurrencyLimit`). **Present only when a model was set**: a run on the session model has
 * nothing to state; an extra sentence makes the model believe it chose something.
 *
 * The parenthetical is for the model itself: it reads subagent-switched-model as I-switched-too, then
 * quotes a false current model back at the user.
 */
export function describeWorkflowSubagentModel(canonical: string | undefined): string {
  if (canonical === undefined) return "";
  return ` Subagents run on ${canonical} (the main agent stays on the session model).`;
}

/** Catalog-entry canonical id (no level): same shape as the `ListModels` `id` and the failure-list row. */
export function formatModelCatalogId(entry: ModelCatalogEntry): string {
  return `${entry.providerId}/${entry.modelId}`;
}

/**
 * Split off `$level`. The scan start follows the provider separator (as in `parseModelPickerValue`): provider ids
 * contain no `$`, but scanning the whole string as the model name cuts malformed input like `a$b/c` in the wrong place.
 */
function splitReasoningLevel(text: string): { reference: string; level?: string } {
  const providerSeparatorIndex = text.indexOf("/");
  const searchFrom = providerSeparatorIndex + 1;
  const index = text.indexOf(ZCODE_MODEL_REASONING_SEPARATOR, searchFrom);
  // An empty side (`$high`, `glm$`) is not a level: it is a typo — let not_found list the options.
  if (index <= searchFrom || index >= text.length - 1) return { reference: text };
  return { reference: text.slice(0, index), level: text.slice(index + 1) };
}

/** Candidate pool for tiers 1-2: with a slash compare the full name, without, the bare `modelId`. */
function matchEntries(reference: string, entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const providerSeparatorIndex = reference.indexOf("/");
  if (providerSeparatorIndex > 0) {
    const providerId = reference.slice(0, providerSeparatorIndex);
    const modelId = reference.slice(providerSeparatorIndex + 1);
    return entries.filter(
      (entry) => sameToken(entry.providerId, providerId) && sameToken(entry.modelId, modelId),
    );
  }
  return entries.filter((entry) => sameToken(entry.modelId, reference));
}

/**
 * Level selection. `undefined` means the given level is invalid (callers map that to `reasoning_level_unknown`);
 * `{}` means the model has no levels — distinct from an empty-string level, so nullish coalescing is not usable.
 */
function resolveReasoningOptions(
  entry: ModelCatalogEntry,
  level: string | undefined,
): { options?: { reasoningLevel: string } } | undefined {
  if (level !== undefined) {
    // The registry spelling wins: a typed `HIGH` becomes the catalog `high`, or canonical deforms on the first round-trip.
    const matched = entry.reasoningLevels.find((candidate) => sameToken(candidate, level));
    return matched === undefined ? undefined : { options: { reasoningLevel: matched } };
  }
  if (entry.reasoningLevels.length === 0 || entry.defaultReasoningLevel === undefined) return {};
  return { options: { reasoningLevel: entry.defaultReasoningLevel } };
}

/**
 * Not found: list the **usable** ids. Disabled ones stay out — picking from a list it cannot use just
 * buys a second failure. The current-session entry is tagged `[current]`: the set-nothing equivalent, tagged so
 * the model knows choosing it means choosing nothing.
 */
function notFoundResolution(text: string, entries: ModelCatalogEntry[]): ModelReferenceResolution {
  const candidates = entries.filter((entry) => entry.disabledReason === undefined);
  const shown = candidates.slice(0, MODEL_REFERENCE_CANDIDATE_LINES);
  const overflow = candidates.length - shown.length;
  const lines = shown.map(
    (entry) => `${formatModelCatalogId(entry)}${entry.current ? " [current]" : ""}`,
  );
  if (overflow > 0) lines.push(`… and ${overflow} more.`);
  const body =
    candidates.length === 0
      ? "No models are configured on this host."
      : ["Available models:", ...lines].join("\n");
  return {
    ok: false,
    reason: "not_found",
    message: `No configured model matches \`${text}\`. ${body}\n\nPass one of these ids, or call ListModels.`,
    candidates,
  };
}

/** Same name under several providers, none current-session: the caller must write the full name. */
function ambiguousResolution(
  text: string,
  candidates: ModelCatalogEntry[],
): ModelReferenceResolution {
  const lines = candidates.map((entry) => formatModelCatalogId(entry));
  return {
    ok: false,
    reason: "ambiguous",
    message: `\`${text}\` is configured under more than one provider:\n${lines.join("\n")}\n\nPass the full \`providerId/modelId\` of the one you want.`,
    candidates,
  };
}

/** Only disabled entries matched: say why, or the user sees this-model-does-not-exist for a listed model. */
function disabledResolution(
  text: string,
  candidates: ModelCatalogEntry[],
): ModelReferenceResolution {
  const lines = candidates.map(
    (entry) => `${formatModelCatalogId(entry)} — ${entry.disabledReason}`,
  );
  return {
    ok: false,
    reason: "disabled",
    message: `\`${text}\` matches a model that cannot be used on this host:\n${lines.join("\n")}\n\nResolve that with the user, or call ListModels and pick another id.`,
    candidates,
  };
}

/** Invalid level: the model is right, the level is not — so the list shows this model levels, not the whole catalog. */
function reasoningLevelUnknownResolution(
  text: string,
  entry: ModelCatalogEntry,
  level: string,
): ModelReferenceResolution {
  const id = formatModelCatalogId(entry);
  const levels =
    entry.reasoningLevels.length === 0
      ? `${id} has no reasoning levels — drop the \`$\` suffix.`
      : `Its levels are: ${entry.reasoningLevels.join(", ")}.${
          entry.defaultReasoningLevel === undefined
            ? ""
            : ` Omit the suffix to use ${entry.defaultReasoningLevel}.`
        }`;
  return {
    ok: false,
    reason: "reasoning_level_unknown",
    message: `\`${level}\` is not a reasoning level of ${id}. ${levels}`,
    candidates: [entry],
  };
}

/** Id comparison: trim both ends, case-insensitive. In the registry an id is an identifier, not free text. */
function sameToken(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
