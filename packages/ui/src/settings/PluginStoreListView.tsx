import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
/* eslint-disable max-lines -- the store list page binds header/search/installed strip/public-personal segments/featured/category collapses into one coherent browsing surface; splitting it would break the 1:1 layout. */
import { useMemo, useState } from "react";
import { Download, Loader2, Settings2 } from "lucide-react";
import type { PluginStoreOrder, ZCodePluginMarketplaceSummary } from "@zcode/shared";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { PluginStoreCard, type PluginStoreActions } from "@/settings/PluginStoreCard.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import {
  FALLBACK_CATEGORY,
  KNOWN_CATEGORY_LABEL_IDS,
  canUpdatePluginItem,
  groupItemsByCategory,
  isPublicStoreMarketplaceId,
  resolveItemDisplayName,
  selectFeaturedItems,
  sortInstalledStripItems,
  sortPersonalMarketplaceGroups,
  storeItemMatches,
  type PersonalMarketplaceGroup,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { resolveMarketplaceDisplayName } from "@/settings/pluginSourceLabel.js";

// Items shown for a category/marketplace group after manual collapse; fully expanded by default so a few plugins are not hidden again.
const CATEGORY_VISIBLE_LIMIT = 6;
const RETIRED_STORE_PLUGIN_ID = `restore-legacy-sessions@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`;

export type PluginStoreSegment = "public" | "personal";

