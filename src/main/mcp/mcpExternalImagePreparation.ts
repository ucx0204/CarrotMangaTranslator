import type { MangaPage } from "../../shared/libraryTypes";
import type { McpExternalImagePreview } from "../../shared/mcpExternalImages";
import { generatedLettering } from "../../shared/blockFormatValueSchemas";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { ExternalImageChange } from "../application/mcpExternalImagePolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  captureMcpImageFiles,
  readMcpImageEditPage,
  verifyMcpImageFiles,
} from "./mcpImageEditEvidence";
import { imageUploadDigest } from "./mcpImageUploadFiles";
import { composeMcpExternalImage } from "./mcpExternalImagePixels";
import type { ExternalImageAssets } from "./mcpExternalImageAssets";

export async function prepareMcpExternalImage(
  page: MangaPage,
  input: McpExternalImagePreview,
  assets: ExternalImageAssets,
) {
  const files = await captureMcpImageFiles(page, assets.guard);
  if (hashStableValue(files) !== hashStableValue(assets.files))
    throw new McpEditError(
      "revision_conflict",
      "Original, cleaned image or mask differs from upload reservation.",
    );
  const pixels = await composeMcpExternalImage(page, input.command, assets);
  const blocks =
    input.command.kind === "lettering"
      ? letteringTransition(page, input.command, pixels.bytes)
      : {};
  const changed =
    pixels.selectedPixels > 0 &&
    (input.command.kind === "lettering"
      ? hashStableValue(blocks.beforeBlock) !==
        hashStableValue(blocks.afterBlock)
      : pixels.changedPixels > 0);
  const snapshot = hashStableValue([
    input.command,
    files,
    imageUploadDigest(pixels.bytes),
    imageUploadDigest(Buffer.from(pixels.mask)),
  ]);
  await verifyMcpImageFiles(files, assets.guard);
  await readMcpImageEditPage(input, assets.guard);
  assets.guard();
  const change: ExternalImageChange = {
    pageId: page.id,
    command: structuredClone(input.command),
    stats: {
      width: pixels.width,
      height: pixels.height,
      selectedPixels: pixels.selectedPixels,
      protectedPixels: pixels.protectedPixels,
      changedPixels: pixels.changedPixels,
      snapshot,
    },
    changed,
    excludedReason: changed ? null : "empty_or_unchanged_external_image",
    warnings: [
      "no_model_ocr_translation_or_erasure",
      "originals_text_geometry_and_format_preserved",
      "external_image_text_and_quality_not_verified",
      "session_recovery_not_durable",
      ...(input.command.kind === "lettering"
        ? [
            "asset_fits_existing_block_geometry",
            "lettering_preview_is_asset_not_final_render",
          ]
        : []),
    ],
    evidence: {
      files,
      mask: {
        width: page.width,
        height: page.height,
        selectedPixels: pixels.selectedPixels,
        protectedPixels: pixels.protectedPixels,
        droppedPixels: 0,
        components: pixels.selectedPixels ? 1 : 0,
        snapshot,
      },
    },
    recovery: {},
    outcome: null,
    ...blocks,
  };
  return { change, pixels };
}
function letteringTransition(
  page: MangaPage,
  command: Extract<McpExternalImagePreview["command"], { kind: "lettering" }>,
  bytes: Buffer,
) {
  const matches = page.blocks.filter((block) => block.id === command.blockId);
  if (matches.length !== 1)
    throw new McpEditError(
      "not_found",
      "One existing lettering block is required.",
    );
  const beforeBlock = structuredClone(matches[0]);
  if (beforeBlock.generatedLettering && !command.replaceExisting)
    throw new McpEditError(
      "invalid_edit",
      "Replacing an existing image layer requires replaceExisting=true.",
    );
  const artwork = generatedLettering.parse({
    ...(command.existingDecorations === "preserve"
      ? beforeBlock.generatedLettering
      : {}),
    version: 1,
    enabled: true,
    dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
    sourceText: beforeBlock.sourceText,
    translatedText: beforeBlock.translatedText,
  });
  return {
    beforeBlock,
    afterBlock: {
      ...structuredClone(beforeBlock),
      generatedLettering: artwork,
    },
  };
}
