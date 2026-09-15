import { z } from "zod";
import type { MangaPage } from "../../shared/libraryTypes";
import type { McpReadingBlock } from "../../shared/mcpReadingTypes";
import { McpEditError } from "./mcpEditPolicy";

const hintSchema = z.object({
  x1: z.number().finite(),
  y1: z.number().finite(),
  x2: z.number().finite(),
  y2: z.number().finite(),
  ocrText: z.string().max(20_000).nullish(),
  direction: z.string().optional(),
  rolePrior: z.string().nullish(),
});
/** Coordinate adapter for the app OCR's final pixel hints; no detection or grouping algorithm is copied. */
export function mcpOcrReadingBlocks(
  page: MangaPage,
  hints: unknown[],
): McpReadingBlock[] {
  if (hints.length > 5000)
    throw new McpEditError("invalid_edit", "Too many OCR regions.");
  return hints.map((value, index) => {
    const parsed = hintSchema.safeParse(value);
    if (!parsed.success)
      throw new McpEditError(
        "invalid_edit",
        "The OCR engine returned invalid region data.",
      );
    const hint = parsed.data;
    const x = Math.max(0, Math.floor(hint.x1));
    const y = Math.max(0, Math.floor(hint.y1));
    const right = Math.min(page.width, Math.ceil(hint.x2));
    const bottom = Math.min(page.height, Math.ceil(hint.y2));
    if (x >= right || y >= bottom)
      throw new McpEditError(
        "invalid_edit",
        "An OCR region is outside the original page.",
      );
    return {
      key: `ocr-${index + 1}`,
      sourceText: hint.ocrText ?? "",
      translatedText: "",
      sourceRect: { x, y, w: right - x, h: bottom - y },
      sourceDirection:
        hint.direction === "vertical" ? "vertical" : "horizontal",
      textRole: hint.rolePrior === "sound" ? "sound" : "ordinary",
    };
  });
}
