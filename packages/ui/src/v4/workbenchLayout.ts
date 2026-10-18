// Split layout math (pure functions): split tree -> absolute positioning expressions per leaf/divider.
// Leaves render flattened as direct container children (stable key = paneId) - split/close only swaps rects,
// React remounts no living pane (virtualizer heights, scroll positions, composer drafts all survive);
// recursive tree nesting would remount the whole subtree when a leaf becomes a split container.
// Rect expressions reference split-ratio CSS variables: dragging updates one variable and CSS relayouts
// all affected panes/dividers with zero React renders (the container-CSS-variable scheme, generalized per split node).
import type { CSSProperties } from "react";
import type { PaneLayoutNode, SplitDirection } from "@/v4/paneLayoutTree.js";

/** CSS variable prefix for split ratios (one `--v4-split-<nodeId>` per split node). */
export const SPLIT_VAR_PREFIX = "--v4-split-";

/** Absolute position expression (unwrapped; the style side always applies `calc(${expr})`). */
export interface RectExpr {
  left: string;
  top: string;
  width: string;
  height: string;
}

interface LeafLayout {
  paneId: string;
  rect: RectExpr;
}

interface DividerLayout {
  splitId: string;
  direction: SplitDirection;
  /** Store-held current ratio (drag origin + container CSS variable initial value). */
  ratio: number;
  /** Ratio of this split node area along the container main axis (drag px -> ratio; ancestor ratios from store numbers). */
  regionFraction: number;
  /** Divider (main-axis position) expression. */
  boundary: string;
  /** Cross-axis start/length expressions. */
  crossStart: string;
  crossLength: string;
}

const ROOT_RECT: RectExpr = {
  left: "0%",
  top: "0%",
  width: "100%",
  height: "100%",
};

function collectNode(
  node: PaneLayoutNode,
  rect: RectExpr,
  widthFraction: number,
  heightFraction: number,
  leaves: LeafLayout[],
  dividers: DividerLayout[],
): void {
  if (node.type === "leaf") {
    leaves.push({ paneId: node.paneId, rect });
    return;
  }
  const ratioVar = `var(${SPLIT_VAR_PREFIX}${node.id}, ${node.ratio})`;
  if (node.direction === "row") {
    const boundary = `(${rect.left}) + (${rect.width}) * ${ratioVar}`;
    dividers.push({
      splitId: node.id,
      direction: "row",
      ratio: node.ratio,
      regionFraction: widthFraction,
      boundary,
      crossStart: rect.top,
      crossLength: rect.height,
    });
    collectNode(
      node.first,
      { ...rect, width: `(${rect.width}) * ${ratioVar}` },
      widthFraction * node.ratio,
      heightFraction,
      leaves,
      dividers,
    );
    collectNode(
      node.second,
      { ...rect, left: boundary, width: `(${rect.width}) * (1 - ${ratioVar})` },
      widthFraction * (1 - node.ratio),
      heightFraction,
      leaves,
      dividers,
    );
    return;
  }
  const boundary = `(${rect.top}) + (${rect.height}) * ${ratioVar}`;
  dividers.push({
    splitId: node.id,
    direction: "column",
    ratio: node.ratio,
    regionFraction: heightFraction,
    boundary,
    crossStart: rect.left,
    crossLength: rect.width,
  });
  collectNode(
    node.first,
    { ...rect, height: `(${rect.height}) * ${ratioVar}` },
    widthFraction,
    heightFraction * node.ratio,
    leaves,
    dividers,
  );
  collectNode(
    node.second,
    { ...rect, top: boundary, height: `(${rect.height}) * (1 - ${ratioVar})` },
    widthFraction,
    heightFraction * (1 - node.ratio),
    leaves,
    dividers,
  );
}

interface WorkbenchLayout {
  leaves: LeafLayout[];
  dividers: DividerLayout[];
}

export function collectWorkbenchLayout(root: PaneLayoutNode): WorkbenchLayout {
  const leaves: LeafLayout[] = [];
  const dividers: DividerLayout[] = [];
  collectNode(root, ROOT_RECT, 1, 1, leaves, dividers);
  return { leaves, dividers };
}

export function rectStyle(rect: RectExpr): CSSProperties {
  return {
    left: `calc(${rect.left})`,
    top: `calc(${rect.top})`,
    width: `calc(${rect.width})`,
    height: `calc(${rect.height})`,
  };
}

export function dividerStyle(divider: DividerLayout): CSSProperties {
  if (divider.direction === "row") {
    return {
      left: `calc(${divider.boundary})`,
      top: `calc(${divider.crossStart})`,
      height: `calc(${divider.crossLength})`,
      width: "9px",
      transform: "translateX(-50%)",
    };
  }
  return {
    top: `calc(${divider.boundary})`,
    left: `calc(${divider.crossStart})`,
    width: `calc(${divider.crossLength})`,
    height: "9px",
    transform: "translateY(-50%)",
  };
}
