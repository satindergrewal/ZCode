// Trimmed contentProfile='index' shape for session/read.
// Context: the task index re-reads the session existing-only on every turn completion / rename / visibility change;
// the old path pulled the full history (a long session can hit ~15MB in one shot) and saturated host stdio and JSON parsing,
// while index needs only title / searchableText / hasUserVisibleContent / status / model.
// This strips just the heavyweight payload fields none of those derivations read, keeping message / part count, order, id, type, and metadata intact
// so visibility and projection-policy verdicts match the full snapshot exactly (spec: docs/task/task-sqlite-index.md, 'Index read profile').
// messageLimit is no substitute: searchableData takes the first 200K chars and the title falls back to the first real user input, both history-head bound.
import type { ZCodeSessionStateSnapshot } from "./zcode-protocol/index.js";
import type { ZCodeMessagePart, ZCodeMessageWithParts } from "./zcode-protocol-legacy-types.js";

export type ZCodeSessionContentProfile = "full" | "index";

const ELIDED_DATA_URL = "data:,";

function elidePartForIndex(part: ZCodeMessagePart): ZCodeMessagePart {
  switch (part.type) {
    case "reasoning":
      return part.text ? { ...part, text: "" } : part;
    case "file":
      return part.url.startsWith("data:") && part.url !== ELIDED_DATA_URL
        ? { ...part, url: ELIDED_DATA_URL }
        : part;
    case "tool": {
      const state = part.state;
      switch (state.status) {
        case "pending":
          return { ...part, state: { ...state, input: {}, raw: "" } };
        case "running":
          return {
            ...part,
            state: { ...state, input: {}, ...(state.metadata ? { metadata: {} } : {}) },
          };
        case "completed":
          return { ...part, state: { ...state, input: {}, output: "", metadata: {} } };
        case "error":
          return {
            ...part,
            state: { ...state, input: {}, error: "", ...(state.metadata ? { metadata: {} } : {}) },
          };
        default:
          return part;
      }
    }
    default:
      return part;
  }
}

function elideMessageForIndex(message: ZCodeMessageWithParts): ZCodeMessageWithParts {
  let changed = false;
  const parts = message.parts.map((part) => {
    const next = elidePartForIndex(part);
    if (next !== part) changed = true;
    return next;
  });
  return changed ? { ...message, parts } : message;
}

/** Builds the lightweight snapshot for the task index; never mutates the input (CLI-side messages can come from a shared cache). */
export function elideSessionSnapshotForIndex<T extends ZCodeSessionStateSnapshot>(snapshot: T): T {
  return { ...snapshot, messages: snapshot.messages.map(elideMessageForIndex) };
}
