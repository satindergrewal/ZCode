/**
 * `applyArtifactItems` - folds a stream of `report(item, artifactId)` entries into the preset
 * boards' view models.
 *
 * Pure functions, no React: the board stores **no data**; every point / row / card is a journal
 * entry with `kind = "report"` matching `artifact_id`. Replaying the same entries twice must
 * produce the same picture, so no time, randomness or external state is allowed here; folding rules
 * belong to the spec alone.
 *
 * Entries are **append-only** (journals are), so all four folds complete in a single pass in arrival
 * order.
 */

import {
  artifactFieldLabel,
  chartSeriesFields,
  type ArtifactChartScale,
  type ArtifactChartType,
  type ArtifactField,
  type ArtifactPresetKind,
  type ArtifactPresetSpec,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/spec.js";

/**
 * One arrived entry. `sequence` is the run-global monotonic event number - both the React key
 * (the new-point reveal uses it to tell new points apart) and the incremental-fetch cursor;
 * `siteId x ordinal` is the journal identity (the Results-area key idiom), the row/card identity
 * when the spec declares no key.
 */
export type ArtifactItem = {
  sequence: number;
  siteId: string;
  ordinal: number;
  item: unknown;
};

export type ChartSeriesModel = {
  /** recharts dataKey; an ordinal, not a field path - dots in paths would read as nesting. */
  key: string;
  field: string;
  label: string;
  unit?: string;
  /** Palette slot (see seriesColorVar). */
  colorIndex: number;
};

export type ChartPointModel = Record<string, number | string | null> & {
  /** Stable React key: only new points play the reveal; existing ones never replay. */
  sequence: number;
  /** Position on the x axis; the arrival index for non-numeric x. */
  x: number;
  /** Label shown on the x axis tick. */
  xLabel: string;
};

export type ChartModel = {
  kind: "chart";
  type: ArtifactChartType;
  scale: ArtifactChartScale;
  series: ChartSeriesModel[];
  points: ChartPointModel[];
  x: { label: string; unit?: string; numeric: boolean };
  /** Reference line: from the first entry carrying the field; non-positive values dropped on log axes too. */
  baseline?: { value: number; label: string; unit?: string };
  /** Domain for the memo comparator; absent with no points. */
  domain?: { xMin: number; xMax: number; yMin: number; yMax: number };
};

type TableColumnModel = { field: string; label: string; unit?: string };
type TableRowModel = { id: string; sequence: number; cells: string[] };
type TableModel = {
  kind: "table";
  columns: TableColumnModel[];
  rows: TableRowModel[];
};

export type MetricTileModel = {
  field: string;
  label: string;
  unit?: string;
  /** Value from the last entry carrying the field; absent if it never appeared. */
  value?: string;
  raw?: unknown;
  /** Which entry the value came from - the animation key on tile refresh. */
  sequence?: number;
};
type MetricsModel = { kind: "metrics"; metrics: MetricTileModel[] };

export type BoardCardModel = {
  id: string;
  sequence: number;
  title: string;
  status: string;
  details: { label: string; value: string; unit?: string }[];
};
export type BoardColumnModel = {
  id: string;
  /** The other column has no spec-provided name; renderers label it via labels.otherColumn. */
  other: boolean;
  cards: BoardCardModel[];
};
type BoardModel = {
  kind: "board";
  columns: BoardColumnModel[];
  cardCount: number;
};

type ArtifactPresetModel = ChartModel | TableModel | MetricsModel | BoardModel;

/** Column id for the trailing other column; a same-named spec column merges into it - acceptable. */
const BOARD_OTHER_COLUMN_ID = "__other__";

/**
 * Dot-path lookup: "timing.after", "rounds.0.ms".
 * Numeric segments index arrays; an unresolvable path returns `undefined` (= the entry lacks the field).
 */
function readArtifactField(item: unknown, path: string): unknown {
  const segments = path.split(".");
  let cursor: unknown = item;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) {
      return undefined;
    }
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return undefined;
      }
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Does this entry carry the field? Both `undefined` and `null` count as no: if metrics'
 * last-carrying-entry treated explicit null as a value, one cleared reading would pin the tile to
 * empty forever.
 */
function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Numeric coercion: real numbers pass; numeric strings accepted too (values scraped from command output often arrive as strings). */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Display text for cells / card details. Objects via compact JSON - far more useful than [object Object]. */
function formatArtifactValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // Cyclic refs etc.: prefer a placeholder line over throwing away the whole table.
    return String(value);
  }
}

