const SHARE_CONTEXT_BLOCK_PATTERN =
  /(?:\n\n)?# zcode-share-context:\n```zcode-share-context\n([\s\S]*?)\n```\s*$/u;

interface ConversationShareContextReference {
  contextId: string;
  shareUrl: string;
}

/**
 * Extract the share handover context that can still be attached from a conversation snapshot.
 *
 * Deliberately snapshot-only (no standalone args): this wire broke once -- the composer read a
 * parallel sharedContextImport prop SessionPane never passed, so first messages lost sharedContextRefs
 * and the CLI pending->reserved->attached chain starved the model of shared content (the header
 * readonly block still rendered, hiding it). The snapshot is always in hand, so it cannot be dropped.
 *
 * Legacy shapes (title only, no contextId) return null: without contextId there are no
 * sharedContextRefs and nothing to attach.
 */
export function resolveAttachableShareContext(
  sharedContextImport:
    | { contextId: string; title: string; shareUrl: string; status: string }
    | { title: string }
    | null
    | undefined,
): { contextId: string; title: string; shareUrl: string; status: string } | null {
  if (!sharedContextImport || !("contextId" in sharedContextImport)) return null;
  return sharedContextImport.status === "discarded" ? null : sharedContextImport;
}

function isReference(value: unknown): value is ConversationShareContextReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== "contextId" && key !== "shareUrl")) return false;
  if (typeof candidate.contextId !== "string" || typeof candidate.shareUrl !== "string")
    return false;
  try {
    const url = new URL(candidate.shareUrl);
    return /^\/cn\/share\/[^/]+$/u.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Strip the share URL tail block that history messages may carry from the visible body.
 *
 * The block is no longer produced: it was renderer-only (no CLI/shared consumers) and only fed
 * a since-removed chip, at the cost of injecting share URLs into model-bound text. The writer is
 * gone; keep the reader so in-flight messages never render that markup as body.
 */
export function parseConversationShareContext(text: string): {
  visibleContent: string;
  reference: ConversationShareContextReference | null;
} {
  const match = text.match(SHARE_CONTEXT_BLOCK_PATTERN);
  if (!match) return { visibleContent: text, reference: null };
  try {
    const parsed: unknown = JSON.parse(match[1] ?? "");
    return isReference(parsed)
      ? { visibleContent: text.slice(0, match.index).trimEnd(), reference: parsed }
      : { visibleContent: text, reference: null };
  } catch {
    return { visibleContent: text, reference: null };
  }
}
