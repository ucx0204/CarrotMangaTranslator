import { z } from "zod";
import type {
  McpOperationService,
  McpOperationContext,
} from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  McpInvalidParams,
  readIdentifier,
  identifierSchema,
} from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

const targetSchema = z
  .object({
    chapterId: z.string(),
    pageId: z.string(),
    revision: z.string().regex(/^page-v1:[a-f0-9]{16}$/),
    requestId: z.string().uuid(),
  })
  .strict();
export type McpOperationTarget = z.infer<typeof targetSchema>;
type Executor = (
  target: McpOperationTarget,
  context: McpOperationContext,
) => Promise<Record<string, unknown>>;
export function createMcpOperationTools(
  operations: McpOperationService,
  executors: { exportPng?: Executor; ocr?: Executor; erase?: Executor },
): McpTool[] {
  const tools: McpTool[] = [false, true].map((cancel) =>
    createJobControlTool(operations, cancel),
  );
  for (const [kind, execute] of Object.entries(executors))
    if (execute)
      tools.push(createStartOperationTool(operations, kind, execute));
  return tools;
}
function createJobControlTool(
  operations: McpOperationService,
  cancel: boolean,
): McpTool {
  return {
    name: cancel ? "carrot_cancel_job" : "carrot_get_job",
    readOnly: !cancel,
    requiredScopes: ["carrot.read"],
    description: cancel
      ? "Cancel a job owned by this connection. Does not undo already committed changes; read the resulting page before retrying."
      : "Read status and results of an owned OCR, erasure or PNG export job. Poll with a few seconds between calls. Receipts expire after one hour and server restart; artifacts expire sooner.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string", format: "uuid" } },
      required: ["jobId"],
      additionalProperties: false,
    },
    invoke: async (args, context) => {
      const parsed = z
        .object({ jobId: z.string().uuid() })
        .strict()
        .safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      const owner = principal(context);
      const result = cancel
        ? operations.cancel(parsed.data.jobId, owner)
        : operations.status(parsed.data.jobId, owner);
      const content = textContent(result);
      const artifact = result.result;
      if (
        !cancel &&
        artifact?.kind === "rendered-page-png" &&
        typeof artifact.url === "string" &&
        typeof artifact.bytes === "number"
      )
        content.push({
          type: "resource_link",
          uri: artifact.url,
          name: "carrot-page.png",
          mimeType: "image/png",
          size: artifact.bytes,
        });
      return content;
    },
  };
}
function createStartOperationTool(
  operations: McpOperationService,
  kind: string,
  execute: Executor,
): McpTool {
  const image = kind === "exportPng";
  return {
    name: image
      ? "carrot_export_page_png"
      : kind === "ocr"
        ? "carrot_run_page_ocr"
        : "carrot_run_page_erasure",
    readOnly: image,
    requiredScopes: ["carrot.read", image ? "carrot.images" : "carrot.process"],
    description: image
      ? "Export the current saved page as original-resolution PNG with the app renderer. Returns a jobId; use carrot_get_job for a ten-minute single-file download link. Never changes page data or runs OCR/translation."
      : kind === "ocr"
        ? "Run ONLY the app's configured local OCR on one page, saving editable untranslated blocks. Requires an empty page and current revision. No translation, erasure, image generation, or paid-model fallback. Model assets may be downloaded by the existing app. Returns a jobId."
        : "Erase original text for the page's existing non-excluded blocks with the app's configured LOCAL inpainting engine and existing masks. No OCR, translation, Codex or automatic bubble layout. Preserves translation text and styles. Model assets may be downloaded by the existing app. Returns a jobId.",
    inputSchema: {
      type: "object",
      properties: {
        chapterId: identifierSchema,
        pageId: identifierSchema,
        revision: { type: "string", pattern: "^page-v1:[a-f0-9]{16}$" },
        requestId: { type: "string", format: "uuid" },
      },
      required: ["chapterId", "pageId", "revision", "requestId"],
      additionalProperties: false,
    },
    invoke: async (args, context) => {
      const parsed = targetSchema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      readIdentifier(parsed.data.chapterId);
      readIdentifier(parsed.data.pageId);
      const owner = principal(context);
      return textContent(
        operations.start({
          owner,
          requestId: parsed.data.requestId,
          kind,
          parameters: parsed.data,
          assertAuthorized: () => context?.assertAuthorized(),
          execute: (operation) => execute(parsed.data, operation),
        }),
      );
    },
  };
}

function principal(context: Parameters<McpTool["invoke"]>[1]): string {
  context?.assertAuthorized();
  if (!context?.principalId)
    throw new McpEditError(
      "access_denied",
      "An approved OAuth connection is required for managed jobs.",
    );
  return context.principalId;
}
