import { createMcpJobRecoveryTools } from "./mcpJobRecoveryTools";
import { z } from "zod";
import type {
  McpOperationService,
  McpOperationExecutor,
} from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  McpInvalidParams,
  readIdentifier,
  identifierSchema,
} from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

const jobIdSchema = z.object({ jobId: z.string().uuid() }).strict();
const jobIdInputSchema = {
  type: "object",
  properties: { jobId: { type: "string", format: "uuid" } },
  required: ["jobId"],
  additionalProperties: false,
};

const targetSchema = z
  .object({
    chapterId: z.string(),
    pageId: z.string(),
    blockId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    revision: z.string().regex(/^page-v1:[a-f0-9]{16}$/),
    requestId: z.string().uuid(),
  })
  .strict();
export type McpOperationTarget = z.infer<typeof targetSchema>;
export function createMcpOperationTools(
  operations: McpOperationService,
  executors: {
    exportPng?: McpOperationExecutor;
    ocr?: McpOperationExecutor;
    erase?: McpOperationExecutor;
  },
  assertFileAvailable?: (url: string) => Promise<void>,
): McpTool[] {
  const tools: McpTool[] = [false, true].map((cancel) =>
    createJobControlTool(operations, cancel),
  );
  for (const [kind, execute] of Object.entries(executors))
    if (execute)
      tools.push(createStartOperationTool(operations, kind, execute));
  tools.push(...createMcpJobRecoveryTools(operations, executors));
  if (executors.exportPng && assertFileAvailable)
    tools.push(createJobFileTool(operations, assertFileAvailable));
  return tools;
}
function createJobControlTool(
  operations: McpOperationService,
  cancel: boolean,
): McpTool {
  return {
    name: cancel ? "carrot_cancel_job" : "carrot_get_job",
    readOnly: !cancel,
    destructive: false,
    idempotent: true,
    requiredScopes: ["carrot.read"],
    description: cancel
      ? "Cancel a job owned by this connection. Does not undo already committed changes; read the resulting page before retrying."
      : "Read status and result metadata of an owned OCR, erasure or PNG export job. Never returns files or download links. Poll with a few seconds between calls. Job history survives restart for seven days. Use carrot_get_job_file explicitly for completed PNG files.",
    inputSchema: jobIdInputSchema,
    invoke: async (args, context) => {
      const parsed = jobIdSchema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      await operations.ready();
      const owner = principal(context);
      const result = cancel
        ? await operations.cancel(parsed.data.jobId, owner)
        : operations.status(parsed.data.jobId, owner);
      return textContent(result);
    },
  };
}
function createJobFileTool(
  operations: McpOperationService,
  assertFileAvailable: (url: string) => Promise<void>,
): McpTool {
  const scopes = ["carrot.read", "carrot.images"];
  return {
    name: "carrot_get_job_file",
    readOnly: true,
    destructive: false,
    idempotent: true,
    requiredScopes: scopes,
    description:
      "Explicitly retrieve the file link and attachment for an owned, completed PNG export. Rechecks output availability, authorization, page revision and redaction. Expired or changed output requires an explicit new export; this tool never renders or starts a job.",
    inputSchema: jobIdInputSchema,
    invoke: async (args, context) => {
      const parsed = jobIdSchema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      const assertAccess = () => {
        const owner = principal(context);
        if (!context?.assertScopes)
          throw new McpEditError(
            "access_denied",
            "Image scope verification is required.",
          );
        context.assertScopes(scopes);
        return owner;
      };
      const owner = assertAccess();
      await operations.ready();
      const artifact = operations.file(parsed.data.jobId, owner);
      if (
        typeof artifact.url !== "string" ||
        typeof artifact.bytes !== "number"
      )
        throw new McpEditError(
          "not_found",
          "PNG unavailable. Explicitly export the current page again.",
        );
      await assertFileAvailable(artifact.url);
      assertAccess();
      operations.file(parsed.data.jobId, owner);
      return [
        ...textContent({ jobId: parsed.data.jobId, ...artifact }),
        {
          type: "resource_link",
          uri: artifact.url,
          name: "carrot-page.png",
          mimeType: "image/png",
          size: artifact.bytes,
        },
      ];
    },
  };
}
function createStartOperationTool(
  operations: McpOperationService,
  kind: string,
  execute: McpOperationExecutor,
): McpTool {
  const image = kind === "exportPng";
  return {
    name: image
      ? "carrot_export_page_png"
      : kind === "ocr"
        ? "carrot_run_page_ocr"
        : "carrot_run_page_erasure",
    readOnly: image,
    destructive: kind === "erase",
    idempotent: true,
    openWorld: !image,
    requiredScopes: ["carrot.read", image ? "carrot.images" : "carrot.process"],
    description: image
      ? "Export the current saved page as original-resolution PNG with the app renderer. Returns job metadata without attachments or links. Poll carrot_get_job, then explicitly call carrot_get_job_file for the ten-minute single-file download link. Never changes page data or runs OCR/translation."
      : kind === "ocr"
        ? "Run ONLY the app's configured local OCR on one page, saving editable untranslated blocks. Requires an empty page and current revision. No translation, erasure, image generation, or paid-model fallback. Model assets may be downloaded by the existing app. Returns a jobId."
        : "Erase original text for the page's existing non-excluded blocks, or ONLY the optional blockId. Missing/excluded selected IDs fail; selection is retained for retry. Uses the app's configured LOCAL inpainting engine and existing masks. No OCR, translation, Codex or automatic bubble layout. Preserves translation text and styles. Model assets may be downloaded by the existing app. Returns a jobId.",
    inputSchema: {
      type: "object",
      properties: {
        chapterId: identifierSchema,
        pageId: identifierSchema,
        ...(kind === "erase" ? { blockId: identifierSchema } : {}),
        revision: { type: "string", pattern: "^page-v1:[a-f0-9]{16}$" },
        requestId: { type: "string", format: "uuid" },
      },
      required: ["chapterId", "pageId", "revision", "requestId"],
      additionalProperties: false,
    },
    invoke: async (args, context) => {
      const parsed = targetSchema.safeParse(args);
      if (
        !parsed.success ||
        (kind !== "erase" && parsed.data.blockId !== undefined)
      )
        throw new McpInvalidParams();
      readIdentifier(parsed.data.chapterId);
      readIdentifier(parsed.data.pageId);
      await operations.ready();
      const owner = principal(context);
      return textContent(
        await operations.start({
          owner,
          requestId: parsed.data.requestId,
          kind,
          parameters: parsed.data,
          assertAuthorized: () =>
            (context?.assertJobAuthorized ?? context?.assertAuthorized)?.(),
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
