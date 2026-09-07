import { nativeImage } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { CodexPageReading } from "../../shared/codexTypesettingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { normalizedRegionToPixelRect } from "../../shared/region";
import { getActiveGeneratedLettering } from "../../shared/generatedLettering";
import { parseRichText } from "../../shared/richTextMarkup";
import type { TranslationBlock } from "../../shared/textTypes";
import type { CodexAppServerClient } from "../codexAppServerClient";
import { generateImage } from "./codexTypesettingImageRequest";
import { sourceRegionCrops } from "./codexTypesettingRaster";
import type {
  TypesettingComposition,
  TypesettingLetteringContext,
  TypesettingImage,
} from "../application/codexTypesettingContracts";

export async function generateLetteringLayers(
  page: MangaPage,
  reading: CodexPageReading,
  blockId: (id: string) => string,
  client: Pick<CodexAppServerClient, "runEphemeralTurn">,
  directory: string,
  signal: AbortSignal,
  context: TypesettingLetteringContext,
): Promise<TypesettingComposition> {
  const blocks = [...page.blocks];
  const imageRegions = reading.regions.filter(
    (item) => item.action === "image",
  );
  let references: TypesettingImage[] | undefined;
  for (const [regionIndex, region] of imageRegions.entries()) {
    signal.throwIfAborted();
    try {
      const id = blockId(region.id);
      const index = blocks.findIndex((block) => block.id === id);
      const block = blocks[index];
      if (!block) throw new Error("효과음 식자 영역이 없습니다.");
      const existing = reusableLettering(block, region.id, context);
      if (existing) {
        blocks[index] = { ...block, generatedLettering: existing };
        continue;
      }
      const destination = normalizedRegionToPixelRect(
        block.renderBbox ?? block.bbox,
        page,
      );
      references ??= await sourceRegionCrops(
        [page],
        new Map([[page.id, { ...reading, regions: imageRegions }]]),
        true,
      );
      const reference = references[regionIndex];
      if (!reference) throw new Error("효과음 원문 참고 이미지가 없습니다.");
      const output = await generateImage(
        client,
        directory,
        signal,
        letteringPrompt(
          block,
          region.id,
          destination,
          context,
          reference.label,
        ),
        [reference.dataUrl],
        { width: destination.w, height: destination.h },
      );
      const bytes = transparentLetteringBytes(
        output,
        letteringMatteChannel(block),
      );
      blocks[index] = {
        ...block,
        generatedLettering: {
          version: 1,
          dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
          occlusionPolygons: region.occlusionPolygons,
          sourceText: block.sourceText,
          translatedText: block.translatedText,
        },
      };
      await writeFile(
        join(directory, `lettering-${block.id}-${context.attempt}.png`),
        bytes,
      );
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(
        `효과음 생성 실패 (${region.sourceText}): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return { page: { ...page, blocks }, issues: [] };
}

function reusableLettering(
  block: TranslationBlock,
  regionId: string,
  context: TypesettingLetteringContext,
) {
  if (
    context.issues.some(
      (issue) => issue.regionId === regionId && issue.kind === "image",
    )
  )
    return null;
  const previous = context.previousPage?.blocks.find(
    (item) => item.id === block.id,
  );
  if (!previous) return null;
  if (
    (
      [
        "bold",
        "italic",
        "textColor",
        "outlineColor",
        "outlineWidthPx",
        "fontFamily",
      ] as const
    ).some((key) => previous[key] !== block[key])
  )
    return null;
  const from = previous.renderBbox ?? previous.bbox;
  const to = block.renderBbox ?? block.bbox;
  if (Math.abs(from.w / from.h - to.w / to.h) > 0.005) return null;
  return getActiveGeneratedLettering({
    ...block,
    generatedLettering: previous.generatedLettering,
  });
}

function letteringPrompt(
  block: TranslationBlock,
  regionId: string,
  size: { w: number; h: number },
  context: TypesettingLetteringContext,
  sourceReferenceLabel: string,
): string {
  const style = context.plan.groups.find((group) =>
    group.members.some((member) => member.regionId === regionId),
  );
  const typography = parseRichText(
    block.translatedText,
    block.bold,
    block.italic,
  );
  return `Create a NEW foreground lettering asset on a perfectly uniform flat ${letteringMatteColor(block)} chroma-key background. This is a new foreground asset, not a background-edit operation. Render exactly ${JSON.stringify(typography.plainText)}. Every character must be correct. No other text, Japanese, paper, surrounding drawing, checkerboard, gradients or shadows. The only background is solid ${letteringMatteColor(block)}, including every gap and enclosed counter. Never use the matte color in the lettering. The app removes this exact matte locally to produce real alpha. Keep a small uniform matte margin around complete strokes.
If the source letters pass behind a balloon or foreground object, generate the complete translated word; do not bake the occluder or crop edge into the asset. The app applies the separate occlusion mask.
The attached image is the ORIGINAL source lettering crop, not the cleaned background: ${sourceReferenceLabel}.
Use the visible source glyphs as the primary style reference: match stroke pressure, weight, tapered or rounded terminals, hollow versus filled strokes, outline-to-glyph width ratio, irregular spacing and character-size hierarchy. Reinterpret these traits as legible target-language syllables; do not copy Japanese glyphs or neighboring drawing. Preserve narrow white edging only where it exists in the source. No extra glow, shadow or sticker halo.
The family description and planned treatment below guide consistency and emphasis; do not replace the visible hand lettering with a generic font. Keep contours legible at the stated ORIGINAL PAGE size after reduction, scaling their thickness proportionally with the asset resolution. Preserve complete syllable anatomy and the same solid matte color in every background gap.
Preserve the per-run emphasis, size and color in this typography description; do not print its field names: ${JSON.stringify(typography.runs)}.
The source chapter's font-family analysis describes this style: ${JSON.stringify(style?.description ?? "expressive hand-drawn manga lettering")}.
Treatment: ${JSON.stringify({ bold: block.bold, italic: block.italic, fill: block.textColor, outline: block.outlineColor, outlineWidthInPagePixels: block.outlineWidthPx })}.
Destination is ${size.w} by ${size.h} ORIGINAL PAGE pixels. Keep the matching aspect ratio. The app applies ${block.rotationDeg ?? 0} degrees of rotation separately; do not duplicate it.
${context.issues.length ? `Correct these observed defects: ${JSON.stringify(context.issues.filter((issue) => issue.regionId === regionId))}` : ""}`;
}

function assertTransparentLettering(image: PNG): void {
  let transparent = 0;
  let visible = 0;
  for (let offset = 3; offset < image.data.length; offset += 4) {
    if (image.data[offset] === 0) transparent++;
    if (image.data[offset] > 127) visible++;
  }
  if (!transparent || !visible)
    throw new Error("효과음 전경에 실제 투명 배경과 글자 픽셀이 필요합니다.");
}

function transparentLetteringBytes(output: Buffer, channel: number): Buffer {
  const generated = nativeImage.createFromBuffer(output);
  if (generated.isEmpty())
    throw new Error("ImageGen 효과음 이미지가 비어 있습니다.");
  const image = PNG.sync.read(generated.toPNG());
  if (!image.data.some((value, index) => index % 4 === 3 && value === 0))
    removeLetteringMatte(image, channel);
  assertTransparentLettering(image);
  const bytes = PNG.sync.write(image);
  if (bytes.length > 5_999_980)
    throw new Error("효과음 레이어가 저장 용량 제한을 초과했습니다.");
  return bytes;
}

function letteringMatteChannel(block: TranslationBlock): number {
  const colors = [block.textColor, block.outlineColor ?? "#ffffff"].map(
    (color) =>
      [1, 3, 5].map(
        (index) => Number.parseInt(color.slice(index, index + 2), 16) || 0,
      ),
  );
  return [1, 2, 0].sort((a, b) =>
    colors.reduce((sum, color) => sum + color[a] - color[b], 0),
  )[0];
}
function letteringMatteColor(block: TranslationBlock): string {
  return ["#ff0000", "#00ff00", "#0000ff"][letteringMatteChannel(block)];
}
function removeLetteringMatte(image: PNG, channel: number): void {
  const others = [0, 1, 2].filter((value) => value !== channel);
  const corners = [
    0,
    (image.width - 1) * 4,
    (image.height - 1) * image.width * 4,
    image.data.length - 4,
  ];
  const strongest = corners.sort(
    (a, b) =>
      image.data[b + channel] -
      Math.max(image.data[b + others[0]], image.data[b + others[1]]) -
      image.data[a + channel] +
      Math.max(image.data[a + others[0]], image.data[a + others[1]]),
  )[0];
  const matte = [0, 1, 2].map((component) => image.data[strongest + component]);
  const strength =
    matte[channel] - Math.max(matte[others[0]], matte[others[1]]);
  if (strength < 96)
    throw new Error("효과음의 단색 분리 배경을 확인할 수 없습니다.");
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const key = image.data[offset + channel];
    const remainder = Math.max(
      image.data[offset + others[0]],
      image.data[offset + others[1]],
    );
    const excess = Math.max(0, key - remainder);
    const rawAlpha = Math.max(0, 1 - excess / strength);
    const alpha = rawAlpha < 0.12 ? 0 : rawAlpha;
    image.data[offset + 3] = Math.round(255 * alpha);
    if (alpha <= 0) {
      image.data.fill(0, offset, offset + 4);
      continue;
    }
    for (let component = 0; component < 3; component++) {
      const value =
        image.data[offset + component] - matte[component] * (1 - alpha);
      image.data[offset + component] = Math.max(
        0,
        Math.min(255, Math.round(value / alpha)),
      );
    }
  }
}