function seriesKey(index: number): string {
  return `y${index}`;
}

function applyChart(spec: ChartSpec, items: readonly ArtifactItem[]): ChartModel {
  const fields = chartSeriesFields(spec);
  const series: ChartSeriesModel[] = fields.map((field, index) => ({
    key: seriesKey(index),
    field: field.field,
    label: artifactFieldLabel(field),
    ...(field.unit ? { unit: field.unit } : {}),
    colorIndex: index,
  }));

  type Raw = { sequence: number; x: unknown; values: (number | undefined)[] };
  const raws: Raw[] = [];
  let baseline: ChartModel["baseline"];

  for (const entry of items) {
    const rawX = readArtifactField(entry.item, spec.x.field);
    if (!hasValue(rawX)) {
      // Entries without any x have no place on the graph; skip silently (they remain visible in Results).
      continue;
    }
    const values = fields.map((field) => {
      const value = toFiniteNumber(readArtifactField(entry.item, field.field));
      if (value === undefined) {
        return undefined;
      }
      // Non-positive values have no place on a log axis - drop that dimension of the point, not the series or the chart.
      return spec.scale === "log" && value <= 0 ? undefined : value;
    });
    raws.push({ sequence: entry.sequence, x: rawX, values });

    if (spec.baseline && !baseline) {
      const raw = readArtifactField(entry.item, spec.baseline.field);
      const value = toFiniteNumber(raw);
      if (value !== undefined && !(spec.scale === "log" && value <= 0)) {
        baseline = {
          value,
          label: artifactFieldLabel(spec.baseline),
          ...(spec.baseline.unit ? { unit: spec.baseline.unit } : {}),
        };
      }
    }
  }

  // Sort only when every x is numeric. One non-numeric value degrades the whole axis to arrival order - a half-sorted axis lies worse than an unsorted one.
  const numericX = raws.length > 0 && raws.every((raw) => toFiniteNumber(raw.x) !== undefined);
  const ordered = numericX
    ? [...raws].sort((left, right) => {
        const delta = toFiniteNumber(left.x)! - toFiniteNumber(right.x)!;
        // Ties break by arrival order so the same entries always fold into the same order.
        return delta !== 0 ? delta : left.sequence - right.sequence;
      })
    : raws;

  const points: ChartPointModel[] = ordered.map((raw, index) => {
    const x = numericX ? toFiniteNumber(raw.x)! : index;
    const point: ChartPointModel = {
      sequence: raw.sequence,
      x,
      xLabel: formatArtifactValue(raw.x),
    };
    raw.values.forEach((value, seriesIndex) => {
      point[seriesKey(seriesIndex)] = value ?? null;
    });
    return point;
  });

  const yValues = ordered.flatMap((raw) =>
    raw.values.filter((value): value is number => value !== undefined),
  );
  const domain =
    points.length > 0 && yValues.length > 0
      ? {
          xMin: Math.min(...points.map((point) => point.x)),
          xMax: Math.max(...points.map((point) => point.x)),
          yMin: Math.min(...yValues),
          yMax: Math.max(...yValues),
        }
      : undefined;

  return {
    kind: "chart",
    type: spec.type ?? "line",
    scale: spec.scale ?? "linear",
    series,
    points,
    x: {
      label: artifactFieldLabel(spec.x),
      ...(spec.x.unit ? { unit: spec.x.unit } : {}),
      numeric: numericX,
    },
    ...(baseline ? { baseline } : {}),
    ...(domain ? { domain } : {}),
  };
}

function applyTable(spec: TableSpec, items: readonly ArtifactItem[]): TableModel {
  const columns: TableColumnModel[] = spec.columns.map((column) => ({
    field: column.field,
    label: artifactFieldLabel(column),
    ...(column.unit ? { unit: column.unit } : {}),
  }));

  // key present = upsert: later entries replace the row, but the row keeps its first-appearance
  // position - a table that re-sorts live is unreadable.
  const byId = new Map<string, TableRowModel>();
  for (const entry of items) {
    const keyValue = spec.key ? readArtifactField(entry.item, spec.key) : undefined;
    // Without a key (or declared but absent on this entry) fall back to the journal identity:
    // siteId@ordinal is unique per entry, so upsert degenerates to append - one path, two modes.
    const id = hasValue(keyValue)
      ? formatArtifactValue(keyValue)
      : `${entry.siteId}@${entry.ordinal}`;
    byId.set(id, {
      id,
      sequence: entry.sequence,
      cells: columns.map((column) =>
        formatArtifactValue(readArtifactField(entry.item, column.field)),
      ),
    });
  }

  return { kind: "table", columns, rows: [...byId.values()] };
}

