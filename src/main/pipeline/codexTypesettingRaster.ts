import { nativeImage, type NativeImage } from "electron";
import { codexBackgroundSupportRect } from "../../shared/codexTypesettingBlend";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import type {
  CodexPageReading,
  CodexTypesettingOptions,
} from "../../shared/codexTypesettingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { normalizedRegionToPixelRect } from "../../shared/region";
import {
  createCodexEraseMask,
  codexSourceContextRect,
} from "../../shared/codexTypesettingMask";
import type {
  TypesettingComposition,
  TypesettingImage,
  TypesettingPageImage,
} from "../application/codexTypesettingContracts";
import type { PageExportRenderSession } from "../pageExport";
import type { BBox, TranslationBlock } from "../../shared/textTypes";
import { createCodexPageViews } from "../../shared/codexTypesettingViews";
import { ORIGINAL_PAGE_EXPORT_RASTER_LIMITS } from "../../shared/pageExportLimits";
import { assertPageExportRasterBudget } from "../pageExportRasterSafety";
import {
  normalizeParagraphWhitespace,
  segmentNaturalTextGraphemes,
} from "../../shared/naturalTextLayoutSegmentation";
import { serializeRichTextRuns } from "../../shared/richTextMarkup";
import { assertExactMembership } from "../application/codexTypesettingValidation";

export async function pageImage(
  page: MangaPage,
): Promise<TypesettingPageImage[]> {
  assertPageExportRasterBudget(
    page,
    page.name,
    ORIGINAL_PAGE_EXPORT_RASTER_LIMITS,
  );
  const source = nativeImage.createFromBuffer(await readFile(page.imagePath));
  return typesettingPageImages(page, source, "Original source");
}

export function typesettingPageImages(
  page: MangaPage,
  source: NativeImage,
  label: string,
): TypesettingPageImage[] {
  if (source.isEmpty())
    throw new Error(`이미지를 읽지 못했습니다: ${page.name}`);
  const size = source.getSize();
  if (size.width !== page.width || size.height !== page.height)
    throw new Error(`원본 해상도가 페이지 정보와 다릅니다: ${page.name}`);
  return createCodexPageViews(page).map((view, index) => ({
    view,
    label: `${label}; ${page.id}: native page ${page.width}x${page.height}; view ${index + 1}; page-pixel crop=${JSON.stringify(view.bounds)}; page-pixel ownership=${JSON.stringify(view.ownership)}.`,
    dataUrl: source
      .crop({
        x: view.bounds.x,
        y: view.bounds.y,
        width: view.bounds.w,
        height: view.bounds.h,
      })
      .toDataURL(),
  }));
}

export async function restoreSourceRegions(
  page: MangaPage,
  reading: CodexPageReading,
  ids: string[],
): Promise<MangaPage> {
  if (!page.inpaintedImagePath)
    throw new Error("복원할 배경 이미지가 없습니다.");
  const original = PNG.sync.read(
    nativeImage.createFromBuffer(await readFile(page.imagePath)).toPNG(),
  );
  const clean = PNG.sync.read(await readFile(page.inpaintedImagePath));
  for (const region of reading.regions.filter((item) =>
    ids.includes(item.id),
  )) {
    const rect = codexBackgroundSupportRect(region, page);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      const start = (y * clean.width + rect.x) * 4;
      clean.data.set(original.data.subarray(start, start + rect.w * 4), start);
    }
  }
  await writeFile(page.inpaintedImagePath, PNG.sync.write(clean));
  return page;
}

export async function sourceRegionCrops(
  pages: MangaPage[],
  readings: Map<string, CodexPageReading>,
  includeContext = false,
): Promise<TypesettingImage[]> {
  const crops = await Promise.all(
    pages.map(async (page) => {
      const source = nativeImage.createFromBuffer(
        await readFile(page.imagePath),
      );
      const reading = readings.get(page.id);
      if (!reading) throw new Error("서체 비교에 필요한 판독 결과가 없습니다.");
      return reading.regions
        .filter((region) => region.action !== "keep")
        .map((region) => {
          const rect = includeContext
            ? codexSourceContextRect(region, page)
            : normalizedRegionToPixelRect(region.sourceBbox, page);
          const crop = source.crop({
            x: rect.x,
            y: rect.y,
            width: rect.w,
            height: rect.h,
          });
          return {
            label: `${region.id}; original ${includeContext ? "context" : "source"} crop ${rect.w}x${rect.h}; ${region.direction}; target=${JSON.stringify(region.sourceText)}; native page=${page.width}x${page.height}; page-pixel crop=${JSON.stringify(rect)}; input-image boundaries (not necessarily physical page edges)=${JSON.stringify({ left: rect.x === 0, top: rect.y === 0, right: rect.x + rect.w === page.width, bottom: rect.y + rect.h === page.height })}`,
            dataUrl: crop.toDataURL(),
          };
        });
    }),
  );
  return crops.flat();
}

