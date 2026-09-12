import { z } from "zod";
import type { McpPageImageService } from "../application/mcpPageImageService";
import {
  allowArguments,
  identifierSchema,
  readIdentifier,
  McpInvalidParams,
} from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

const pixelRect = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  })
  .strict();
export function createMcpPageImageTools(
  service: McpPageImageService,
): McpTool[] {
  return [false, true].map((crop) => ({
    name: crop ? "carrot_get_page_crop" : "carrot_render_page_preview",
    requiredScopes: ["carrot.read", "carrot.images"],
    description: crop
      ? "Read an enlarged source-page region. Rectangle x,y,w,h is in ORIGINAL IMAGE PIXELS, not normalized block coordinates. Returns mapping from returned-image pixels to original pixels. Does not run OCR or modify anything."
      : "Render the saved page using the actual app renderer, including current translated text, styles and any existing inpainting. Does NOT erase source text, run OCR, translate or change layout settings. Returns a reduced PNG, not an original-resolution export.",
    inputSchema: {
      type: "object",
      properties: {
        chapterId: identifierSchema,
        pageId: identifierSchema,
        ...(crop
          ? {
              rect: {
                type: "object",
                properties: {
                  x: { type: "integer", minimum: 0 },
                  y: { type: "integer", minimum: 0 },
                  w: { type: "integer", minimum: 1 },
                  h: { type: "integer", minimum: 1 },
                },
                required: ["x", "y", "w", "h"],
                additionalProperties: false,
              },
            }
          : {}),
      },
      required: ["chapterId", "pageId", ...(crop ? ["rect"] : [])],
      additionalProperties: false,
    },
    invoke: async (args) => {
      allowArguments(args, ["chapterId", "pageId", ...(crop ? ["rect"] : [])]);
      const rect = crop ? pixelRect.safeParse(args.rect) : undefined;
      if (rect && !rect.success) throw new McpInvalidParams();
      const { imageData, ...metadata } = await service.read(
        readIdentifier(args.chapterId),
        readIdentifier(args.pageId),
        rect?.data,
      );
      return [
        ...textContent(metadata),
        { type: "image", data: imageData, mimeType: "image/png" },
      ];
    },
  }));
}
