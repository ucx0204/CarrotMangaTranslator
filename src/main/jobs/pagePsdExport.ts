import {
  writePsdBuffer,
  type Layer,
  type LayerTextData,
  type PixelData,
  type Psd,
} from "ag-psd";
import { PNG } from "pngjs";
import { resolveBlockRenderBbox } from "../../shared/geometry";
import type { MangaPage } from "../../shared/libraryTypes";
import { parseRichText } from "../../shared/richTextMarkup";
import type { TranslationBlock } from "../../shared/textTypes";
import { resolveTextEffectFilter } from "../../shared/textEffect";
import { resolveEffectiveTextOutlineWidthPx } from "../../shared/textOutline";

type PagePsdTextLayerInput = {
  block: TranslationBlock;
  png: Buffer;
};

export type BuildPagePsdInput = {
  cleanedBackgroundPng?: Buffer;
  compositePng: Buffer;
  originalBackgroundPng: Buffer;
  page: MangaPage;
  textLayers: PagePsdTextLayerInput[];
};

export function buildPagePsd({
  cleanedBackgroundPng,
  compositePng,
  originalBackgroundPng,
  page,
  textLayers,
}: BuildPagePsdInput): Buffer {
  const composite = decodePagePng(compositePng, page);
  const original = decodePagePng(originalBackgroundPng, page);
  // ag-psd serializes children in PSD record order: bottom layer first. Keep
  // the backgrounds at the beginning and append text in visual paint order so
  // Photoshop presents text above cleanup, and cleanup above the original.
  const children: Layer[] = [
    {
      name: "원본 배경 (Original)",
      imageData: original,
      protected: { composite: true, position: true, transparency: true },
    },
  ];
  if (cleanedBackgroundPng) {
    children.push({
      name: "정리 배경 (Inpaint)",
      imageData: decodePagePng(cleanedBackgroundPng, page),
    });
  }
  children.push(...buildTextLayers(page, textLayers));

  const psd: Psd = {
    width: page.width,
    height: page.height,
    imageData: composite,
    children,
    imageResources: {
      versionInfo: {
        hasRealMergedData: true,
        writerName: "Carrot Manga Translator",
        readerName: "Carrot Manga Translator",
        fileVersion: 1,
      },
    },
  };
  return writePsdBuffer(psd, {
    compress: true,
    generateThumbnail: false,
    noBackground: true,
    trimImageData: true,
  });
}

function buildTextLayers(
  page: MangaPage,
  inputs: PagePsdTextLayerInput[],
): Layer[] {
  return inputs.flatMap((input, index) => {
    const full = decodePagePng(input.png, page);
    const cropped = cropTransparentPixelData(full);
    if (!cropped) return [];
    if (!cropped.hasTransparentPixel) {
      throw new Error(
        `PSD text layer capture is fully opaque for block ${input.block.id} on ${page.name}.`,
      );
    }
    const displayText = input.block.translatedText || input.block.sourceText;
    const text = resolveEditablePsdText(input.block, page, displayText);
    return [
      {
        name: formatTextLayerName(index, displayText, Boolean(text)),
        left: cropped.left,
        top: cropped.top,
        imageData: cropped.imageData,
        ...(text ? { text } : {}),
      } satisfies Layer,
    ];
  });
}