export async function renderFontSamples(
  options: CodexTypesettingOptions,
  sample: string,
  directory: string,
  renderer: PageExportRenderSession,
): Promise<TypesettingImage[]> {
  const blank = new PNG({ width: 1200, height: 600 });
  blank.data.fill(255);
  const imagePath = join(directory, "font-sample-background.png");
  await writeFile(imagePath, PNG.sync.write(blank));
  const images: TypesettingImage[] = [];
  for (const font of options.preset.fonts) {
    const { bytes, ...evidence } = await renderVerifiedFontSample(
      font.fontId,
      sample,
      imagePath,
      renderer,
    );
    images.push({
      label: `fontId=${font.fontId}; left=regular right=bold; rows=24px,40px,60px; specimen=${JSON.stringify(evidence.specimen)}; all six rows measured without overflow; purpose=${font.purpose}`,
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
    });
    const name = `font-${font.fontId.replace(/[^\w-]/g, "_")}`;
    await writeFile(join(directory, `${name}.png`), bytes);
    await writeFile(
      join(directory, `${name}.json`),
      JSON.stringify(evidence, null, 2),
    );
  }
  return images;
}

async function renderVerifiedFontSample(
  fontId: string,
  sample: string,
  imagePath: string,
  renderer: PageExportRenderSession,
) {
  const graphemes = segmentNaturalTextGraphemes(
    normalizeParagraphWhitespace(sample),
  );
  if (!graphemes.length) throw new Error("폰트 견본 문구가 비어 있습니다.");
  if (!renderer.inspectLastLayout)
    throw new Error("폰트 견본 측정 기능이 없습니다.");
  for (const limit of [8, 4, 1]) {
    const specimen = graphemes.slice(0, limit).join("");
    const page = createFontSamplePage(fontId, imagePath, specimen);
    const bytes = await renderer.renderPage(page);
    const measurements = await renderer.inspectLastLayout();
    assertExactMembership(
      page.blocks.map((block) => block.id),
      measurements.map((item) => item.blockId),
      "Font sample measurements",
    );
    if (measurements.every((item) => !item.overflow))
      return { bytes, specimen, measurements };
  }
  throw new Error(`폰트 견본이 표시 영역을 넘습니다: ${fontId}`);
}

function createFontSamplePage(
  fontId: string,
  imagePath: string,
  sample: string,
): MangaPage {
  const text = serializeRichTextRuns([
    { text: sample, bold: false, italic: false },
  ]);
  const blocks = [24, 40, 60].flatMap((size, index) =>
    [false, true].map(
      (bold): TranslationBlock => ({
        id: `sample-${index}-${bold}`,
        type: "nonsolid",
        bbox: { x: 20 + (bold ? 500 : 0), y: 20 + index * 310, w: 470, h: 300 },
        bboxSpace: "normalized_1000",
        sourceText: "",
        translatedText: text,
        confidence: 1,
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        fontFamily: fontId,
        fontSizePx: size,
        fontSizeIntent: "manual",
        lineHeight: 1.25,
        textAlign: "left",
        textColor: "#000000",
        bold,
        outlineWidthPx: 0,
        backgroundColor: "#ffffff",
        opacity: 0,
        autoFitText: false,
      }),
    ),
  );
  const now = new Date().toISOString();
  return {
    id: "font-sample",
    name: fontId,
    imagePath,
    dataUrl: "",
    width: 1200,
    height: 600,
    blocks,
    analysisStatus: "completed",
    createdAt: now,
    updatedAt: now,
  };
}

