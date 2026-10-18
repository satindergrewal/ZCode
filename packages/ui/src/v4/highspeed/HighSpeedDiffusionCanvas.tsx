import { memo, useCallback, useEffect, useRef, type TransitionEvent } from "react";
import { useReducedMotion } from "motion/react";
import {
  resolveHighSpeedCanvasColor,
  shouldCompleteHighSpeedDiffusion,
  resolveHighSpeedDiffusionDistance,
  resolveHighSpeedDiffusionProgress,
  shouldStartHighSpeedModelSwitch,
} from "@/v4/highspeed/highSpeedDiffusion.js";

const HIGHSPEED_DIFFUSION_DELAY_MS = 500;
const HIGHSPEED_DIFFUSION_FRAME_INTERVAL_MS = 1_000 / 30;

// The reference spec's mosaic grain is ~6px; denser internal pixels add no visible detail and just make the wide
// composer process tens of thousands of pixels per frame, blocking the renderer.
const PIXEL_SIZE_CSS_PX = 6;
const SURFACE_FALLBACK: Rgb = [21, 21, 21];
const ACCENT_FALLBACK: Rgb = [179, 146, 255];

type Rgb = readonly [number, number, number];

const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));

const mix = (from: number, to: number, amount: number): number => from + (to - from) * amount;

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const unit = clamp((value - edge0) / (edge1 - edge0));
  return unit * unit * (3 - 2 * unit);
};

const hash = (x: number, y: number, seed: number): number => {
  let value = Math.imul(x + seed * 17, 374_761_393) + Math.imul(y - seed * 31, 668_265_263);
  value = (value ^ (value >>> 13)) >>> 0;
  value = Math.imul(value, 1_274_126_177) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295;
};

const noise = (x: number, y: number, seed: number): number => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const top = mix(hash(x0, y0, seed), hash(x0 + 1, y0, seed), sx);
  const bottom = mix(hash(x0, y0 + 1, seed), hash(x0 + 1, y0 + 1, seed), sx);
  return mix(top, bottom, sy);
};

const fbm = (x: number, y: number, seed: number): number => {
  let sum = 0;
  let amplitude = 0.58;
  let frequency = 1;
  for (let octave = 0; octave < 3; octave += 1) {
    sum += noise(x * frequency, y * frequency, seed + octave * 19) * amplitude;
    frequency *= 2.02;
    amplitude *= 0.48;
  }
  return sum;
};

interface HighSpeedDiffusionCanvasProps {
  onModelTransitionStart: () => void;
  onHandoffStart: () => void;
  onComplete: () => void;
}