function applyMetrics(spec: MetricsSpec, items: readonly ArtifactItem[]): MetricsModel {
  const metrics: MetricTileModel[] = spec.metrics.map((metric) => ({
    field: metric.field,
    label: artifactFieldLabel(metric),
    ...(metric.unit ? { unit: metric.unit } : {}),
  }));

  // Each tile finds its own last-carrying-entry - not the last entry of any kind. A heartbeat that
  // only reports stage must not wipe the previous round's p99 to empty.
  for (const entry of items) {
    metrics.forEach((tile, index) => {
      const raw = readArtifactField(entry.item, tile.field);
      if (!hasValue(raw)) {
        return;
      }
      metrics[index] = {
        ...tile,
        value: formatArtifactValue(raw),
        raw,
        sequence: entry.sequence,
      };
    });
  }

  return { kind: "metrics", metrics };
}

function applyBoard(spec: BoardSpec, items: readonly ArtifactItem[]): BoardModel {
  const detail: ArtifactField[] = spec.detail ?? [];
  // Map insertion order = card first-appearance order; state-changing cards keep that order in their column.
  const byId = new Map<string, BoardCardModel>();

  for (const entry of items) {
    const keyValue = readArtifactField(entry.item, spec.key);
    if (!hasValue(keyValue)) {
      // Identity-less entries have no place on a board (the board's whole semantic is upsert-by-key).
      continue;
    }
    const id = formatArtifactValue(keyValue);
    const status = formatArtifactValue(readArtifactField(entry.item, spec.status));
    const titleRaw = spec.cardTitle ? readArtifactField(entry.item, spec.cardTitle) : undefined;
    byId.set(id, {
      id,
      sequence: entry.sequence,
      title: hasValue(titleRaw) ? formatArtifactValue(titleRaw) : id,
      status,
      details: detail.map((field) => ({
        label: artifactFieldLabel(field),
        value: formatArtifactValue(readArtifactField(entry.item, field.field)),
        ...(field.unit ? { unit: field.unit } : {}),
      })),
    });
  }

  const columns: BoardColumnModel[] = spec.columns.map((column) => ({
    id: column,
    other: false,
    cards: [],
  }));
  const listed = new Map(columns.map((column) => [column.id, column]));
  const other: BoardColumnModel = { id: BOARD_OTHER_COLUMN_ID, other: true, cards: [] };

  for (const card of byId.values()) {
    (listed.get(card.status) ?? other).cards.push(card);
  }

  return {
    kind: "board",
    // Other always sorts last and appears only when it holds cards - an empty column crowds an already narrow panel.
    columns: other.cards.length > 0 ? [...columns, other] : columns,
    cardCount: byId.size,
  };
}

export function applyArtifactItems(
  kind: "chart",
  spec: ChartSpec,
  items: readonly ArtifactItem[],
): ChartModel;
export function applyArtifactItems(
  kind: "table",
  spec: TableSpec,
  items: readonly ArtifactItem[],
): TableModel;
export function applyArtifactItems(
  kind: "metrics",
  spec: MetricsSpec,
  items: readonly ArtifactItem[],
): MetricsModel;
export function applyArtifactItems(
  kind: "board",
  spec: BoardSpec,
  items: readonly ArtifactItem[],
): BoardModel;
export function applyArtifactItems(
  kind: ArtifactPresetKind,
  spec: ArtifactPresetSpec,
  items: readonly ArtifactItem[],
): ArtifactPresetModel;
export function applyArtifactItems(
  kind: ArtifactPresetKind,
  spec: ArtifactPresetSpec,
  items: readonly ArtifactItem[],
): ArtifactPresetModel {
  switch (kind) {
    case "chart":
      return applyChart(spec as ChartSpec, items);
    case "table":
      return applyTable(spec as TableSpec, items);
    case "metrics":
      return applyMetrics(spec as MetricsSpec, items);
    case "board":
      return applyBoard(spec as BoardSpec, items);
  }
}
