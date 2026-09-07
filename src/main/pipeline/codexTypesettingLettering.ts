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
        false,
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
  const typography = parseRichText(block.translatedText);
  return `Create a foreground lettering asset that transfers the visual treatment of the attached ORIGINAL source glyphs to the approved target text. Render exactly ${JSON.stringify(typography.plainText)}. Every character must be correct. Do not translate, extend or paraphrase that text.
ORIGINAL source lettering crop: ${sourceReferenceLabel}. Inspect the lettering itself, separate from surrounding artwork. Its appearance is authoritative. Match the interior tone and ink coverage, spatial texture and grain, speckles and worn patches, the shape and continuity of outlines, the relation of edge color to interior color, stroke construction, terminals, proportions, slant, spacing and character-size hierarchy. Preserve the source's variations within strokes and across letters at a comparable relative scale. Adapt the glyph anatomy to the target script while retaining those visible attributes. Do not normalize the reference into a standard brush-lettering treatment or substitute default text styling.
LAYOUT: The reference is the exact source bounding box, and its full canvas maps edge-to-edge to the destination canvas. Preserve the original lettering's relative positions, reading path, separate groups, changing character sizes, slants and empty gaps. Place target glyph groups along the same path and within the corresponding occupied areas, adapting different character counts proportionally. Keep intervening artwork areas empty. Do not recenter, straighten, evenly distribute, or collapse scattered lettering into a single column. Do not reproduce surrounding artwork.
${style?.description ? `Additional observed family characteristics: ${JSON.stringify(style.description)}. Use only where consistent with the source crop.` : ""}
${block.translatedText !== typography.plainText ? `Explicit per-span overrides from text markup: ${JSON.stringify(typography.runs)}. Apply these overrides without replacing the reference texture.` : ""}
Generate only the complete lettering. If the source passes behind a balloon or foreground object, keep the word complete without baking the occluder or crop edge into it; the app applies a separate occlusion mask. Do not copy Japanese glyphs, neighboring drawings, paper or panels. Do not add decorative effects absent from the source.
Place the asset on a perfectly uniform flat ${letteringMatteColor(block)} chroma-key background, also in every empty gap and enclosed counter. This background must have no texture, gradient, shadow or checkerboard. Preserve texture and tonal variation INSIDE the lettering. Never use the matte color as part of the lettering. The app removes the matte locally to produce real alpha. Retain the reference's existing margins rather than adding padding that shifts or shrinks the lettering.
Destination is ${size.w} by ${size.h} ORIGINAL PAGE pixels. Match its aspect ratio and retain the source treatment when reduced to this size. The app applies ${block.rotationDeg ?? 0} degrees of rotation separately; do not duplicate it.
${context.issues.length ? `Observed defects: ${JSON.stringify(context.issues.filter((issue) => issue.regionId === regionId))}` : ""}`;
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
