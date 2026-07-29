import type {
  BubbleLayout,
  BubbleShapeRegion,
  BubbleShapeSpan,
} from "./bubbleLayout";
import {
  DEFAULT_BUBBLE_LAYOUT_PADDING_RATIO,
  MAX_BUBBLE_LAYOUT_PADDING_RATIO,
  MIN_BUBBLE_LAYOUT_PADDING_RATIO,
} from "./bubbleLayoutSettings";

/**
 * Normalizes the user-facing padding ratio at the boundary where it enters
 * the bubble-layout pipeline. The ratio describes the total reduction on
 * each axis, so 0.12 leaves 88% and 0.7 leaves 30% of a region's extent.
 */
export function resolveBubbleLayoutPaddingRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_BUBBLE_LAYOUT_PADDING_RATIO;
  }
  return Math.min(
    MAX_BUBBLE_LAYOUT_PADDING_RATIO,
    Math.max(MIN_BUBBLE_LAYOUT_PADDING_RATIO, value),
  );
}

/**
 * Applies visual text padding once to final shape metadata.
 *
 * Detector spans already contain their safety inset. Scaling each region
 * around its own centre preserves that inset, its curved silhouette, and
 * separate fused-balloon lobes without eroding the mask a second time.
 */
export function applyBubbleLayoutPadding(
  layout: BubbleLayout,
  paddingRatio: unknown,
): BubbleLayout {
  const ratio = resolveBubbleLayoutPaddingRatio(paddingRatio);
  if (ratio <= 0) return layout;
  const scale = 1 - ratio;
  return {
    ...layout,
    regions: layout.regions.map((region) => scaleRegion(region, scale)),
  };
}

export type BubbleLayoutEnvelope = {
  blockStart: number;
  blockEnd: number;
  inlineStart: number;
  inlineEnd: number;
};

/**
 * Returns padded geometry rebased to its tighter bounds. Cropping the outer
 * render box to this envelope keeps even the rectangular overflow fallback
 * inside the requested padding instead of silently restoring the old box.
 */
export function applyBubbleLayoutPaddingToBounds(
  layout: BubbleLayout,
  paddingRatio: unknown,
): { bubbleLayout: BubbleLayout; envelope: BubbleLayoutEnvelope } {
  const ratio = resolveBubbleLayoutPaddingRatio(paddingRatio);
  if (ratio <= 0) {
    return {
      bubbleLayout: layout,
      envelope: {
        blockStart: 0,
        blockEnd: 1,
        inlineStart: 0,
        inlineEnd: 1,
      },
    };
  }
  const padded = applyBubbleLayoutPadding(layout, ratio);
  const envelope = resolveLayoutEnvelope(padded);
  return {
    bubbleLayout: {
      ...padded,
      regions: padded.regions.map((region) => rebaseRegion(region, envelope)),
    },
    envelope,
  };
}

function scaleRegion(
  region: BubbleShapeRegion,
  scale: number,
): BubbleShapeRegion {
  const envelope = resolveRegionEnvelope(region);
  const blockCenter = (envelope.blockStart + envelope.blockEnd) / 2;
  const inlineCenter = (envelope.inlineStart + envelope.inlineEnd) / 2;
  return {
    spans: region.spans.map((span) =>
      scaleSpan(span, scale, blockCenter, inlineCenter),
    ),
  };
}

function scaleSpan(
  span: BubbleShapeSpan,
  scale: number,
  blockCenter: number,
  inlineCenter: number,
): BubbleShapeSpan {
  return {
    blockStart: scaleCoordinate(span.blockStart, blockCenter, scale),
    blockEnd: scaleCoordinate(span.blockEnd, blockCenter, scale),
    inlineStart: scaleCoordinate(span.inlineStart, inlineCenter, scale),
    inlineEnd: scaleCoordinate(span.inlineEnd, inlineCenter, scale),
  };
}

function scaleCoordinate(value: number, center: number, scale: number): number {
  return center + (value - center) * scale;
}

function resolveRegionEnvelope(region: BubbleShapeRegion): BubbleShapeSpan {
  return {
    blockStart: Math.min(...region.spans.map((span) => span.blockStart)),
    blockEnd: Math.max(...region.spans.map((span) => span.blockEnd)),
    inlineStart: Math.min(...region.spans.map((span) => span.inlineStart)),
    inlineEnd: Math.max(...region.spans.map((span) => span.inlineEnd)),
  };
}

function resolveLayoutEnvelope(layout: BubbleLayout): BubbleLayoutEnvelope {
  const regionEnvelopes = layout.regions.map(resolveRegionEnvelope);
  return {
    blockStart: Math.min(
      ...regionEnvelopes.map((envelope) => envelope.blockStart),
    ),
    blockEnd: Math.max(...regionEnvelopes.map((envelope) => envelope.blockEnd)),
    inlineStart: Math.min(
      ...regionEnvelopes.map((envelope) => envelope.inlineStart),
    ),
    inlineEnd: Math.max(
      ...regionEnvelopes.map((envelope) => envelope.inlineEnd),
    ),
  };
}

function rebaseRegion(
  region: BubbleShapeRegion,
  envelope: BubbleLayoutEnvelope,
): BubbleShapeRegion {
  return {
    spans: region.spans.map((span) => ({
      blockStart: rebaseCoordinate(
        span.blockStart,
        envelope.blockStart,
        envelope.blockEnd,
      ),
      blockEnd: rebaseCoordinate(
        span.blockEnd,
        envelope.blockStart,
        envelope.blockEnd,
      ),
      inlineStart: rebaseCoordinate(
        span.inlineStart,
        envelope.inlineStart,
        envelope.inlineEnd,
      ),
      inlineEnd: rebaseCoordinate(
        span.inlineEnd,
        envelope.inlineStart,
        envelope.inlineEnd,
      ),
    })),
  };
}

function rebaseCoordinate(value: number, start: number, end: number): number {
  return (value - start) / (end - start);
}
