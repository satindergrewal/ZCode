export const HIGHSPEED_DIFFUSION_DURATION_MS = 1_400;
const HIGHSPEED_DIFFUSION_FINISH_START_PROGRESS = 0.84;
export const HIGHSPEED_MODEL_SWITCH_START_PROGRESS = 0.8;

interface HighSpeedDiffusionDistanceInput {
  height: number;
  width: number;
  x: number;
  y: number;
}

const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Parse sRGB colors from hex (3/4/6/8 digit) or rgb()/rgba() forms, ignoring alpha;
 * other functions return null so oklch() components are never misread as RGB channels.
 */
export function parseHighSpeedCanvasColor(value: string): readonly [number, number, number] | null {
  const normalized = value.trim().toLowerCase();
  const hex = normalized.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/)?.[1];
  if (hex) {
    const digits = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const channel = (offset: number) => Number.parseInt(digits.slice(offset, offset + 2), 16);
    return [channel(0), channel(2), channel(4)];
  }

  const rgb = normalized.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/**
 * Resolve a CSS color token to RGB via Canvas normalization; missing tokens or unparseable values return the fallback.
 *
 * Root cause: production minifies colors (Lightning CSS: #ffffff -> #fff, maybe a named color),
 * and the old hand parser knew only 6-digit hex, falling back to dark -- light themes got a dark mosaic.
 * Regression guard: Canvas silently keeps the previous fillStyle for values it cannot parse (var(),
 * which CSS.supports accepts), so a single read-back cannot judge. Prime with two different sentinels, assign twice,
 * and accept only on matching reads -- else the default black or the previous token wins.
 */
export function resolveHighSpeedCanvasColor(
  context: Pick<CanvasRenderingContext2D, "fillStyle">,
  value: string,
  fallback: readonly [number, number, number],
): readonly [number, number, number] {
  const specified = value.trim();
  if (!specified) return fallback;

  context.fillStyle = "#000000";
  context.fillStyle = specified;
  const overBlack = context.fillStyle;
  context.fillStyle = "#ffffff";
  context.fillStyle = specified;
  const overWhite = context.fillStyle;
  if (typeof overBlack !== "string" || overBlack !== overWhite) return fallback;
  return parseHighSpeedCanvasColor(overBlack) ?? fallback;
}

export function resolveHighSpeedDiffusionProgress(elapsedMs: number): number {
  return clampUnit(elapsedMs / HIGHSPEED_DIFFUSION_DURATION_MS);
}

export function shouldCompleteHighSpeedDiffusion(progress: number): boolean {
  return progress >= HIGHSPEED_DIFFUSION_FINISH_START_PROGRESS;
}

export function shouldStartHighSpeedModelSwitch(progress: number): boolean {
  return progress >= HIGHSPEED_MODEL_SWITCH_START_PROGRESS;
}

export function resolveHighSpeedDiffusionDistance({
  height,
  width,
  x,
  y,
}: HighSpeedDiffusionDistanceInput): number {
  const radiusX = Math.max(width / 2, 1);
  const radiusY = Math.max(height / 2, 1);
  const dx = Math.abs((x - width / 2) / radiusX);
  const dy = Math.abs((y - height / 2) / radiusY);

  // The superellipse^4 makes the wide composer's four-way front resemble the reference's fat pixel wave, not a sharp ring.
  return Math.pow(dx ** 4 + dy ** 4, 0.25);
}
