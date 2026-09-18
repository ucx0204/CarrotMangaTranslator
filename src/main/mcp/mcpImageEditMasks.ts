import type { MangaPage } from "../../shared/libraryTypes";
import type { InpaintingRetouchGeometry } from "../../shared/inpaintingTypes";
import type { McpImageEditCommand } from "../../shared/mcpImageEditing";
import { McpEditError } from "../application/mcpEditPolicy";
import { buildPatternPageMask } from "../inpainting/patternPageMask";
import { bboxToPixelRect, mergeMaskIntoPage } from "../inpainting/maskGeometry";
import {
  applyRetouchEllipse,
  applyRetouchRectangle,
  buildMaskFromStrokes,
  maskComponents,
  sanitizeMaskStrokes,
} from "../inpainting/rasterMasks";

/** Geometry/segmentation remain native; this adapter only selects and subtracts. */
export function buildMcpImageEditMasks(
  page: MangaPage,
  command: McpImageEditCommand,
  sourceBitmap: Buffer,
  signal?: AbortSignal,
) {
  const geometries =
    command.kind === "erase-mask"
      ? command.strokes.map((stroke) => ({
          ...stroke,
          kind: "stroke" as const,
        }))
      : "geometry" in command
        ? [command.geometry]
        : [];
  const protections = [...command.protectedAreas];
  if (command.kind === "erase-blocks") {
    validateBlockSelection(page, command.blockIds);
    protections.push(...unselectedBlockGeometry(page, command.blockIds));
  }
  validateGeometryWork(page, [...geometries, ...protections]);
  signal?.throwIfAborted();
  const protectedMask = rasterizeGeometry(page, protections);
  const mask =
    command.kind === "erase-blocks"
      ? buildPatternPageMask({
          page,
          bitmap: sourceBitmap,
          width: page.width,
          height: page.height,
          blockIds: command.blockIds,
          mode:
            command.expectedEngine === "flux-klein" ? "flux-region" : "glyph",
          signal,
        }).pageMask
      : rasterizeGeometry(page, geometries);
  for (let i = 0; i < mask.length; i++) if (protectedMask[i]) mask[i] = 0;
  const before = countPixels(mask);
  const components = maskComponents(
    mask,
    page.width,
    page.height,
    "expectedEngine" in command ? 12 : 1,
  );
  mask.fill(0);
  for (const component of components)
    mergeMaskIntoPage(mask, page.width, component.rect, component.data);
  signal?.throwIfAborted();
  const selectedPixels = countPixels(mask);
  return {
    mask,
    protectedMask,
    stats: {
      width: page.width,
      height: page.height,
      selectedPixels,
      protectedPixels: countPixels(protectedMask),
      droppedPixels: before - selectedPixels,
      components: components.length,
    },
  };
}

function validateBlockSelection(page: MangaPage, ids: string[]) {
  if (
    new Set(ids).size !== ids.length ||
    new Set(page.blocks.map((block) => block.id)).size !== page.blocks.length
  )
    throw new McpEditError(
      "invalid_edit",
      "Distinct stored and requested block IDs are required.",
    );
  for (const id of ids) {
    const block = page.blocks.find((entry) => entry.id === id);
    if (!block)
      throw new McpEditError("not_found", "Selected erasure block is missing.");
    if (block.inpaintExcluded || block.generatedLettering)
      throw new McpEditError(
        "invalid_edit",
        "Excluded/generated blocks are not eligible for this block erasure. No broader target was substituted.",
      );
    if (
      ![block.bbox.x, block.bbox.y, block.bbox.w, block.bbox.h].every(
        Number.isFinite,
      ) ||
      block.bbox.w <= 0 ||
      block.bbox.h <= 0
    )
      throw new McpEditError(
        "invalid_edit",
        "Selected source geometry is invalid.",
      );
  }
}
function unselectedBlockGeometry(
  page: MangaPage,
  ids: string[],
): InpaintingRetouchGeometry[] {
  const selected = new Set(ids);
  return page.blocks
    .filter((block) => !selected.has(block.id))
    .map((block) => {
      const rect = bboxToPixelRect(block.bbox, page);
      return {
        kind: "rectangle",
        start: { x: rect.x, y: rect.y },
        end: { x: rect.x + rect.w - 1, y: rect.y + rect.h - 1 },
      };
    });
}

function validateGeometryWork(
  page: MangaPage,
  geometries: InpaintingRetouchGeometry[],
) {
  let points = 0,
    work = 0;
  for (const geometry of geometries) {
    const coordinates =
      geometry.kind === "stroke"
        ? geometry.points
        : [geometry.start, geometry.end];
    points += coordinates.length;
    for (const point of coordinates)
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.y < 0 ||
        point.x > page.width - 1 ||
        point.y > page.height - 1
      )
        throw new McpEditError(
          "invalid_edit",
          "Mask points must lie inside the original page; out-of-page input is not silently clamped.",
        );
    work += geometryWork(geometry, page.width * page.height);
  }
  if (points > 12_000 || work > 128_000_000)
    throw new McpEditError(
      "invalid_edit",
      "Mask geometry exceeds the bounded raster-work budget. Split the explicit edit.",
    );
}
function geometryWork(geometry: InpaintingRetouchGeometry, pagePixels: number) {
  if (geometry.kind !== "stroke")
    return (
      (Math.abs(geometry.end.x - geometry.start.x) + 2) *
      (Math.abs(geometry.end.y - geometry.start.y) + 2)
    );
  const radius = Math.max(2, Math.min(180, Math.round(geometry.radiusPx)));
  const area = Math.min(pagePixels, (radius * 2 + 1) ** 2);
  return geometry.points.reduce((sum, point, i) => {
    const previous = geometry.points[i - 1] ?? point;
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    return (
      sum +
      (Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.35))) + 1) * area
    );
  }, 0);
}
function rasterizeGeometry(
  page: MangaPage,
  geometries: InpaintingRetouchGeometry[],
) {
  const strokes = geometries.filter((item) => item.kind === "stroke");
  // Avoid native sanitizer truncation across multiple protected/erase groups.
  const mask = new Uint8Array(page.width * page.height);
  for (let offset = 0; offset < strokes.length; offset += 200) {
    const part = buildMaskFromStrokes(
      sanitizeMaskStrokes(
        strokes.slice(offset, offset + 200),
        page.width,
        page.height,
      ),
      page.width,
      page.height,
    );
    for (let i = 0; i < mask.length; i++) if (part[i]) mask[i] = 1;
  }
  const shapes = geometries.filter((item) => item.kind !== "stroke");
  if (!shapes.length) return mask;
  const bitmap = Buffer.alloc(mask.length * 4);
  for (const shape of shapes) {
    const apply =
      shape.kind === "ellipse" ? applyRetouchEllipse : applyRetouchRectangle;
    apply(bitmap, bitmap, page.width, page.height, shape, "paint", {
      r: 255,
      g: 255,
      b: 255,
    });
  }
  for (let i = 0; i < mask.length; i++) if (bitmap[i * 4]) mask[i] = 1;
  return mask;
}
function countPixels(mask: Uint8Array) {
  return mask.reduce((total, value) => total + (value ? 1 : 0), 0);
}
