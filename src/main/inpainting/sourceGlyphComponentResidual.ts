import type { PixelRect } from "./maskGeometry";
import { maskComponents } from "./rasterMasks";
import type { SourceGlyphEvidence } from "./sourceGlyphResidual";
import {
  CRUDE_SOURCE_GLYPH_COMPONENT_PROFILE,
  SOURCE_GLYPH_RESIDUAL_DIAGNOSTICS_CONTRACT_VERSION,
  type SourceGlyphComponentResidual,
  type SourceGlyphComponentResidualDiagnostic,
  type SourceGlyphComponentResidualProfile,
} from "./sourceGlyphResidualDiagnosticTypes";
import {
  pixelRgbDelta,
  safeRatio,
  SOURCE_LIKE_MAX_RGB_DELTA,
  validateComponentProfile,
  validateDiagnosticBitmapContract,
  validateDiagnosticWindowMask,
} from "./sourceGlyphResidualDiagnosticUtils";

type MaskComponent = ReturnType<typeof maskComponents>[number];

/**
 * Measures retention per connected source component. Unlike the Phase 1
 * whole-block ratio, a completely retained glyph can remain visible even if
 * other glyphs in the same block were removed successfully.
 */
export function measureSourceGlyphComponentResiduals(options: {
  after: Buffer;
  before: Buffer;
  pageWidth: number;
  profile?: SourceGlyphComponentResidualProfile;
  sourceEvidence: SourceGlyphEvidence;
}): SourceGlyphComponentResidualDiagnostic {
  const pageHeight = validateDiagnosticBitmapContract(
    options.before,
    options.after,
    options.pageWidth,
  );
  validateDiagnosticWindowMask(
    options.sourceEvidence.windowMask,
    options.pageWidth,
    pageHeight,
  );
  const profile = options.profile ?? CRUDE_SOURCE_GLYPH_COMPONENT_PROFILE;
  validateComponentProfile(profile);
  const sourceMask = options.sourceEvidence.windowMask;
  const components = maskComponents(
    sourceMask.data,
    sourceMask.bounds.w,
    sourceMask.bounds.h,
    1,
  ).map((component, index) =>
    measureComponent({
      after: options.after,
      before: options.before,
      component,
      componentIndex: index,
      pageWidth: options.pageWidth,
      profile,
      sourceBounds: sourceMask.bounds,
    }),
  );
  return summarizeComponents(components);
}

function measureComponent(options: {
  after: Buffer;
  before: Buffer;
  component: MaskComponent;
  componentIndex: number;
  pageWidth: number;
  profile: SourceGlyphComponentResidualProfile;
  sourceBounds: PixelRect;
}): SourceGlyphComponentResidual {
  const remaining = new Uint8Array(options.component.data.length);
  let remainingCount = 0;
  for (let y = 0; y < options.component.rect.h; y += 1) {
    for (let x = 0; x < options.component.rect.w; x += 1) {
      const index = y * options.component.rect.w + x;
      if (!options.component.data[index]) continue;
      const pageX = options.sourceBounds.x + options.component.rect.x + x;
      const pageY = options.sourceBounds.y + options.component.rect.y + y;
      const offset = (pageY * options.pageWidth + pageX) * 4;
      if (
        pixelRgbDelta(options.before, options.after, offset) <=
        SOURCE_LIKE_MAX_RGB_DELTA
      ) {
        remaining[index] = 1;
        remainingCount += 1;
      }
    }
  }
  return buildComponentResult(options, remaining, remainingCount);
}

function buildComponentResult(
  options: Parameters<typeof measureComponent>[0],
  remaining: Uint8Array,
  remainingCount: number,
): SourceGlyphComponentResidual {
  const { component, sourceBounds } = options;
  const largestExactLikeRun =
    maskComponents(remaining, component.rect.w, component.rect.h, 1)[0]?.area ??
    0;
  const sourceFillRatio = safeRatio(
    component.area,
    component.rect.w * component.rect.h,
  );
  const sourceAspectRatio = Math.max(
    component.rect.w / component.rect.h,
    component.rect.h / component.rect.w,
  );
  const retainedRatio = safeRatio(remainingCount, component.area);
  const largestExactLikeRunRatio = safeRatio(
    largestExactLikeRun,
    component.area,
  );
  const metrics = {
    sourcePixelCount: component.area,
    sourceFillRatio,
    sourceAspectRatio,
    sourceLikeRemainingCount: remainingCount,
    retainedRatio,
    largestExactLikeRun,
    largestExactLikeRunRatio,
  };
  return {
    componentIndex: options.componentIndex,
    bounds: {
      x: sourceBounds.x + component.rect.x,
      y: sourceBounds.y + component.rect.y,
      w: component.rect.w,
      h: component.rect.h,
    },
    ...metrics,
    diagnosticCandidate: qualifiesComponent(metrics, options.profile),
  };
}

function summarizeComponents(
  components: SourceGlyphComponentResidual[],
): SourceGlyphComponentResidualDiagnostic {
  const sourceSeedCount = components.reduce(
    (sum, component) => sum + component.sourcePixelCount,
    0,
  );
  const sourceLikeRemainingCount = components.reduce(
    (sum, component) => sum + component.sourceLikeRemainingCount,
    0,
  );
  return {
    contractVersion: SOURCE_GLYPH_RESIDUAL_DIAGNOSTICS_CONTRACT_VERSION,
    diagnosticOnly: true,
    promotionEligible: false,
    resolutionNormalized: false,
    sourceSeedCount,
    sourceLikeRemainingCount,
    sourceLikeRemainingRatio: safeRatio(
      sourceLikeRemainingCount,
      sourceSeedCount,
    ),
    sourceComponentCount: components.length,
    candidateComponentCount: components.filter(
      (component) => component.diagnosticCandidate,
    ).length,
    components,
  };
}

function qualifiesComponent(
  metrics: Omit<
    SourceGlyphComponentResidual,
    "bounds" | "componentIndex" | "diagnosticCandidate"
  >,
  profile: SourceGlyphComponentResidualProfile,
): boolean {
  return (
    metrics.sourcePixelCount >= profile.minSourcePixelCount &&
    metrics.sourcePixelCount <= profile.maxSourcePixelCount &&
    metrics.sourceLikeRemainingCount >= profile.minRetainedPixelCount &&
    metrics.retainedRatio >= profile.minRetainedRatio &&
    metrics.largestExactLikeRun >= profile.minLargestExactLikeRun &&
    metrics.largestExactLikeRunRatio >= profile.minLargestExactLikeRunRatio &&
    metrics.sourceAspectRatio <= profile.maxAspectRatio &&
    metrics.sourceFillRatio >= profile.minFillRatio &&
    metrics.sourceFillRatio <= profile.maxFillRatio
  );
}