export async function cleanPlainRegions(
  page: MangaPage,
  reading: CodexPageReading,
  directory: string,
  preserveExisting = false,
): Promise<TypesettingComposition> {
  const source = nativeImage.createFromBuffer(
    await readFile(
      preserveExisting && page.inpaintedImagePath
        ? page.inpaintedImagePath
        : page.imagePath,
    ),
  );
  const image = PNG.sync.read(source.toPNG());
  const issues: TypesettingComposition["issues"] = [];
  const protectedRegions = reading.regions.filter(
    (region) => region.action === "keep",
  );
  for (const region of reading.regions) {
    if (region.action === "keep" || region.background === "artwork") continue;
    try {
      const mask = createCodexEraseMask(region, page, protectedRegions);
      fillPlainMask(image, mask, region.background === "white" ? 255 : 0);
    } catch (error) {
      issues.push({
        regionId: region.id,
        kind: "background",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const inpaintedImagePath = join(directory, `clean-${page.id}.png`);
  await writeFile(inpaintedImagePath, PNG.sync.write(image));
  return { page: { ...page, inpaintedImagePath }, issues };
}

export function fillPlainMask(
  image: PNG,
  mask: ReturnType<typeof createCodexEraseMask>,
  color: number,
): void {
  const { bounds, data } = mask;
  for (let y = 0; y < bounds.h; y++) {
    for (let x = 0; x < bounds.w; x++) {
      if (!data[y * bounds.w + x]) continue;
      const offset = ((y + bounds.y) * image.width + x + bounds.x) * 4;
      image.data.fill(color, offset, offset + 3);
      image.data[offset + 3] = 255;
    }
  }
}

/** Actual exported ink covers curves, outlines, custom fonts, images and overflow. */
export async function measureCodexPaintedBounds(
  page: MangaPage,
  renderer: PageExportRenderSession,
  signal: AbortSignal,
): Promise<Map<string, BBox | null>> {
  if (!renderer.renderTransparentPage)
    throw new Error("실제 투명 전경 렌더러가 없습니다.");
  const results = new Map<string, BBox | null>();
  for (const block of page.blocks) {
    signal.throwIfAborted();
    const bytes = await renderer.renderTransparentPage(
      { ...page, blocks: [block], blockOrder: [block.id] },
      { format: "png", resolutionMode: "original" },
    );
    signal.throwIfAborted();
    const image = PNG.sync.read(bytes);
    if (image.width !== page.width || image.height !== page.height)
      throw new Error("전경 범위 검사의 원본 해상도가 다릅니다.");
    results.set(block.id, paintedRasterBounds(image));
  }
  return results;
}

function paintedRasterBounds(image: PNG): BBox | null {
  let left = image.width,
    top = image.height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left
    ? null
    : {
        x: (left / image.width) * 1000,
        y: (top / image.height) * 1000,
        w: ((right - left + 1) / image.width) * 1000,
        h: ((bottom - top + 1) / image.height) * 1000,
      };
}

export async function regionReferenceImages(
  context: import("./types").PipelineRegionContext | undefined,
): Promise<TypesettingImage[]> {
  if (!context) return [];
  const page = context.sourcePage;
  const original = nativeImage.createFromBuffer(await readFile(page.imagePath));
  if (original.isEmpty())
    throw new Error(`전체 페이지 참고 이미지를 읽지 못했습니다: ${page.name}`);
  const size = original.getSize();
  if (size.width !== page.width || size.height !== page.height)
    throw new Error("전체 페이지 참고 이미지의 크기가 달라졌습니다.");
  const ratio = Math.min(1, 1600 / Math.max(page.width, page.height));
  const overview =
    ratio < 1
      ? original.resize({
          width: Math.round(page.width * ratio),
          height: Math.round(page.height * ratio),
          quality: "best",
        })
      : original;
  return [
    {
      label: `REFERENCE ONLY: complete ORIGINAL page ${page.width}x${page.height}; selected crop in original-page pixels=${JSON.stringify(context.cropRect)}. Use surrounding dialogue, speaker identities and scene context to understand the selected crop. Return text/boxes/polygons only for the separately supplied selected crop, in its own coordinates. Selected crop boundaries are artificial, not physical page edges. Remove the visible portions of clipped target letters up to the selection boundary; never modify pixels outside it.`,
      dataUrl: overview.toDataURL(),
    },
  ];
}
