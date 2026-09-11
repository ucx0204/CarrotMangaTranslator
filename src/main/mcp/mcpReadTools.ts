import type { McpLibraryReadService } from "../application/mcpLibraryReadService";
import {
  allowArguments,
  argumentObject,
  identifierSchema,
  readIdentifier,
  readQuery,
  readWindow,
  windowProperties,
} from "./mcpArguments";

type McpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" };

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke: (args: Record<string, unknown>) => Promise<McpToolContent[]>;
};

export function createMcpReadTools(
  service: McpLibraryReadService,
  imageTransfer = false,
): McpTool[] {
  return [
    {
      name: "carrot_get_capabilities",
      description:
        "Report what this Carrot connection actually exposes. No models are started.",
      inputSchema: objectSchema({}),
      invoke: async (args) => {
        allowArguments(args, []);
        return textContent({
          mode: "read-only",
          features: imageTransfer
            ? ["library.read", "page.preview"]
            : ["library.read"],
          translation: false,
          imageTransfer,
          imageRedaction: "preview-blocked-when-local-review-is-required",
          sampling: false,
          oauth: false,
        });
      },
    },
    {
      name: "carrot_list_works",
      description:
        "Search and page through the existing app library. Does not return local paths or images.",
      inputSchema: objectSchema({
        ...windowProperties,
        query: { type: "string", maxLength: 200 },
      }),
      invoke: async (args) => {
        allowArguments(args, ["offset", "limit", "query"]);
        return textContent(
          await service.listWorks(readWindow(args), readQuery(args.query)),
        );
      },
    },
    {
      name: "carrot_list_chapters",
      description:
        "List chapters of a work by its opaque workId, not by a filesystem path.",
      inputSchema: objectSchema(
        { ...windowProperties, workId: identifierSchema },
        ["workId"],
      ),
      invoke: async (args) => {
        allowArguments(args, ["offset", "limit", "workId"]);
        return textContent(
          await service.listChapters(
            readIdentifier(args.workId),
            readWindow(args),
          ),
        );
      },
    },
    {
      name: "carrot_get_chapter",
      description:
        "Get chapter and paginated page metadata. Text, source images, errors and internal artifacts are excluded.",
      inputSchema: objectSchema(
        { ...windowProperties, chapterId: identifierSchema },
        ["chapterId"],
      ),
      invoke: async (args) => {
        allowArguments(args, ["offset", "limit", "chapterId"]);
        return textContent(
          await service.getChapter(
            readIdentifier(args.chapterId),
            readWindow(args),
          ),
        );
      },
    },
  ];
}

export function describeMcpTool(tool: McpTool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export function textContent(value: unknown): McpToolContent[] {
  return [{ type: "text", text: JSON.stringify(value) }];
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return { type: "object", properties, required, additionalProperties: false };
}

export async function invokeMcpTool(tool: McpTool, value: unknown) {
  return tool.invoke(argumentObject(value));
}
