import { z } from "zod";
import type { McpPageEditService } from "../application/mcpPageEditService";
import {
  allowArguments,
  identifierSchema,
  McpInvalidParams,
  readIdentifier,
  readWindow,
  windowProperties,
} from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

const editSchema = z
  .object({
    chapterId: z.string().min(1).max(128),
    pageId: z.string().min(1).max(128),
    revision: z.string().regex(/^page-v1:[a-f0-9]{16}$/),
    edits: z
      .array(
        z
          .object({
            blockId: z.string().min(1).max(128),
            translatedText: z.string().max(8192),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export function createMcpPageEditTools(
  service: McpPageEditService,
  allowEditing: boolean,
): McpTool[] {
  const tools: McpTool[] = [
    {
      name: "carrot_get_page_blocks",
      oauth: true,
      requiredScopes: ["carrot.read"],
      description:
        "Read existing OCR/translation blocks, coordinates and revision from the app. Paginated; no OCR/model runs and no image artifacts returned.",
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
        return textContent(
          await service.read(
            readIdentifier(args.chapterId),
            readIdentifier(args.pageId),
            readWindow(args),
          ),
        );
      },
    },
  ];
  if (allowEditing) tools.push(translationPatchTool(service));
  return tools;
}

function translationPatchTool(service: McpPageEditService): McpTool {
  return {
    name: "carrot_update_translations",
    oauth: true,
    readOnly: false,
    requiredScopes: ["carrot.read", "carrot.edit"],
    description:
      "Save only translatedText of specified existing blocks via the app, preserving geometry/style/masks. Requires the revision returned by carrot_get_page_blocks. Local dirty edits/jobs block writes; conflicts require re-reading. Does NOT run OCR, translation models, erasure or export. Returns previous texts for explicit restoration with the new revision.",
    inputSchema: {
      type: "object",
      properties: {
        chapterId: identifierSchema,
        pageId: identifierSchema,
        revision: { type: "string", pattern: "^page-v1:[a-f0-9]{16}$" },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              blockId: identifierSchema,
              translatedText: { type: "string", maxLength: 8192 },
            },
            required: ["blockId", "translatedText"],
            additionalProperties: false,
          },
        },
      },
      required: ["chapterId", "pageId", "revision", "edits"],
      additionalProperties: false,
    },
    invoke: async (args, context) => {
      const parsed = editSchema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      readIdentifier(parsed.data.chapterId);
      readIdentifier(parsed.data.pageId);
      parsed.data.edits.forEach((edit) => readIdentifier(edit.blockId));
      return textContent(
        await service.update(
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
