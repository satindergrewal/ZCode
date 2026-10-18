import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TID_RESOURCE_MANAGER_TAB,
  testId,
  type ResourceUsageCategory,
  type ResourceUsageSnapshot,
  type StorageManagementBridge,
} from "@zcode/shared";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/index.js";
import { StorageSection } from "./storage/StorageSection.js";
import { UNSAMPLED_PLACEHOLDER, UsageGroup, UsageMeter } from "./resourceUsageParts.js";
import {
  clampPercent,
  formatBytes,
  formatPercent,
  groupResourceUsage,
  type ResourceUsageGroupView,
} from "./resourceUsageView.js";

export interface ResourceManagerAppProps {
  /** Absent means the bridge is unavailable (e.g. non-desktop environments). */
  getSnapshot?: () => Promise<ResourceUsageSnapshot>;
  setSamplingActive?: (active: boolean) => void;
  /** Storage bridge (window.resourceManager.storage); the "storage" tab shows unavailable when absent. */
  storage?: StorageManagementBridge;
  refreshIntervalMs?: number;
  /** Initial tab; defaults to CPU. */
  initialTab?: ResourceManagerTab;
}

export type ResourceManagerTab = "cpu" | "memory" | "storage";
const RESOURCE_MANAGER_TABS: ResourceManagerTab[] = ["cpu", "memory", "storage"];
const TAB_LABEL_IDS: Record<ResourceManagerTab, string> = {
  cpu: "resourceManager.cpu",
  memory: "resourceManager.memory",
  storage: "resourceManager.storage",
};

const DEFAULT_REFRESH_INTERVAL_MS = 1_000;
const CATEGORY_LABEL_IDS: Record<ResourceUsageCategory, string> = {
  base: "resourceManager.category.base",
  "builtin-plugin": "resourceManager.category.builtinPlugin",
  "community-plugin": "resourceManager.category.communityPlugin",
};

/**
 * Resource-manager window UI.
 * Lives in packages/ui so Tailwind picks it up; the desktop's standalone renderer entry only mounts it.
 */