export function resolveEditablePsdText(
  block: TranslationBlock,
  page: Pick<MangaPage, "width" | "height">,
  displayText = block.translatedText || block.sourceText,
): LayerTextData | null {
  if (!supportsEditablePsdText(block, displayText)) return null;
  const bbox = resolveBlockRenderBbox(block, page);
  const left = (bbox.x / 1000) * page.width;
  const top = (bbox.y / 1000) * page.height;
  const width = Math.max(1, (bbox.w / 1000) * page.width);
  const height = Math.max(1, (bbox.h / 1000) * page.height);
  const right = left + width;
  const bottom = top + height;
  const radians = ((block.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const fontSize = Math.max(1, block.fontSizePx);
  const bounds = {
    top: { units: "Pixels" as const, value: top },
    left: { units: "Pixels" as const, value: left },
    right: { units: "Pixels" as const, value: right },
    bottom: { units: "Pixels" as const, value: bottom },
  };
  return {
    text: displayText,
    transform: [cos, sin, -sin, cos, left, top],
    left,
    top,
    right,
    bottom,
    bounds,
    boundingBox: bounds,
    antiAlias: "smooth",
    orientation: "horizontal",
    shapeType: "box",
    boxBounds: [0, 0, width, height],
    style: {
      font: { name: resolvePsdFontName(block.fontFamily) },
      fontSize,
      fauxBold: Boolean(block.bold),
      fauxItalic: Boolean(block.italic),
      autoLeading: false,
      leading: fontSize * Math.max(0.5, block.lineHeight || 1),
      horizontalScale: Math.max(1, (block.fontWidthScale ?? 1) * 100),
      tracking: (block.letterSpacing ?? 0) * 1000,
      fillColor: parseHexColor(block.textColor, { r: 17, g: 17, b: 17 }),
      ...(block.outlineColor
        ? {
            strokeColor: parseHexColor(block.outlineColor, {
              r: 255,
              g: 255,
              b: 255,
            }),
            strokeFlag: true,
            fillFlag: true,
            // Preserve the legacy PSD contract for untouched scale-based
            // blocks. Only manually converted blocks use absolute pixels.
            outlineWidth:
              block.outlineWidthPx === undefined
                ? Math.max(0, block.outlineWidthScale ?? 1)
                : resolveEffectiveTextOutlineWidthPx(block, fontSize),
          }
        : {}),
    },
    paragraphStyle: { justification: block.textAlign },
  };
}

function supportsEditablePsdText(
  block: TranslationBlock,
  displayText: string,
): boolean {
  if (
    !displayText ||
    block.renderDirection === "vertical" ||
    resolveTextEffectFilter(block.textEffect)
  ) {
    return false;
  }
  const parsed = parseRichText(displayText);
  if (
    parsed.plainText !== displayText ||
    parsed.runs.some(
      (run) =>
        run.bold ||
        run.italic ||
        run.sizePx !== undefined ||
        run.fontFamily !== undefined ||
        run.opacity !== undefined,
    )
  ) {
    // ag-psd exposes only one text style for this editable layer contract.
    // Keep the faithfully rendered raster layer instead of leaking markup or
    // flattening per-character styles into the wrong editable appearance.
    return false;
  }
  return (
    !block.curveLayout && !block.perspectiveTransform && !block.warpTransform
  );
}

export function cropTransparentPixelData(imageData: PixelData): {
  imageData: PixelData;
  left: number;
  top: number;
  hasTransparentPixel: boolean;
} | null {
  const { data, width, height } = imageData;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let hasTransparentPixel = false;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) === 0) {
        hasTransparentPixel = true;
        continue;
      }
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return null;
  const croppedWidth = right - left + 1;
  const croppedHeight = bottom - top + 1;
  const cropped = new Uint8Array(croppedWidth * croppedHeight * 4);
  for (let y = 0; y < croppedHeight; y += 1) {
    const sourceStart = ((top + y) * width + left) * 4;
    const sourceEnd = sourceStart + croppedWidth * 4;
    cropped.set(data.subarray(sourceStart, sourceEnd), y * croppedWidth * 4);
  }
  return {
    left,
    top,
    hasTransparentPixel,
    imageData: { data: cropped, width: croppedWidth, height: croppedHeight },
  };
}

function decodePagePng(
  png: Buffer,
  page: Pick<MangaPage, "width" | "height" | "name">,
): PixelData {
  const decoded = PNG.sync.read(png, { skipRescale: true });
  if (decoded.width !== page.width || decoded.height !== page.height) {
    throw new Error(
      `PSD layer dimensions changed for ${page.name}: ${decoded.width}x${decoded.height}`,
    );
  }
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

function resolvePsdFontName(fontFamily: string | undefined): string {
  const value = String(fontFamily ?? "").trim();
  return value && value !== "default" ? value : "ArialMT";
}

function parseHexColor(
  value: string | undefined,
  fallback: { r: number; g: number; b: number },
): { r: number; g: number; b: number } {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value ?? ""));
  if (!match?.[1]) return fallback;
  return {
    r: Number.parseInt(match[1].slice(0, 2), 16),
    g: Number.parseInt(match[1].slice(2, 4), 16),
    b: Number.parseInt(match[1].slice(4, 6), 16),
  };
}

function formatTextLayerName(
  index: number,
  text: string,
  editable: boolean,
): string {
  const compact = text.replace(/\s+/g, " ").trim().slice(0, 42) || "빈 블록";
  const order = String(index + 1).padStart(3, "0");
  return `${order} ${compact}${editable ? "" : " [raster]"}`;
}