export function PluginStoreListView({
  items: allItems,
  order,
  marketplaces,
  actions,
  loading,
  query,
  onQueryChange,
  segment,
  onSegmentChange,
  onOpenManage,
}: {
  items: StorePluginItem[];
  order?: PluginStoreOrder | null;
  marketplaces: ZCodePluginMarketplaceSummary[];
  actions: PluginStoreActions;
  loading: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  segment: PluginStoreSegment;
  onSegmentChange: (segment: PluginStoreSegment) => void;
  onOpenManage: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const modeOrder = isOfficeMode ? order?.work : order?.code;
  const keyword = query.trim().toLowerCase();
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  // The legacy session-restore entry left the marketplace; filter it from every browsing projection,
  // including stale caches and featured slots. The full ID only matches the official plugin; the
  // plugin management page keeps using the raw entries to manage existing installs.
  const items = useMemo(
    () => allItems.filter((item) => item.id !== RETIRED_STORE_PLUGIN_ID),
    [allItems],
  );

  const installedItems = useMemo(
    () =>
      sortInstalledStripItems(
        items.filter((item) => item.installed),
        locale,
      ),
    [items, locale],
  );
  const publicItems = useMemo(
    () => items.filter((item) => isPublicStoreMarketplaceId(item.marketplace)),
    [items],
  );
  const personalItems = useMemo(
    () => items.filter((item) => !isPublicStoreMarketplaceId(item.marketplace)),
    [items],
  );

  const resolveCategoryLabel = useMemo(() => {
    return (category: string): string => {
      const labelId = KNOWN_CATEGORY_LABEL_IDS[category];
      return labelId ? intl.formatMessage({ id: labelId }) : category;
    };
  }, [intl]);

  const featuredItems = useMemo(
    () => selectFeaturedItems(publicItems, marketplaces),
    [marketplaces, publicItems],
  );
  const categoryGroups = useMemo(
    () => groupItemsByCategory(publicItems, locale, modeOrder),
    [locale, publicItems, modeOrder],
  );

  // Personal segment: group by marketplace, most recently refreshed first (see sortPersonalMarketplaceGroups).
  const personalGroups = useMemo(() => {
    const claudeCodePlugins = intl.formatMessage({
      id: "settings.plugins.marketplace.claudeCodePlugins",
    });
    const groups = new Map<string, StorePluginItem[]>();
    for (const item of personalItems) {
      const group = groups.get(item.marketplace) ?? [];
      group.push(item);
      groups.set(item.marketplace, group);
    }
    const titled: PersonalMarketplaceGroup[] = [...groups.entries()].map(
      ([marketplace, groupItems]) => ({
        marketplace,
        title: resolveMarketplaceDisplayName(marketplace, marketplaces, claudeCodePlugins),
        items: groupItems.toSorted((left, right) =>
          resolveItemDisplayName(left, locale).localeCompare(
            resolveItemDisplayName(right, locale),
            locale,
          ),
        ),
      }),
    );
    return sortPersonalMarketplaceGroups(titled, marketplaces, locale);
  }, [intl, locale, marketplaces, personalItems]);

  const searchResults = useMemo(() => {
    if (!keyword) return [];
    return items
      .filter((item) => storeItemMatches(item, keyword, locale))
      .toSorted((left, right) =>
        resolveItemDisplayName(left, locale).localeCompare(
          resolveItemDisplayName(right, locale),
          locale,
        ),
      );
  }, [items, keyword, locale]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => ({ ...current, [key]: !(current[key] ?? true) }));
  };

  return (
    <div className="space-y-8" data-testid="plugin-store-list">
      {/* The page title renders in the settings header (settings.plugins.title); start here at the search box to avoid a double title. */}
      {/* Search: spans public + personal; while typing, the segmented layout below gives way to a unified result flow. */}
      <SettingsSearchInput
        data-testid="plugin-store-search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={intl.formatMessage({
          id: "settings.plugins.store.searchPlaceholder",
        })}
      />

      {/* Installed strip: the icon opens details, the gear opens "Manage Installed". */}
      {installedItems.length > 0 ? (
        <section data-testid="plugin-store-installed-strip">
          <div className="flex items-center justify-between border-b border-border pb-2">
            <h2 className="text-ui-lg font-semibold text-foreground">
              {intl.formatMessage({
                id: "settings.plugins.store.installedStrip",
              })}
            </h2>
            <ControlHintTooltip
              title={intl.formatMessage({
                id: "settings.plugins.store.manageInstalled",
              })}
            >
              <Button
                type="button"
                data-testid="plugin-store-manage-open"
                variant="outline"
                size="icon-lg"
                aria-label={intl.formatMessage({
                  id: "settings.plugins.store.manageInstalled",
                })}
                onClick={onOpenManage}
              >
                <Settings2 className="size-4" aria-hidden="true" />
              </Button>
            </ControlHintTooltip>
          </div>
          {/* Horizontal scroll also clips vertical overflow; reserve space for the badge, scaling, and focus ring.
              Narrow screens do not compensate with negative margins, keeping the scroll container inside the page's right edge. */}
          <div className="mt-1 flex items-center gap-3 overflow-x-auto px-2 pt-2 pb-1 sm:-mx-2">
            {installedItems.map((item) => {
              const displayName = resolveItemDisplayName(item, locale);
              const updating = actions.operationId === `plugin:update:${item.id}`;
              return (
                <ControlHintTooltip key={item.id} title={displayName} side="top" sideOffset={8}>
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      data-testid="plugin-store-installed-item"
                      data-plugin-id={item.id}
                      aria-label={displayName}
                      className="shrink-0 rounded-xl transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      onClick={() => actions.onOpenDetail(item.id)}
                    >
                      {/* The Installed Strip only expresses the installed set; enabled state lives in the manage view, avoiding opacity tricks that muddy brand icons. */}
                      <PluginStoreAvatar item={item} className="size-10" />
                    </button>
                    {canUpdatePluginItem(item) ? (
                      <button
                        type="button"
                        data-testid="plugin-store-installed-item-update"
                        data-plugin-id={item.id}
                        aria-label={intl.formatMessage({ id: "settings.plugins.detail.update" })}
                        className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-success text-success-foreground shadow-sm transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused disabled:opacity-60"
                        disabled={actions.operationId !== null}
                        onClick={(event) => {
                          event.stopPropagation();
                          actions.onUpdate(item.id);
                        }}
                      >
                        {updating ? (
                          <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Download className="size-2.5" aria-hidden="true" />
                        )}
                      </button>
                    ) : null}
                  </div>
                </ControlHintTooltip>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Public / personal segments. */}
      <div className="flex items-center gap-1.5">
        <SegmentPill
          active={segment === "public"}
          testId="plugin-store-segment-public"
          label={intl.formatMessage({
            id: "settings.plugins.store.segment.public",
          })}
          onClick={() => onSegmentChange("public")}
        />
        <SegmentPill
          active={segment === "personal"}
          testId="plugin-store-segment-personal"
          label={intl.formatMessage({
            id: "settings.plugins.store.segment.personal",
          })}
          onClick={() => onSegmentChange("personal")}
        />
      </div>

      {keyword ? (
        <StoreSection
          key="search"
          title={intl.formatMessage(
            { id: "settings.plugins.store.searchResults" },
            { count: String(searchResults.length) },
          )}
        >
          {searchResults.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.plugins.store.searchEmpty" })}
            </p>
          ) : (
            <CardGrid items={searchResults} actions={actions} locale={locale} />
          )}
        </StoreSection>
      ) : segment === "public" ? (
        <PublicSegment
          actions={actions}
          categoryGroups={categoryGroups}
          expandedGroups={expandedGroups}
          featuredItems={featuredItems}
          loading={loading}
          locale={locale}
          resolveCategoryLabel={resolveCategoryLabel}
          onToggleGroup={toggleGroup}
        />
      ) : (
        <PersonalSegment
          actions={actions}
          expandedGroups={expandedGroups}
          groups={personalGroups}
          locale={locale}
          onToggleGroup={toggleGroup}
        />
      )}
    </div>
  );
}

export function SegmentPill({
  active,
  label,
  onClick,
  testId,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      className={cn(
        "rounded-full px-3 py-1 text-ui-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
        active
          ? "bg-selected text-foreground"
          : "text-foreground-subtle hover:bg-hover hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function StoreSection({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="pb-2">
        <h2 className="text-ui-lg font-semibold text-foreground">{title}</h2>
      </div>
      <div aria-hidden="true" className="h-px bg-surface" />
      <div className="mt-2">{children}</div>
    </section>
  );
}

function CardGrid({
  items,
  actions,
  locale,
}: {
  items: StorePluginItem[];
  actions: PluginStoreActions;
  locale: string;
}) {
  return (
    <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
      {items.map((item) => (
        <PluginStoreCard key={item.id} item={item} actions={actions} locale={locale} />
      ))}
    </div>
  );
}

/** Category/marketplace group: fully expanded by default; once manually collapsed, shows the first 6 plus an expand control. */
function CollapsibleCardGroup({
  groupKey,
  items,
  expanded,
  onToggle,
  actions,
  locale,
}: {
  groupKey: string;
  items: StorePluginItem[];
  expanded: boolean;
  onToggle: (key: string) => void;
  actions: PluginStoreActions;
  locale: string;
}) {
  const { intl } = useZCodeIntl();
  const visible = expanded ? items : items.slice(0, CATEGORY_VISIBLE_LIMIT);
  const hidden = expanded ? [] : items.slice(CATEGORY_VISIBLE_LIMIT);
  const hiddenNames = hidden.slice(0, 2).map((item) => resolveItemDisplayName(item, locale));
  return (
    <div>
      <CardGrid items={visible} actions={actions} locale={locale} />
      {hidden.length > 0 ? (
        <button
          type="button"
          data-testid="plugin-store-group-toggle"
          data-group-key={groupKey}
          className="mt-2 flex w-full min-w-0 items-center gap-2 rounded-xl px-2 py-2 text-left text-ui-base text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          onClick={() => onToggle(groupKey)}
        >
          <span className="flex shrink-0 items-center gap-1.5" aria-hidden="true">
            {hidden.slice(0, 3).map((item) => (
              <PluginStoreAvatar
                key={item.id}
                item={item}
                className="size-5 rounded-md"
                iconClassName="size-2.5"
              />
            ))}
          </span>
          <span className="min-w-0 truncate">
            {hidden.length > hiddenNames.length
              ? intl.formatMessage(
                  { id: "settings.plugins.store.viewMore" },
                  {
                    names: hiddenNames.join(intl.formatMessage({ id: "common.listSeparator" })),
                    count: String(hidden.length - hiddenNames.length),
                  },
                )
              : intl.formatMessage(
                  { id: "settings.plugins.store.viewMoreFew" },
                  {
                    names: hiddenNames.join(intl.formatMessage({ id: "common.listSeparator" })),
                  },
                )}
          </span>
        </button>
      ) : expanded && items.length > CATEGORY_VISIBLE_LIMIT ? (
        <button
          type="button"
          data-testid="plugin-store-group-toggle"
          data-group-key={groupKey}
          className="mt-2 rounded-xl px-2 py-2 text-ui-base text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          onClick={() => onToggle(groupKey)}
        >
          {intl.formatMessage({ id: "settings.plugins.store.showLess" })}
        </button>
      ) : null}
    </div>
  );
}

function PublicSegment({
  actions,
  categoryGroups,
  expandedGroups,
  featuredItems,
  loading,
  locale,
  resolveCategoryLabel,
  onToggleGroup,
}: {
  actions: PluginStoreActions;
  categoryGroups: ReturnType<typeof groupItemsByCategory>;
  expandedGroups: Record<string, boolean>;
  featuredItems: StorePluginItem[];
  loading: boolean;
  locale: string;
  resolveCategoryLabel: (category: string) => string;
  onToggleGroup: (key: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const isEmpty = featuredItems.length === 0 && categoryGroups.length === 0;
  if (isEmpty) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle">
        {loading
          ? intl.formatMessage({
              id: "settings.plugins.marketplace.catalogLoading",
            })
          : intl.formatMessage({
              id: "settings.plugins.marketplacePlugins.empty",
            })}
      </p>
    );
  }
  return (
    <div>
      {featuredItems.length > 0 ? (
        <StoreSection
          title={intl.formatMessage({ id: "settings.plugins.store.featured" })}
          className="py-4 first:pt-0 last:pb-0"
        >
          <CardGrid items={featuredItems} actions={actions} locale={locale} />
        </StoreSection>
      ) : null}
      {categoryGroups.map((group) => (
        <StoreSection
          key={group.category}
          className="py-4 first:pt-0 last:pb-0"
          title={
            group.category === FALLBACK_CATEGORY
              ? intl.formatMessage({
                  id: "settings.plugins.store.category.other",
                })
              : resolveCategoryLabel(group.category)
          }
        >
          <CollapsibleCardGroup
            groupKey={`category:${group.category}`}
            items={group.items}
            expanded={expandedGroups[`category:${group.category}`] ?? true}
            onToggle={onToggleGroup}
            actions={actions}
            locale={locale}
          />
        </StoreSection>
      ))}
    </div>
  );
}

function PersonalSegment({
  actions,
  expandedGroups,
  groups,
  locale,
  onToggleGroup,
}: {
  actions: PluginStoreActions;
  expandedGroups: Record<string, boolean>;
  groups: PersonalMarketplaceGroup[];
  locale: string;
  onToggleGroup: (key: string) => void;
}) {
  const { intl } = useZCodeIntl();
  if (groups.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.store.personalEmpty" })}
      </p>
    );
  }
  return (
    <div>
      {groups.map((group) => (
        <StoreSection
          key={group.marketplace}
          title={group.title}
          className="py-4 first:pt-0 last:pb-0"
        >
          <CollapsibleCardGroup
            groupKey={`marketplace:${group.marketplace}`}
            items={group.items}
            expanded={expandedGroups[`marketplace:${group.marketplace}`] ?? true}
            onToggle={onToggleGroup}
            actions={actions}
            locale={locale}
          />
        </StoreSection>
      ))}
    </div>
  );
}
