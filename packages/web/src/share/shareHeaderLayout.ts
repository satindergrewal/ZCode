interface ShareHeaderMeasurements {
  /** Width of the share header shell. */
  shellWidth: number;
  /** Distance from the content rail edges to the shell edge. */
  railContentLeft: number;
  railContentRight: number;
  brandWidth: number;
  titleContentWidth: number;
  /** Combined width of the theme button and the full continue CTA. */
  continueWidth: number;
  /** Combined width of the theme button and the compact continue CTA. */
  compactContinueWidth?: number;
  /** Whether the right side includes the continue CTA; read-only shares keep the theme button. */
  hasContinueAction?: boolean;
  gap?: number;
  /** Padding between the wide-screen anchors and the viewport edge. */
  edgePadding?: number;
  /** Safety gap reserved before the side elements start the continuous translation. */
  minClearance?: number;
  /** Width the full CTA must reserve for a visible title. */
  minTitleWidth?: number;
}

export interface ShareHeaderView {
  /** 0 is inline with the content column, 1 is the viewport-edge anchors. */
  progress: number;
  brandLeft: number;
  titleLeft: number;
  titleWidth: number;
  continueRight: number;
  titleTruncated: boolean;
  continueVisible: boolean;
  continueCompact: boolean;
}

const DEFAULT_GAP = 16;
const DEFAULT_EDGE_PADDING = 24;
const DEFAULT_MIN_CLEARANCE = 16;
const DEFAULT_MIN_TITLE_WIDTH = 80;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

/**
 * Computes the continuous geometry of the share header.
 *
 * This used to return two discrete layouts (inline / rail-aligned); brand and CTA jumped
 * from flex flow to absolute positioning at a breakpoint. The available gutter between the
 * content column and the viewport edge now drives progress, so all three elements slide
 * along one track: wide outer anchors hold while the gutter fits, and elements retract
 * toward the content column only once it gets tight.
 */
export function resolveShareHeaderView({
  shellWidth,
  railContentLeft,
  railContentRight,
  brandWidth,
  titleContentWidth,
  continueWidth,
  compactContinueWidth = continueWidth,
  hasContinueAction = continueWidth > 0,
  gap = DEFAULT_GAP,
  edgePadding = DEFAULT_EDGE_PADDING,
  minClearance = DEFAULT_MIN_CLEARANCE,
  minTitleWidth = DEFAULT_MIN_TITLE_WIDTH,
}: ShareHeaderMeasurements): ShareHeaderView {
  const normalizedShellWidth = Math.max(0, shellWidth);
  const normalizedRailLeft = Math.max(0, railContentLeft);
  const normalizedRailRight = Math.max(0, railContentRight);
  const normalizedBrandWidth = Math.max(0, brandWidth);
  const normalizedTitleContentWidth = Math.max(0, titleContentWidth);
  const normalizedContinueWidth = Math.max(0, continueWidth);
  const normalizedCompactContinueWidth = Math.min(
    normalizedContinueWidth,
    Math.max(0, compactContinueWidth),
  );
  const normalizedGap = Math.max(0, gap);
  const normalizedEdgePadding = Math.max(0, edgePadding);
  const normalizedMinClearance = Math.max(0, minClearance);
  const normalizedMinTitleWidth = Math.max(0, minTitleWidth);
  const brandRequiredGutter = normalizedBrandWidth + normalizedEdgePadding + normalizedMinClearance;
  const brandProgress = clamp(normalizedRailLeft / brandRequiredGutter, 0, 1);
  const narrowBrandLeft = normalizedRailLeft;
  const narrowTitleLeft = normalizedRailLeft + normalizedBrandWidth + normalizedGap;
  const wideBrandLeft = normalizedEdgePadding;
  const wideTitleLeft = normalizedRailLeft;
  const wideTitleRight = normalizedShellWidth - normalizedRailRight;
  const wideContinueRight = normalizedEdgePadding;
  const brandLeft = lerp(narrowBrandLeft, wideBrandLeft, brandProgress);
  const titleLeft = Math.max(
    brandLeft + normalizedBrandWidth + normalizedGap,
    lerp(narrowTitleLeft, wideTitleLeft, brandProgress),
  );

  const resolveTrailingGeometry = (trailingWidth: number) => {
    const continueRequiredGutter = trailingWidth + normalizedEdgePadding + normalizedMinClearance;
    const continueProgress =
      trailingWidth === 0 ? 1 : clamp(normalizedRailRight / continueRequiredGutter, 0, 1);
    const continueRight = lerp(normalizedRailRight, wideContinueRight, continueProgress);
    const narrowTitleRight =
      normalizedShellWidth - normalizedRailRight - trailingWidth - normalizedGap;
    const titleRight = Math.min(
      lerp(narrowTitleRight, wideTitleRight, continueProgress),
      normalizedShellWidth - continueRight - trailingWidth - normalizedGap,
    );
    return {
      continueProgress,
      continueRight,
      titleWidth: Math.max(0, titleRight - titleLeft),
    };
  };

  const fullGeometry = resolveTrailingGeometry(normalizedContinueWidth);
  // Permanently reserving width for the full CTA on very narrow screens crushes the title to
  // zero. Keep the continuous track, and swap to the compact icon button at the same position
  // only once the full CTA can no longer preserve the minimum title width.
  const continueCompact =
    hasContinueAction &&
    normalizedCompactContinueWidth < normalizedContinueWidth &&
    fullGeometry.titleWidth < normalizedMinTitleWidth;
  const geometry = continueCompact
    ? resolveTrailingGeometry(normalizedCompactContinueWidth)
    : fullGeometry;

  return {
    progress: Math.min(brandProgress, geometry.continueProgress),
    brandLeft,
    titleLeft,
    titleWidth: geometry.titleWidth,
    continueRight: geometry.continueRight,
    titleTruncated: normalizedTitleContentWidth > geometry.titleWidth,
    continueVisible: hasContinueAction,
    continueCompact,
  };
}
