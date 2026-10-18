import type { MentionItem } from "@/mentions/mentionTypes.js";

/**
 * Safety-net cap for virtualized display. Large enough to never feel
 * "incomplete" to users, small enough to keep fuzzy-sort and virtualizer
 * memory in check for enormous monorepos.
 */
const MENTION_DISPLAY_CAP = 1000;
export const MENTION_DEFAULT_GROUP_PREVIEW_LIMIT = 3;
export const MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT = 10;

export function hasMentionQuery(query: string): boolean {
  return query.trim().length > 0;
}

export function getMentionGroupLimitForQuery(
  query: string,
  defaultLimit = MENTION_DEFAULT_GROUP_PREVIEW_LIMIT,
): number | undefined {
  return hasMentionQuery(query) ? undefined : defaultLimit;
}

interface FilterMentionItemsOptions {
  limit?: number;
  requireQuery?: boolean;
}

export interface MentionResultGroup<TItem = MentionItem> {
  id: string;
  title: string;
  items: TItem[];
  loading: boolean;
  errorText: string | null;
  emptyText: string;
}

export function buildVisibleMentionGroups<TItem>(
  groups: MentionResultGroup<TItem>[],
): MentionResultGroup<TItem>[] {
  return groups.filter(
    (group) => group.loading || group.errorText !== null || group.items.length > 0,
  );
}

// CJK queries use prefix/substring matching only: per-character subsequence matching is too loose for CJK, and
// CJK users expect contiguous substring hits; Latin queries keep subsequence matching.
const HAN_QUERY_RE = /\p{Script=Han}/u;

function scoreFuzzyMatch(text: string, query: string): number | null {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedText) {
    return null;
  }

  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  if (HAN_QUERY_RE.test(normalizedQuery)) {
    return null;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

function sortScoredItems<T>(
  items: T[],
  getScore: (item: T) => number | null,
  getLabel: (item: T) => string,
): T[] {
  return items
    .map((item, index) => {
      const score = getScore(item);
      if (score === null) {
        return null;
      }

      return { index, item, score };
    })
    .filter(
      (
        item,
      ): item is {
        index: number;
        item: T;
        score: number;
      } => item !== null,
    )
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      if (left.index !== right.index) {
        return left.index - right.index;
      }

      return getLabel(left.item).localeCompare(getLabel(right.item));
    })
    .map((item) => item.item);
}

function applyMentionItemLimit(items: MentionItem[], limit?: number): MentionItem[] {
  if (!Number.isFinite(limit)) {
    return items;
  }

  const safeLimit = Math.max(0, Math.trunc(limit ?? 0));
  return items.slice(0, safeLimit);
}

function getDefaultMentionItemPriority(item: MentionItem): number {
  if (item.category !== "files") {
    return 0;
  }
  return item.data?.kind === "directory" ? 1 : 0;
}

function sortDefaultMentionItems(items: MentionItem[]): MentionItem[] {
  return items
    .map((item, index) => ({ index, item, priority: getDefaultMentionItemPriority(item) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ item }) => item);
}

export function filterMentionItemsWithOptions(
  items: MentionItem[],
  query: string,
  options: FilterMentionItemsOptions = {},
): MentionItem[] {
  const effectiveLimit = options.limit ?? MENTION_DISPLAY_CAP;
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    // The @ panel lands here as soon as it opens. Returning every file for an empty query
    // used to render thousands of options at once, and every arrow-key move re-rendered the whole list, which feels very sluggish.
    // Support require-query-before-results and keep the result cap, so a huge list never hits the renderer again.
    return options.requireQuery
      ? []
      : applyMentionItemLimit(sortDefaultMentionItems(items), effectiveLimit);
  }

  return applyMentionItemLimit(
    sortScoredItems(
      items,
      (item) => {
        const labelScore = scoreFuzzyMatch(item.label, normalizedQuery);
        // Long plugin descriptions are display-only, keeping subsequence matches from dragging in unrelated candidates (plugin-reference-mention).
        const descriptionScore =
          item.category === "plugins" ? null : scoreFuzzyMatch(item.description, normalizedQuery);
        const valueScore = scoreFuzzyMatch(item.value, normalizedQuery);
        const keywordScore = Math.min(
          ...(item.keywords ?? []).map((keyword) => {
            const score = scoreFuzzyMatch(keyword, normalizedQuery);
            return score === null ? Number.POSITIVE_INFINITY : score + 300;
          }),
          Number.POSITIVE_INFINITY,
        );
        const bestScore = Math.min(
          labelScore ?? Number.POSITIVE_INFINITY,
          valueScore !== null ? valueScore + 25 : Number.POSITIVE_INFINITY,
          descriptionScore !== null ? descriptionScore + 100 : Number.POSITIVE_INFINITY,
          keywordScore,
        );

        return Number.isFinite(bestScore) ? bestScore : null;
      },
      (item) => item.label,
    ),
    effectiveLimit,
  );
}
