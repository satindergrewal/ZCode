import recommendedPluginsConfig from "@/settings/recommendedPlugins.json" with { type: "json" };

// The client-side curated Recommended section is retired (product call: no curated list pinned in the personal segment);
// only the default market id remains -- the default non-official personal market, which several views use for ownership checks.
// To revive the list, the full selectRecommendedPlugins lives in git history.

/** Default market id: shown by default and used to match recommended plugins. */
export const DEFAULT_MARKETPLACE_ID = (recommendedPluginsConfig as { marketplace: string })
  .marketplace;
