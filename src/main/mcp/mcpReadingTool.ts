import { z } from "zod";
import type { McpReadingService } from "../application/mcpReadingService";
import {
  McpInvalidParams,
  identifierSchema,
  readIdentifier,
} from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

const rect = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  })
  .strict();
const direction = z.enum(["horizontal", "vertical"]);
const schema = z
  .object({
    chapterId: z.string().min(1).max(128),
    pageId: z.string().min(1).max(128),
    revision: z.string().regex(/^page-v1:[a-f0-9]{16}$/),
    requestId: z.string().uuid(),
    blocks: z
      .array(
        z
          .object({
            key: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
            sourceText: z.string().max(8192),
            translatedText: z.string().max(8192),
            sourceRect: rect,
            renderRect: rect.optional(),
            sourceDirection: direction.optional(),
            renderDirection: direction.optional(),
            textRole: z.enum(["ordinary", "sound"]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const rectSchema = {
  type: "object",
  properties: {
    x: { type: "integer", minimum: 0 },
    y: { type: "integer", minimum: 0 },
    w: { type: "integer", minimum: 1 },
    h: { type: "integer", minimum: 1 },
  },
  required: ["x", "y", "w", "h"],
  additionalProperties: false,
};
const directionSchema = { type: "string", enum: ["horizontal", "vertical"] };

export function createMcpReadingTool(service: McpReadingService): McpTool {
  return {
    name: "carrot_create_page_blocks",
    readOnly: false,
    requiredScopes: ["carrot.read", "carrot.process"],
    description:
      "Append editable blocks read/translated by the calling AI, in supplied reading order, preserving ALL existing blocks. Rectangles are ORIGINAL IMAGE PIXELS. Use a new UUID requestId per batch and a unique key per block; reuse them unchanged only for exact retries. Requires current revision. Empty translatedText stores OCR-only results. App typography defaults apply. Does NOT run OCR, paid models, erasure or output rendering.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["chapterId", "pageId", "revision", "requestId", "blocks"],
      properties: {
        chapterId: identifierSchema,
        pageId: identifierSchema,
        revision: { type: "string", pattern: "^page-v1:[a-f0-9]{16}$" },
        requestId: { type: "string", format: "uuid" },
        blocks: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "sourceText", "translatedText", "sourceRect"],
            properties: {
              key: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
              sourceText: { type: "string", maxLength: 8192 },
              translatedText: { type: "string", maxLength: 8192 },
              sourceRect: rectSchema,
              renderRect: rectSchema,
              sourceDirection: directionSchema,
              renderDirection: directionSchema,
              textRole: { type: "string", enum: ["ordinary", "sound"] },
            },
          },
        },
      },
    },
    invoke: async (args, context) => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      readIdentifier(parsed.data.chapterId);
      readIdentifier(parsed.data.pageId);
      return textContent(
        await service.create(
          {
            ...parsed.data,
            revision: parsed.data.revision as `page-v1:${string}`,
          },
          context?.assertAuthorized,
        ),
      );
    },
  };
}
