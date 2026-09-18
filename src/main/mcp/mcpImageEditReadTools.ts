import { nativeImage } from "electron";
import { PNG } from "pngjs";
import {
  McpImageEditMaskGetSchema,
  McpImageColorSampleSchema,
  type McpImageEditChangeView,
} from "../../shared/mcpImageEditing";
import { readImageRedactionState } from "../imageRedactionStore";
import { sampleImageColor } from "../inpainting";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  readMcpImageEditPage,
  prepareMcpImageEdit,
  captureMcpImageFiles,
  verifyMcpImageFiles,
} from "./mcpImageEditEvidence";
import { createMcpBatchTool } from "./mcpBatchTool";
import { textContent } from "./mcpReadTools";

type Inspect = (
  owner: string,
  args: unknown,
  guard: () => void,
) => Promise<{
  chapterId: string;
  pages: { pageId: string; expectedRevision: string }[];
  changes: McpImageEditChangeView[];
}>;
const scopes = ["carrot.read", "carrot.images"];

export function createMcpImageEditReadTools(inspect: Inspect) {
  return [
    createMcpBatchTool({
      name: "carrot_get_image_edit_mask",
      schema: McpImageEditMaskGetSchema,
      scopes,
      write: false,
      description:
        "Read the actual reviewed image-edit mask BEFORE applying it. White=editable, blue=protected, black=unchanged. Returns a reduced PNG (at most 1600 pixels on its long edge), original dimensions and exact pixel counts; small features may not be visible at reduced resolution. A changed original, cleaned image, mask or page requires a new plan. No model, page save, source-image pixels or output file. Image permission and redaction policy apply.",
      execute: (args, owner, guard) =>
        readMaskPreview(inspect, args, owner, guard),
      formatResult: ({ imageData, ...metadata }) => [
        ...textContent(metadata),
        { type: "image", data: imageData, mimeType: "image/png" },
      ],
    }),
    createMcpBatchTool({
      name: "carrot_sample_page_color",
      schema: McpImageColorSampleSchema,
      scopes,
      write: false,
      description:
        "Sample one exact original-pixel coordinate from the original or current cleaned page using the native color sampler. No arbitrary path, silent fallback from missing cleaned image, model or mutation. Rechecks page/image versions and image-transfer/redaction permission before returning the RGB hex color. It does not sample rendered translation overlays.",
      execute: (args, owner, guard) => readColorSample(args, guard),
    }),
  ];
}

async function assertImageAccess(guard: () => void) {
  guard();
  if ((await readImageRedactionState()).enabled)
    throw new McpEditError(
      "access_denied",
      "Image editing previews and color samples are blocked while redaction review is enabled.",
    );
  guard();
}
function maskPng(
  mask: Uint8Array,
  protectedMask: Uint8Array,
  width: number,
  height: number,
) {
  const png = new PNG({ width, height });
  for (let i = 0; i < mask.length; i++) {
    png.data[i * 4] = mask[i] ? 255 : 0;
    png.data[i * 4 + 1] = mask[i] ? 255 : 0;
    png.data[i * 4 + 2] = mask[i] || protectedMask[i] ? 255 : 0;
    png.data[i * 4 + 3] = 255;
  }
  const scale = Math.min(1, 1600 / Math.max(width, height));
  const preview = nativeImage.createFromBuffer(PNG.sync.write(png)).resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: "best",
  });
  const bytes = preview.toPNG();
  if (bytes.length > 4 * 1024 * 1024)
    throw new McpEditError(
      "invalid_edit",
      "Mask preview exceeds 4 MiB; no image was returned.",
    );
  const size = preview.getSize();
  return {
    imageData: bytes.toString("base64"),
    previewWidth: size.width,
    previewHeight: size.height,
  };
}

async function readMaskPreview(
  inspect: Inspect,
  args: unknown,
  owner: string,
  guard: () => void,
) {
  const input = McpImageEditMaskGetSchema.parse(args);
  await assertImageAccess(guard);
  const plan = await inspect(owner, { ...input, offset: 0, limit: 1 }, guard);
  const target = plan.pages[0],
    change = plan.changes[0];
  if (!target || !change)
    throw new McpEditError("not_found", "Image edit mask is unavailable.");
  const requested = {
    chapterId: plan.chapterId,
    pageId: target.pageId,
    revision: target.expectedRevision,
  };
  const page = await readMcpImageEditPage(requested, guard);
  const prepared = await prepareMcpImageEdit(page, change.command, guard);
  if (prepared.evidence.mask.snapshot !== change.mask.snapshot)
    throw new McpEditError(
      "revision_conflict",
      "The reviewed mask is stale; prepare a new image edit.",
    );
  const preview = maskPng(
    prepared.mask,
    prepared.protectedMask,
    page.width,
    page.height,
  );
  await readMcpImageEditPage(requested, guard);
  await assertImageAccess(guard);
  return {
    ...change.mask,
    ...input,
    ...requested,
    ...preview,
    legend: "white=editable; blue=protected; black=unchanged" as const,
  };
}

async function readColorSample(args: unknown, guard: () => void) {
  const input = McpImageColorSampleSchema.parse(args);
  await assertImageAccess(guard);
  const page = await readMcpImageEditPage(input, guard);
  if (input.x >= page.width || input.y >= page.height)
    throw new McpEditError(
      "invalid_edit",
      "Sample coordinates must be inside the original page.",
    );
  const path =
    input.image === "original" ? page.imagePath : page.inpaintedImagePath;
  if (!path)
    throw new McpEditError("not_found", "This page has no cleaned image.");
  const files = await captureMcpImageFiles(page, guard);
  const color = await sampleImageColor(path, input.x, input.y);
  await verifyMcpImageFiles(files, guard);
  await readMcpImageEditPage(input, guard);
  await assertImageAccess(guard);
  return { ...input, color };
}