export const HighSpeedDiffusionCanvas = memo(function HighSpeedDiffusionCanvas({
  onModelTransitionStart,
  onHandoffStart,
  onComplete,
}: HighSpeedDiffusionCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  const handleHandoffTransitionEnd = useCallback(
    (event: TransitionEvent<HTMLCanvasElement>) => {
      if (event.propertyName !== "opacity") return;

      // Root cause: the old code timed the Canvas unmount from the diffusion callback, but React's commit/handoff can land later
      // and a busy renderer shrinks or swallows the fade window. The CSS opacity transitionend is the only unmount gate.
      onComplete();
    },
    [onComplete],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (reducedMotion) {
      onModelTransitionStart();
      onHandoffStart();
      onComplete();
      return;
    }

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      onModelTransitionStart();
      onHandoffStart();
      onComplete();
      return;
    }

    let animationFrameId = 0;
    let delayTimerId = 0;
    let startTime = 0;
    let lastRenderTime = -HIGHSPEED_DIFFUSION_FRAME_INTERVAL_MS;
    let width = 0;
    let height = 0;
    let imageData: ImageData | null = null;
    let pixels: Uint8ClampedArray | null = null;
    let distanceField: Float32Array | null = null;
    let broadNoiseField: Float32Array | null = null;
    let detailNoiseField: Float32Array | null = null;
    let grainField: Float32Array | null = null;
    let surface: Rgb = SURFACE_FALLBACK;
    let accent: Rgb = ACCENT_FALLBACK;
    let completed = false;
    let modelTransitionStarted = false;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.ceil(bounds.width / PIXEL_SIZE_CSS_PX));
      const nextHeight = Math.max(1, Math.ceil(bounds.height / PIXEL_SIZE_CSS_PX));
      if (nextWidth === width && nextHeight === height) return;

      width = nextWidth;
      height = nextHeight;
      canvas.width = width;
      canvas.height = height;
      context.imageSmoothingEnabled = false;
      imageData = context.createImageData(width, height);
      pixels = imageData.data;
      const fieldSize = width * height;
      distanceField = new Float32Array(fieldSize);
      broadNoiseField = new Float32Array(fieldSize);
      detailNoiseField = new Float32Array(fieldSize);
      grainField = new Float32Array(fieldSize);

      const blockWidth = Math.ceil(width / 2);
      const blockHeight = Math.ceil(height / 2);
      const broadBlocks = new Float32Array(blockWidth * blockHeight);
      for (let blockY = 0; blockY < blockHeight; blockY += 1) {
        for (let blockX = 0; blockX < blockWidth; blockX += 1) {
          broadBlocks[blockY * blockWidth + blockX] = fbm(blockX * 0.21, blockY * 0.24, 12);
        }
      }

      // Root cause: recomputing distance and two multi-octave noise fields per pixel per frame caused 1s-scale
      // long tasks on wide windows. Cache the static fields on resize; playback only moves the diffusion threshold.
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const fieldIndex = y * width + x;
          distanceField[fieldIndex] = resolveHighSpeedDiffusionDistance({
            x: x + 0.5,
            y: y + 0.5,
            width,
            height,
          });
          broadNoiseField[fieldIndex] =
            broadBlocks[Math.floor(y / 2) * blockWidth + Math.floor(x / 2)] ?? 0.5;
          detailNoiseField[fieldIndex] = noise(x * 0.22, y * 0.24, 91);
          grainField[fieldIndex] = (hash(x, y, 47) - 0.5) * 12;
        }
      }

      const computedStyle = getComputedStyle(canvas);
      surface = resolveHighSpeedCanvasColor(
        context,
        computedStyle.getPropertyValue("--color-highspeed-composer-surface"),
        SURFACE_FALLBACK,
      );
      accent = resolveHighSpeedCanvasColor(
        context,
        computedStyle.getPropertyValue("--color-highspeed-accent"),
        ACCENT_FALLBACK,
      );
    };

    const finish = () => {
      if (completed) return;
      completed = true;
      onComplete();
    };

    const render = (now: number) => {
      if (
        !imageData ||
        !pixels ||
        !distanceField ||
        !broadNoiseField ||
        !detailNoiseField ||
        !grainField
      ) {
        finish();
        return;
      }

      if (now - lastRenderTime < HIGHSPEED_DIFFUSION_FRAME_INTERVAL_MS) {
        animationFrameId = window.requestAnimationFrame(render);
        return;
      }
      lastRenderTime = now;

      const elapsed = now - startTime;
      const progress = resolveHighSpeedDiffusionProgress(elapsed);
      if (!modelTransitionStarted && shouldStartHighSpeedModelSwitch(progress)) {
        // Root cause: the toolbar read the active boolean directly, flipping the model before the noise spread -- no causal order.
        // A one-shot late-phase signal from the same progress clock starts the flip early but lands it before the noise ends.
        modelTransitionStarted = true;
        onModelTransitionStart();
      }
      const easedProgress = smoothstep(0, 1, progress);
      const frontRadius = mix(-0.12, 1.5, easedProgress);

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const fieldIndex = y * width + x;
          const pixelIndex = (y * width + x) * 4;
          const broadNoise = broadNoiseField[fieldIndex] ?? 0.5;
          const detailNoise = detailNoiseField[fieldIndex] ?? 0.5;
          const signedDistance =
            frontRadius -
            (distanceField[fieldIndex] ?? 0) +
            (broadNoise - 0.5) * 0.34 +
            (detailNoise - 0.5) * 0.08;
          const revealed = smoothstep(-0.08, 0.16, signedDistance);
          const waveBand =
            smoothstep(-0.16, 0.02, signedDistance) * (1 - smoothstep(0.12, 0.42, signedDistance));
          const colorAmount = clamp(waveBand * (0.7 + broadNoise * 0.45));
          const grain = grainField[fieldIndex] ?? 0;
          const revealedAlpha = Math.max(revealed, waveBand * 0.92);

          pixels[pixelIndex] = clamp(mix(surface[0], accent[0], colorAmount) + grain, 0, 255);
          pixels[pixelIndex + 1] = clamp(mix(surface[1], accent[1], colorAmount) + grain, 0, 255);
          pixels[pixelIndex + 2] = clamp(mix(surface[2], accent[2], colorAmount) + grain, 0, 255);
          pixels[pixelIndex + 3] = Math.round(clamp(revealedAlpha) * 255);
        }
      }

      context.putImageData(imageData, 0, 0);
      if (shouldCompleteHighSpeedDiffusion(progress)) {
        // Root cause: a fixed timer unmounted the Canvas on the final frame; any React delay turned the fade into a hard cut.
        // Stop the per-pixel loop and switch handoff only; the real opacity transitionend unmounts the Canvas.
        onHandoffStart();
        return;
      }
      animationFrameId = window.requestAnimationFrame(render);
    };

    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(canvas);
    delayTimerId = window.setTimeout(() => {
      startTime = performance.now();
      animationFrameId = window.requestAnimationFrame(render);
    }, HIGHSPEED_DIFFUSION_DELAY_MS);

    return () => {
      observer?.disconnect();
      window.clearTimeout(delayTimerId);
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [onComplete, onHandoffStart, onModelTransitionStart, reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="highspeed-diffusion-canvas"
      aria-hidden="true"
      onTransitionEnd={handleHandoffTransitionEnd}
      className="highspeed-diffusion-canvas pointer-events-none absolute inset-0 size-full"
    />
  );
});
