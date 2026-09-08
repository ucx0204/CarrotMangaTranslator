import type {
  BubbleLayout,
  BubbleShapeRegion,
} from "../../shared/bubbleLayout";
import {
  applyBubbleLayoutPadding,
  resolveBubbleLayoutPaddingRatio,
  type BubbleLayoutEnvelope,
} from "../../shared/bubbleLayoutPadding";
import { intersectBubbleRegionLineBand } from "../../shared/bubbleShapeSlotPrimitives";

export function padBubbleShapeProfile(
  layout: BubbleLayout,
  paddingRatio: unknown,
): { bubbleLayout: BubbleLayout; envelope: BubbleLayoutEnvelope } | null {
  const ratio = resolveBubbleLayoutPaddingRatio(paddingRatio);
  if (ratio <= 0)
    return {
      bubbleLayout: layout,
      envelope: { blockStart: 0, blockEnd: 1, inlineStart: 0, inlineEnd: 1 },
    };
  const padded = applyBubbleLayoutPadding(layout, ratio);
  const regions = padded.regions
    .map((region, index) =>
      constrainPaddedRegion(region, layout.regions[index]),
    )
    .filter((region) => region.spans.length > 0);
  if (regions.length === 0) return null;
  const envelope = regions.reduce(
    (bounds, region) =>
      region.spans.reduce(
        (bounds, span) => ({
          blockStart: Math.min(bounds.blockStart, span.blockStart),
          blockEnd: Math.max(bounds.blockEnd, span.blockEnd),
          inlineStart: Math.min(bounds.inlineStart, span.inlineStart),
          inlineEnd: Math.max(bounds.inlineEnd, span.inlineEnd),
        }),
        bounds,
      ),
    { blockStart: 1, blockEnd: 0, inlineStart: 1, inlineEnd: 0 },
  );
  return {
    bubbleLayout: {
      ...padded,
      regions: regions.map((region) => rebaseRegion(region, envelope)),
    },
    envelope,
  };
}

function constrainPaddedRegion(
  region: BubbleShapeRegion,
  safeRegion: BubbleShapeRegion,
): BubbleShapeRegion {
  return {
    spans: region.spans.flatMap((span) => {
      const safe = intersectBubbleRegionLineBand(
        safeRegion,
        span.blockStart,
        span.blockEnd,
      );
      if (!safe) return [];
      let inlineStart = Math.max(span.inlineStart, safe.inlineStart);
      let inlineEnd = Math.min(span.inlineEnd, safe.inlineEnd);
      if (inlineEnd <= inlineStart) {
        const width = Math.min(
          span.inlineEnd - span.inlineStart,
          safe.inlineEnd - safe.inlineStart,
        );
        const center = (safe.inlineStart + safe.inlineEnd) / 2;
        inlineStart = center - width / 2;
        inlineEnd = center + width / 2;
      }
      return [{ ...span, inlineStart, inlineEnd }];
    }),
  };
}

function rebaseRegion(
  region: BubbleShapeRegion,
  envelope: BubbleLayoutEnvelope,
): BubbleShapeRegion {
  const blockExtent = envelope.blockEnd - envelope.blockStart;
  const inlineExtent = envelope.inlineEnd - envelope.inlineStart;
  return {
    spans: region.spans.map((span) => ({
      blockStart: (span.blockStart - envelope.blockStart) / blockExtent,
      blockEnd: (span.blockEnd - envelope.blockStart) / blockExtent,
      inlineStart: (span.inlineStart - envelope.inlineStart) / inlineExtent,
      inlineEnd: (span.inlineEnd - envelope.inlineStart) / inlineExtent,
    })),
  };
}
