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
  oauth?: boolean;
  requiredScope?: string;
  readOnly?: boolean;
  invoke: (
    args: Record<string, unknown>,
    guard: () => void,
  ) => Promise<McpToolContent[]>;
};

export function createMcpReadTools(
  service: McpLibraryReadService,
  imageTransfer = false,
  oauth = false,
  editingProfile?: { allowEditing: boolean },
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
          mode: editingProfile?.allowEditing ? "editing" : "read-only",
          features: features(imageTransfer, editingProfile),
          translation: false,
          imageTransfer,
          imageRedaction: "preview-blocked-when-local-review-is-required",
          sampling: false,
          oauth,
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
  const securitySchemes = [
    {
      type: "oauth2",
      scopes: [
        ...new Set(["carrot.read", tool.requiredScope ?? "carrot.read"]),
      ],
    },
  ];
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.oauth ? { securitySchemes, _meta: { securitySchemes } } : {}),
    annotations: {
      readOnlyHint: tool.readOnly !== false,
      destructiveHint: false,
      idempotentHint: tool.readOnly !== false,
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

export async function invokeMcpTool(
  tool: McpTool,
  value: unknown,
  guard: () => void = () => undefined,
) {
  return tool.invoke(argumentObject(value), guard);
}

function features(
  images: boolean,
  editing?: { allowEditing: boolean },
): string[] {
  return [
    "library.read",
    ...(images ? ["page.preview"] : []),
    ...(editing ? ["page.blocks.read"] : []),
    ...(editing?.allowEditing ? ["page.translations.patch"] : []),
  ];
}
