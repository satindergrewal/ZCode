/**
 * Type mirrors + lenient parsing for preset artifact (chart / table / metrics / board) specs.
 *
 * `artifact` here is the **user-facing** one: a board declared by the script via
 * `artifact.chart(id, spec)` and fed by the `report(item, id)` stream -- not the engine-internal
 * `RunSettlement.artifact` "top-level return value".
 *
 * **Why parse again UI-side.** Authoritative spec validation lives in the engine (zod; invalid
 * shapes failRun), the journal stores canonical JSON, and by the time it reaches the renderer via
 * the v4 projection the type has degraded to `unknown`. What the renderer gets may be a valid spec
 * from a new CLI, a partial spec from an old CLI, or a truncated/mangled row. Renderers must not
 * throw over these and blow up the side pane -- this layer therefore performs only **structural**
 * checks, returning the normalized spec when renderable and `undefined` otherwise (the caller
 * degrades to a "cannot render" card).
 *
 * Lenient = extra keys ignored as-is, broken optional fields dropped, only missing required fields
 * mean unrenderable.
 */

/** One value from a report entry: a dot path into the item ("timing.after"). */
export type ArtifactField = {
  field: string;
  label?: string;
  unit?: string;
};

export type ArtifactChartType = "line" | "bar" | "scatter";
export type ArtifactChartScale = "linear" | "log";

const CHART_TYPES: readonly ArtifactChartType[] = ["line", "bar", "scatter"];
const CHART_SCALES: readonly ArtifactChartScale[] = ["linear", "log"];

/** Display fields shared by every preset spec (the facade's `ArtifactOptions`). */
type ArtifactPresetOptions = {
  title?: string;
  description?: string;
};

export type ChartSpec = ArtifactPresetOptions & {
  /** Default "line". */
  type?: ArtifactChartType;
  x: ArtifactField;
  /** More than one = multiple series. */
  y: ArtifactField | ArtifactField[];
  /** y axis; default "linear". */
  scale?: ArtifactChartScale;
  /** Drawn as a horizontal reference line, from the first entry **carrying the field**. */
  baseline?: ArtifactField;
};

export type TableSpec = ArtifactPresetOptions & {
  columns: ArtifactField[];
  /** Row identity field; later entries with the same key replace the row. Absent = append-only. */
  key?: string;
};

export type MetricsSpec = ArtifactPresetOptions & {
  /** Each tile shows the value from the **last entry carrying the field**. */
  metrics: ArtifactField[];
};

export type BoardSpec = ArtifactPresetOptions & {
  /** Card identity field; later entries with the same key move/update the card. */
  key: string;
  /** Field holding the card's column. */
  status: string;
  /** Column order. Entries whose status is not listed fall into the trailing "other" column. */
  columns: string[];
  /** Card title field (defaults to key) and extra fields shown on the card. */
  cardTitle?: string;
  detail?: ArtifactField[];
};

export type ArtifactPresetKind = "chart" | "table" | "metrics" | "board";
export type ArtifactPresetSpec = ChartSpec | TableSpec | MetricsSpec | BoardSpec;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty string; every field path / column name in a spec must be one. */
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * One `ArtifactField`. May be a bare string ("latencyMs") -- script authors write that; the facade
 * type disallows it but old shapes may persist in the journal, so accept it here.
 */
function parseField(value: unknown): ArtifactField | undefined {
  const shorthand = readNonEmptyString(value);
  if (shorthand) {
    return { field: shorthand };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const field = readNonEmptyString(value.field);
  if (!field) {
    return undefined;
  }
  const label = readNonEmptyString(value.label);
  const unit = readNonEmptyString(value.unit);
  return { field, ...(label ? { label } : {}), ...(unit ? { unit } : {}) };
}

/** A field list. Broken entries are dropped individually (lenient); all-empty means unrenderable. */
function parseFieldList(value: unknown): ArtifactField[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const fields = value
    .map(parseField)
    .filter((field): field is ArtifactField => field !== undefined);
  return fields.length > 0 ? fields : undefined;
}

function parseOptions(spec: Record<string, unknown>): ArtifactPresetOptions {
  const title = readNonEmptyString(spec.title);
  const description = readNonEmptyString(spec.description);
  return { ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

function parseChartSpec(spec: Record<string, unknown>): ChartSpec | undefined {
  const x = parseField(spec.x);
  if (!x) {
    return undefined;
  }
  // Normalize y to an array whether single or listed: downstream (apply / renderers) accepts one
  // shape, and one fewer `Array.isArray` branch is one fewer chance for a single-series chart to
  // render nothing.
  const single = Array.isArray(spec.y) ? undefined : parseField(spec.y);
  const y = Array.isArray(spec.y) ? parseFieldList(spec.y) : single ? [single] : undefined;
  if (!y) {
    return undefined;
  }
  const type = CHART_TYPES.find((candidate) => candidate === spec.type) ?? "line";
  const scale = CHART_SCALES.find((candidate) => candidate === spec.scale) ?? "linear";
  const baseline = parseField(spec.baseline);
  return {
    ...parseOptions(spec),
    type,
    x,
    y,
    scale,
    ...(baseline ? { baseline } : {}),
  };
}

function parseTableSpec(spec: Record<string, unknown>): TableSpec | undefined {
  const columns = parseFieldList(spec.columns);
  if (!columns) {
    return undefined;
  }
  const key = readNonEmptyString(spec.key);
  return { ...parseOptions(spec), columns, ...(key ? { key } : {}) };
}

function parseMetricsSpec(spec: Record<string, unknown>): MetricsSpec | undefined {
  const metrics = parseFieldList(spec.metrics);
  if (!metrics) {
    return undefined;
  }
  return { ...parseOptions(spec), metrics };
}

function parseBoardSpec(spec: Record<string, unknown>): BoardSpec | undefined {
  const key = readNonEmptyString(spec.key);
  const status = readNonEmptyString(spec.status);
  if (!key || !status) {
    return undefined;
  }
  if (!Array.isArray(spec.columns)) {
    return undefined;
  }
  const columns = spec.columns
    .map(readNonEmptyString)
    .filter((column): column is string => column !== undefined);
  if (columns.length === 0) {
    return undefined;
  }
  const cardTitle = readNonEmptyString(spec.cardTitle);
  const detail = parseFieldList(spec.detail);
  return {
    ...parseOptions(spec),
    key,
    status,
    columns,
    ...(cardTitle ? { cardTitle } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Parse a wire `unknown` spec into a renderable shape; `undefined` = not renderable.
 *
 * Normalizations (downstream need no further fallbacks): `chart.y` is always an array,
 * `chart.type` / `chart.scale` always set, empty/whitespace strings treated as absent.
 */
export function parseArtifactPresetSpec(
  kind: ArtifactPresetKind,
  spec: unknown,
): ArtifactPresetSpec | undefined {
  if (!isRecord(spec)) {
    return undefined;
  }
  switch (kind) {
    case "chart":
      return parseChartSpec(spec);
    case "table":
      return parseTableSpec(spec);
    case "metrics":
      return parseMetricsSpec(spec);
    case "board":
      return parseBoardSpec(spec);
    default:
      return undefined;
  }
}

/** Post-normalization read of `chart.y`; a parsed spec's y is always an array -- type narrowing only. */
export function chartSeriesFields(spec: ChartSpec): ArtifactField[] {
  return Array.isArray(spec.y) ? spec.y : [spec.y];
}

/** The field's on-screen name: explicit `label` first, else the dot path itself. */
export function artifactFieldLabel(field: ArtifactField): string {
  return field.label ?? field.field;
}
