import { createHash } from "node:crypto";
import {
  channelMentionSchema,
  resolveChannelReplyParts,
  type ChannelContentPart,
  type ChannelReplyHostRequest,
  type ChannelReplyResult,
} from "@zcode/shared";

type Mention = Extract<ChannelContentPart, { type: "channelMention" }>;
type Clarification = Extract<ChannelReplyResult, { status: "needs_clarification" }>;
const MAX_CANDIDATES = 10;
const normalizeName = (name: string) => name.normalize("NFKC").trim().toLowerCase();

/** Names are lookup keys only; candidate identities come from the provider directory or authorized native peers. */
export function resolveChannelMentionNames(
  parts: ChannelReplyHostRequest["parts"],
  trusted: ChannelContentPart[],
  members: Record<string, string> | undefined,
  scope: string,
  channel: "feishu" | "lark",
  nameCandidates: ChannelContentPart[] = [],
): { parts: ChannelContentPart[] } | Clarification {
  const nodes: Mention[] = [...trusted, ...nameCandidates].filter(
    (part): part is Mention => part.type === "channelMention",
  );
  for (const [targetId, name] of Object.entries(members ?? {})) {
    const node = channelMentionSchema.safeParse({
      type: "channelMention",
      targetId,
      name,
      channel,
      refId: "directory",
      idType: "open_id",
      entityType: "user",
    });
    if (node.success) nodes.push(node.data);
  }
  const resolved: ChannelContentPart[] = [];
  const unresolved: Clarification["unresolved"] = [];
  for (const part of parts) {
    if (part.type !== "mentionName") {
      // Resolve trusted refs with the original semantics; model-provided names are never refs or platform IDs.
      if (part.type === "text") resolved.push(part);
      else resolved.push(...resolveChannelReplyParts([part], trusted));
      continue;
    }
    const byId = new Map<string, Mention>();
    for (const node of nodes) {
      if (
        node.channel === channel &&
        normalizeName(part.name) &&
        normalizeName(node.name).includes(normalizeName(part.name))
      )
        byId.set(node.targetId, node);
    }
    const candidates = [...byId.values()]
      .sort((a, b) => a.targetId.localeCompare(b.targetId))
      .map((node) => ({
        node,
        ref: `name:${createHash("sha256")
          .update(JSON.stringify([scope, node.targetId]))
          .digest("hex")}`,
      }));
    const exact = candidates.filter(
      ({ node }) => normalizeName(node.name) === normalizeName(part.name),
    );
    const automatic =
      exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
    const selected = part.candidateRef
      ? candidates.find((candidate) => candidate.ref === part.candidateRef)
      : automatic;
    // On lookup failure an incomplete candidate set must not count as a unique match, bot peers included.
    if (members && selected) {
      resolved.push({ ...selected.node, refId: selected.ref });
      continue;
    }
    // Historical bug: the first failure returned early and unlooked-up names were reported as resolved; collect every failure.
    unresolved.push({
      name: part.name,
      reason: !members
        ? "unavailable"
        : part.candidateRef
          ? "selection_expired"
          : candidates.length
            ? "ambiguous"
            : "not_found",
      candidates: members
        ? candidates.slice(0, MAX_CANDIDATES).map(({ node, ref }) => ({
            ref,
            name: node.name,
            kind: node.entityType,
            label: `${node.name} (${node.entityType}, …${node.targetId.slice(-6)})`,
          }))
        : [],
      truncated: candidates.length > MAX_CANDIDATES,
    });
  }
  return unresolved.length ? { status: "needs_clarification", unresolved } : { parts: resolved };
}
