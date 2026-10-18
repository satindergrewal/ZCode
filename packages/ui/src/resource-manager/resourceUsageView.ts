import type { ResourceUsageCategory, ResourceUsageProcess } from "@zcode/shared";

/** Fixed group order: core services / built-in plugins / community. */
export const RESOURCE_USAGE_CATEGORY_ORDER: readonly ResourceUsageCategory[] = [
  "base",
  "builtin-plugin",
  "community-plugin",
];

export interface ResourceUsageGroupView {
  category: ResourceUsageCategory;
  processCount: number;
  cpuPercent: number;
  memoryBytes: number;
  /** Any process missing samples in this group. */
  hasUnsampled: boolean;
  /** CPU desc, memory desc, pid asc. */
  processes: ResourceUsageProcess[];
}

export function groupResourceUsage(
  processes: readonly ResourceUsageProcess[],
): ResourceUsageGroupView[] {
  return RESOURCE_USAGE_CATEGORY_ORDER.map((category) => {
    const members = processes
      .filter((process) => process.category === category)
      .sort(
        (left, right) =>
          right.cpuPercent - left.cpuPercent ||
          right.memoryBytes - left.memoryBytes ||
          left.pid - right.pid,
      );
    return {
      category,
      processCount: members.length,
      cpuPercent: roundPercent(members.reduce((sum, process) => sum + process.cpuPercent, 0)),
      memoryBytes: members.reduce((sum, process) => sum + process.memoryBytes, 0),
      hasUnsampled: members.some((process) => !process.sampled),
      processes: members,
    };
  });
}

export function roundPercent(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

export function formatPercent(value: number): string {
  return `${roundPercent(value).toFixed(1)}%`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unitIndex]}`;
}
