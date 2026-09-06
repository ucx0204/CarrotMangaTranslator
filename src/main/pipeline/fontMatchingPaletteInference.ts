import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type {
  FontMatchingPageInferenceBlock,
  VerifiedAutomaticFontPixelInferenceV2,
} from "./fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRasterPage } from "./fontMatchingPagePixelPreprocessing";
import {
  inferCrossScriptProxyPage,
  withRevisedCrossScriptCatalog,
  type CrossScriptProxyRuntimeModel,
} from "./fontMatchingCrossScriptProxyRuntime";
import {
  inferFontExpressionPage,
  loadFontExpressionModel,
} from "./fontMatchingExpressionRuntime";
import {
  FONT_CATALOG_REVISION,
  isRevisedFontCatalog,
} from "./fontMatchingCatalogRevision";
import {
  inferFontTexturePage,
  loadFontTextureModel,
} from "./fontMatchingTextureRuntime";

/** Shared worker/fallback completion; classifier evidence keeps its sealed identities. */
export async function completeFontPaletteInference(options: {
  blocks: readonly FontMatchingPageInferenceBlock[];
  candidates: readonly AutomaticFontCandidate[];
  inferenceCandidates: readonly AutomaticFontCandidate[];
  rows: ReadonlyMap<string, VerifiedAutomaticFontPixelInferenceV2>;
  model: CrossScriptProxyRuntimeModel;
  expressionModel: Awaited<ReturnType<typeof loadFontExpressionModel>>;
  textureModel: Awaited<ReturnType<typeof loadFontTextureModel>>;
  raster: FontMatchingRasterPage;
  signal?: AbortSignal;
}) {
  const revised = isRevisedFontCatalog(
    options.inferenceCandidates.map((candidate) => candidate.fontId),
    options.candidates.map((candidate) => candidate.fontId),
  );
  const proxy = await inferCrossScriptProxyPage({
    ...options,
    existingRows: options.rows,
    model: revised
      ? withRevisedCrossScriptCatalog(options.model)
      : options.model,
  });
  const combined = new Map<string, VerifiedAutomaticFontPixelInferenceV2>();
  for (const [id, row] of options.rows)
    combined.set(id, {
      ...row,
      ...(revised ? { catalogRevision: FONT_CATALOG_REVISION } : {}),
      ...(proxy.has(id) ? { crossScriptProxy: proxy.get(id) } : {}),
    });
  const expressive = await inferFontExpressionPage({
    ...options,
    session: options.expressionModel,
    rows: combined,
  });
  return inferFontTexturePage({
    ...options,
    session: options.textureModel,
    rows: expressive,
  });
}
