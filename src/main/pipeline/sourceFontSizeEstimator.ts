import type { MangaPage } from "../../shared/libraryTypes";
import { stripRichTextMarkup } from "../../shared/richTextMarkup";
import { loadFontMatchingPageRaster } from "../fontMatchingPageImage";
import {
  estimateSourceFontFace,
  type SourceFontSizeEstimate,
} from "./sourceFontSizeGeometry";
import type { FontMatchingRasterPage } from "./fontMatchingPagePixelPreprocessing";
import { buildSourceFontCoreMask } from "./sourceFontSizeRaster";
import { logPipelineWarning } from "./pipelineLogger";
import type { OverlayItem } from "./types";

const EMPTY_ESTIMATES: readonly (SourceFontSizeEstimate | undefined)[] = [];

export async function estimatePageSourceFontSizes({
  enabled,
  items,
  page,
  signal,
  loadRaster = loadFontMatchingPageRaster,
}: {
  enabled: boolean;
  items: readonly OverlayItem[];
  page: MangaPage;
  signal?: AbortSignal;
  loadRaster?: (
    page: MangaPage,
    signal?: AbortSignal,
  ) => Promise<FontMatchingRasterPage>;
}): Promise<readonly (SourceFontSizeEstimate | undefined)[]> {
  if (!enabled || items.length === 0) return EMPTY_ESTIMATES;
  try {
    throwIfAborted(signal);
    const raster = await loadRaster(page, signal);
    if (raster.width !== page.width || raster.height !== page.height) {
      throw new Error(
        "Source font-size raster dimensions do not match the page.",
      );
    }
    await yieldToEventLoop();
    const estimates: Array<SourceFontSizeEstimate | undefined> = [];
    for (const item of items) {
      throwIfAborted(signal);
      estimates.push(estimateSourceFontSizeForItem(raster, item, signal));
      await yieldToEventLoop();
    }
    return estimates;
  } catch (error) {
    if (signal?.aborted) throw error;
    logPipelineWarning("Source font-size matching failed closed for page", {
      error,
      pageId: page.id,
    });
    return EMPTY_ESTIMATES;
  }
}

export function estimateSourceFontSizeForItem(
  raster: FontMatchingRasterPage,
  item: OverlayItem,
  signal?: AbortSignal,
): SourceFontSizeEstimate | undefined {
  if (!isEligibleSourceSizeItem(item)) return undefined;
  const direction = item.direction;
  const sourceText = stripRichTextMarkup(item.sourceText ?? item.jp ?? "");
  const glyphCount = Array.from(sourceText).filter(
    (grapheme) => !/^\s$/u.test(grapheme),
  ).length;
  if (glyphCount < 2 || glyphCount > 160) return undefined;
  const core = buildSourceFontCoreMask(raster, item.bbox, signal);
  return core
    ? (estimateSourceFontFace(core, direction, glyphCount) ?? undefined)
    : undefined;
}

function isEligibleSourceSizeItem(
  item: OverlayItem,
): item is OverlayItem & { direction: "horizontal" | "vertical" } {
  const role = item.textRole || "ordinary";
  const direction = item.direction;
  return (
    role === "ordinary" &&
    (direction === "horizontal" || direction === "vertical") &&
    Math.abs(Number(item.angle ?? 0)) <= 3
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