export function ResourceManagerApp({
  getSnapshot,
  setSamplingActive,
  storage,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  initialTab = "cpu",
}: ResourceManagerAppProps) {
  const { intl } = useZCodeIntl();
  const [tab, setTab] = useState<ResourceManagerTab>(initialTab);
  // CPU / memory share one process snapshot; polling stops while the storage tab is active to
  // avoid contending with the disk scan for IO.
  const pollingActive = tab !== "storage";
  const [snapshot, setSnapshot] = useState<ResourceUsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<ResourceUsageCategory, boolean>>({
    base: true,
    "builtin-plugin": true,
    "community-plugin": true,
  });

  useEffect(() => {
    if (!getSnapshot) {
      setError(intl.formatMessage({ id: "resourceManager.unavailable" }));
      return;
    }
    if (!pollingActive) return;
    setSamplingActive?.(true);
    let disposed = false;
    let inFlight = false;

    async function refresh() {
      // Requests stay serial: never stack a new one while the previous round is still
      // in flight (slow Host sampling).
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await getSnapshot!();
        if (disposed) return;
        setSnapshot(next);
        setError(null);
      } catch (err) {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
      }
    }

    void refresh();
    const interval = window.setInterval(() => void refresh(), refreshIntervalMs);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      // Stopping the renderer timer is not enough; in-flight Host sampling must be
      // cancelled with the page lifecycle too.
      setSamplingActive?.(false);
    };
  }, [getSnapshot, intl, pollingActive, refreshIntervalMs, setSamplingActive]);

  const groups = useMemo(() => groupResourceUsage(snapshot?.processes ?? []), [snapshot]);
  const toggleGroup = useCallback((category: ResourceUsageCategory) => {
    setExpanded((current) => ({ ...current, [category]: !current[category] }));
  }, []);

  return (
    <main
      className="flex h-dvh min-h-0 flex-col bg-background text-foreground"
      data-testid="resource-manager"
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-header px-4">
        <div className="min-w-0">
          <h1 className="truncate text-ui-base font-medium">
            {intl.formatMessage({ id: "resourceManager.title" })}
          </h1>
          {pollingActive ? (
            <div className="text-ui-xs text-foreground-subtle">
              {snapshot
                ? intl.formatMessage(
                    { id: "resourceManager.processCount" },
                    { count: snapshot.processes.length },
                  )
                : intl.formatMessage({ id: "resourceManager.loading" })}
            </div>
          ) : null}
        </div>
        <Tabs value={tab} onValueChange={(value) => setTab(value as ResourceManagerTab)}>
          <TabsList variant="line" className="h-8 gap-1 p-0">
            {RESOURCE_MANAGER_TABS.map((item) => (
              <TabsTrigger
                key={item}
                value={item}
                data-testid={testId(TID_RESOURCE_MANAGER_TAB, item)}
                className="h-8 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
              >
                {intl.formatMessage({ id: TAB_LABEL_IDS[item] })}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      <div className="min-h-0 flex-1 overflow-auto bg-background-alt p-4">
        {tab === "storage" ? (
          <StorageSection bridge={storage} active={tab === "storage"} />
        ) : (
          <UsageTabContent
            metric={tab}
            snapshot={snapshot}
            error={error}
            groups={groups}
            expanded={expanded}
            onToggleGroup={toggleGroup}
          />
        )}
      </div>
    </main>
  );
}

/** CPU / memory tab body: metric card on the left; the grouped list on the right shows only the active metric column. */
function UsageTabContent({
  metric,
  snapshot,
  error,
  groups,
  expanded,
  onToggleGroup,
}: {
  metric: "cpu" | "memory";
  snapshot: ResourceUsageSnapshot | null;
  error: string | null;
  groups: ResourceUsageGroupView[];
  expanded: Record<ResourceUsageCategory, boolean>;
  onToggleGroup: (category: ResourceUsageCategory) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <>
      {error ? (
        <div
          className="rounded-xl border border-destructive/30 bg-card px-4 py-3 text-ui-sm text-destructive"
          data-testid="resource-manager-error"
        >
          {error}
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-4">
          {metric === "cpu" ? (
            <UsageMeter
              testId="resource-manager-cpu"
              label={intl.formatMessage({ id: "resourceManager.cpu" })}
              appValue={snapshot ? formatPercent(snapshot.app.cpuPercent) : UNSAMPLED_PLACEHOLDER}
              systemValue={
                snapshot ? formatPercent(snapshot.system.cpuPercent) : UNSAMPLED_PLACEHOLDER
              }
              appPercent={snapshot ? clampPercent(snapshot.app.cpuPercent) : 0}
              systemPercent={snapshot ? clampPercent(snapshot.system.cpuPercent) : 0}
              appLabel={intl.formatMessage({ id: "resourceManager.appUsage" })}
              systemLabel={intl.formatMessage({ id: "resourceManager.systemUsage" })}
            />
          ) : (
            <UsageMeter
              testId="resource-manager-memory"
              label={intl.formatMessage({ id: "resourceManager.memory" })}
              appValue={snapshot ? formatBytes(snapshot.app.memoryBytes) : UNSAMPLED_PLACEHOLDER}
              systemValue={
                snapshot
                  ? `${formatBytes(snapshot.system.memoryUsedBytes)} / ${formatBytes(snapshot.system.memoryTotalBytes)}`
                  : UNSAMPLED_PLACEHOLDER
              }
              appPercent={
                snapshot && snapshot.system.memoryTotalBytes > 0
                  ? clampPercent(
                      (snapshot.app.memoryBytes / snapshot.system.memoryTotalBytes) * 100,
                    )
                  : 0
              }
              systemPercent={
                snapshot && snapshot.system.memoryTotalBytes > 0
                  ? clampPercent(
                      (snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes) * 100,
                    )
                  : 0
              }
              appLabel={intl.formatMessage({ id: "resourceManager.appUsage" })}
              systemLabel={intl.formatMessage({ id: "resourceManager.systemUsage" })}
            />
          )}
        </aside>

        <section className="flex min-w-0 flex-col gap-3">
          {groups.map((group) => (
            <UsageGroup
              key={group.category}
              group={group}
              metric={metric}
              title={intl.formatMessage({ id: CATEGORY_LABEL_IDS[group.category] })}
              expanded={expanded[group.category]}
              onToggle={() => onToggleGroup(group.category)}
              emptyText={intl.formatMessage({ id: "resourceManager.empty" })}
              samplingText={intl.formatMessage({ id: "resourceManager.sampling" })}
              columns={{
                process: intl.formatMessage({ id: "resourceManager.column.process" }),
                pid: intl.formatMessage({ id: "resourceManager.column.pid" }),
                cpu: intl.formatMessage({ id: "resourceManager.cpu" }),
                memory: intl.formatMessage({ id: "resourceManager.memory" }),
              }}
            />
          ))}
        </section>
      </div>
    </>
  );
}
