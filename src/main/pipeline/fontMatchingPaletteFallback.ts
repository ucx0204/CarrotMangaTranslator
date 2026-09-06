import type { AutoMatchActiveCandidateSelection } from "./autoMatchActiveCatalogTypes";
import type {
  FontMatchingPageInferencePort,
  FontMatchingPageInferenceRequest,
  FontMatchingPageInferenceResult,
} from "./fontMatchingPagePixelInferenceTypes";
import { loadCrossScriptProxyRuntimeModel } from "./fontMatchingCrossScriptProxyRuntime";
import { loadFontExpressionModel } from "./fontMatchingExpressionRuntime";
import { loadFontTextureModel } from "./fontMatchingTextureRuntime";
import { completeFontPaletteInference } from "./fontMatchingPaletteInference";
import { loadFontMatchingPageRaster } from "../fontMatchingPageImage";
import {
  createDefaultFontMatchingPageInferencePort,
  sameCandidateSnapshot,
  emptyResult,
  disabled,
} from "./fontMatchingPagePixelInference";
import { resolveCrossScriptProxyRuntimeDir } from "./fontMatchingCrossScriptProxyPaths";

/** The in-process recovery path uses the same palette, pixels, and native sessions as the worker. */
function createFontPaletteFallback(options: {
  base: FontMatchingPageInferencePort;
  loadSelection: () => AutoMatchActiveCandidateSelection;
  proxyDirectory: () => string;
  validateCatalog: (
    request: FontMatchingPageInferenceRequest,
    selection: AutoMatchActiveCandidateSelection,
  ) => FontMatchingPageInferenceResult | null;
}): FontMatchingPageInferencePort {
  let resources: ReturnType<typeof loadResources> | undefined;
  let disposed = false;
  return {
    async inferPage(request) {
      if (disposed) throw new Error("Font palette fallback is disposed.");
      const selection = options.loadSelection();
      if (!selection.renderCandidates) return options.base.inferPage(request);
      const invalid = options.validateCatalog(request, selection);
      if (invalid) return invalid;
      const result = await options.base.inferPage({
        ...request,
        candidates: selection.candidates,
      });
      if (
        result.runtimeArtifactStatus?.state !== "ready" ||
        result.pixelInferenceByBlockId.size === 0
      )
        return result;
      resources ??= loadResources(options.proxyDirectory());
      const { model, expressionModel, textureModel } = await resources;
      const raster = await loadFontMatchingPageRaster(
        request.page,
        request.signal,
      );
      return {
        ...result,
        pixelInferenceByBlockId: await completeFontPaletteInference({
          ...request,
          inferenceCandidates: selection.candidates,
          rows: result.pixelInferenceByBlockId,
          model,
          expressionModel,
          textureModel,
          raster,
        }),
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await options.base.dispose?.();
      if (!resources) return;
      const result = await Promise.allSettled([resources]);
      const loaded = result[0];
      if (loaded.status === "fulfilled")
        await Promise.all([
          loaded.value.model.styleSession.release(),
          loaded.value.model.decoderSession.release(),
          loaded.value.expressionModel.release(),
          loaded.value.textureModel.release(),
        ]);
    },
  };
}

async function loadResources(directory: string) {
  const model = await loadCrossScriptProxyRuntimeModel(directory);
  let expressionModel:
    | Awaited<ReturnType<typeof loadFontExpressionModel>>
    | undefined;
  try {
    expressionModel = await loadFontExpressionModel();
    return {
      model,
      expressionModel,
      textureModel: await loadFontTextureModel(),
    };
  } catch (error) {
    await Promise.all([
      model.styleSession.release(),
      model.decoderSession.release(),
      expressionModel?.release(),
    ]);
    throw error;
  }
}

/** Called after the worker client's Korean/user-page boundary check. */
export function createDefaultFontPaletteInferencePort(
  options: Parameters<typeof createDefaultFontMatchingPageInferencePort>[0],
): FontMatchingPageInferencePort {
  return createFontPaletteFallback({
    base: createDefaultFontMatchingPageInferencePort(options),
    loadSelection: () => options.loadSelection("ko"),
    proxyDirectory: () => resolveCrossScriptProxyRuntimeDir(options.paths),
    validateCatalog: (request, selection) =>
      sameCandidateSnapshot(
        request.candidates,
        selection.renderCandidates ?? selection.candidates,
      )
        ? null
        : emptyResult(disabled("catalog_mismatch")),
  });
}
