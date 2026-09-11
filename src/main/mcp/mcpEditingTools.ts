import { z } from "zod";
import type { McpPageEditingService } from "../application/mcpPageEditingService";
import {
  allowArguments,
  identifierSchema,
  McpInvalidParams,
  readIdentifier,
  readWindow,
  windowProperties,
} from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";
const patchSchema = z
  .object({
    chapterId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    pageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    revision: z.string().regex(/^page-edit-v1:[a-f0-9]{16}$/),
    patches: z
      .array(
        z
          .object({
            blockId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
            translatedText: z.string().max(12000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export function createMcpEditingTools(
  service: McpPageEditingService,
  allowEditing: boolean,
): McpTool[] {
  const tools: McpTool[] = [
    {
      name: "carrot_get_page_blocks",
      description:
        "Read paginated source and translated text, app geometry and the exact editing revision. No OCR/model is started; image layers and local paths are excluded.",
      oauth: true,
      requiredScope: "carrot.read",
      inputSchema: {
        type: "object",
        properties: {
          chapterId: identifierSchema,
          pageId: identifierSchema,
          ...windowProperties,
        },
        required: ["chapterId", "pageId"],
        additionalProperties: false,
      },
      invoke: async (args) => {
        allowArguments(args, ["chapterId", "pageId", "offset", "limit"]);
        const window = readWindow(args);
        return textContent(
          await service.read(
            readIdentifier(args.chapterId),
            readIdentifier(args.pageId),
            window.offset,
            window.limit,
          ),
        );
      },
    },
  ];
  if (allowEditing) tools.push(translationPatchTool(service));
  return tools;
}

function translationPatchTool(service: McpPageEditingService): McpTool {
  return {
    name: "carrot_patch_translations",
    description:
      "Save only specified existing block translations through the app. Requires a current revision. Preserves all geometry, ordering, masks and formatting. Returns an inverse patch for undo. Never creates blocks or calls OCR/models.",
    oauth: true,
    requiredScope: "carrot.edit",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        chapterId: identifierSchema,
        pageId: identifierSchema,
        revision: { type: "string", pattern: "^page-edit-v1:[a-f0-9]{16}$" },
        patches: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              blockId: identifierSchema,
              translatedText: { type: "string", maxLength: 12000 },
            },
            required: ["blockId", "translatedText"],
            additionalProperties: false,
          },
        },
      },
      required: ["chapterId", "pageId", "revision", "patches"],
      additionalProperties: false,
    },
    invoke: async (args, guard) => {
      const parsed = patchSchema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      const input = parsed.data;
      if (
        new Set(input.patches.map((patch) => patch.blockId)).size !==
        input.patches.length
      )
        throw new McpInvalidParams();
      return textContent(
        await service.patch(
          input.chapterId,
          input.pageId,
          input.revision,
          input.patches,
          guard,
        ),
      );
    },
  };
}
