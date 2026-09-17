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

const jobFileSchema = jobIdSchema.extend({
  pageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  includeAttachment: z.boolean().optional(),
});
const jobFileInputSchema = {
  ...jobIdInputSchema,
  properties: {
    ...jobIdInputSchema.properties,
    pageId: {
      ...identifierSchema,
      description: "Required for one PNG from a page batch; omit for a single-page export or ZIP job.",
    },
    includeAttachment: {
      type: "boolean",
      default: false,
      description:
        "Return an MCP file attachment in addition to the text link. The client may require separate approval for attachment creation.",
    },
  },
};

const targetSchema = z
  .object({
    chapterId: z.string(),
    pageId: z.string(),
    contextMode: z.enum(["none", "saved"]).optional(),
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
    blockOcr?: McpOperationExecutor;
    blockTranslation?: McpOperationExecutor;
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
      : "Read status and result metadata of an owned job, including page-batch PNG and ZIP export outcomes. Never returns files or download links. Poll with a few seconds between calls. Job history survives restart for seven days; session files do not. Use carrot_get_job_file explicitly for available files.",
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
      "Retrieve one expiring PNG or ZIP link from an owned, settled export job. A page batch requires an explicit exported pageId; omit pageId for single-page PNG and ZIP jobs. Completed pages of partial/cancelled batches remain individually available while valid. Default: text/metadata only, no attachment creation or download. Set includeAttachment=true only when explicitly requested. Rechecks file availability, authorization, revisions and redaction in both modes. Never renders, packs a ZIP or starts a job. Expiry/restart requires explicit new output.",
    inputSchema: jobFileInputSchema,
    invoke: async (args, context) => {
      const parsed = jobFileSchema.safeParse(args);
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
      const { jobId, pageId } = parsed.data;
      const artifact = operations.file(jobId, owner, pageId);
      const zip = artifact.kind === "rendered-pages-zip";
      const mimeType = zip ? "application/zip" : "image/png";
      if (
        typeof artifact.url !== "string" ||
        typeof artifact.bytes !== "number" ||
        !Number.isSafeInteger(artifact.bytes) ||
        artifact.bytes <= 0 ||
        artifact.mimeType !== mimeType
      )
        throw new McpEditError("not_found", "Completed output metadata is unavailable.");
      await assertFileAvailable(artifact.url);
      assertAccess();
      operations.file(jobId, owner, pageId);
      const content = textContent({ jobId, ...artifact });
      if (!parsed.data.includeAttachment) return content;
      return [
        ...content,
        {
          type: "resource_link",
          uri: artifact.url,
          name: zip ? "carrot-pages.zip" : "carrot-page.png",
          mimeType,
          size: artifact.bytes,
        },
      ];
    },
  };
}
const operationDescriptions: Record<
  string,
  { name: string; description: string }
> = {
  exportPng: {
    name: "carrot_export_page_png",
    description:
      "Export the current saved page as original-resolution PNG with the app renderer. Returns job metadata without attachments or links. Poll carrot_get_job, then explicitly call carrot_get_job_file for the ten-minute single-file download link. Never changes page data or runs OCR/translation.",
  },
  ocr: {
    name: "carrot_run_page_ocr",
    description:
      "Run ONLY the app's configured local OCR on one page, saving editable untranslated blocks. Requires an empty page and current revision. No translation, erasure, image generation, or paid-model fallback. Model assets may be downloaded by the existing app. Returns a jobId.",
  },
  blockOcr: {
    name: "carrot_run_block_ocr",
    description:
      "Observe ONLY one saved block's current source rectangle with the app's local OCR. Uses a fresh original-image crop, not inpainting or page OCR cache. Does NOT save blocks, text, geometry, masks or translations. Poll carrot_get_job for bounded text evidence; observations expire on restart, receipts persist. Compare first; apply sourceText separately with carrot_update_page_blocks using the observation revision. Empty results must not clear existing text. One local model workload at a time; no paid fallback, file attachments or automatic application.",
  },
  blockTranslation: {
    name: "carrot_run_block_translation",
    description:
      "Propose a translation for ONE saved block using the app's configured translation model. No OCR, images, inpainting, typography or page writes. App-managed Gemma/Codex and hosted HTTPS APIs are supported; unmanaged local API servers are rejected. contextMode saved sends bounded saved glossary/rules and earlier-page memory; none sends only this source string. External providers receive that text and may charge. One generation attempt, no key rotation/fallback/automatic application. Poll carrot_get_job; proposals expire on restart. Compare first, then apply separately via carrot_update_translations using the proposal revision; never substitute a newer revision to force stale text. Recheck saved context before applying. No attachments.",
  },
  erase: {
    name: "carrot_run_page_erasure",
    description:
      "Erase original text for the page's existing non-excluded blocks, or ONLY the optional blockId. Missing/excluded selected IDs fail; selection is retained for retry. Uses the app's configured LOCAL inpainting engine and existing masks. No OCR, translation, Codex or automatic bubble layout. Preserves translation text and styles. Model assets may be downloaded by the existing app. Returns a jobId.",
  },
};
function createStartOperationTool(
  operations: McpOperationService,
  kind: string,
  execute: McpOperationExecutor,
): McpTool {
  const spec = operationDescriptions[kind];
  if (!spec) throw new Error("Unknown managed operation kind.");
  const image = kind === "exportPng";
  const block = ["erase", "blockOcr", "blockTranslation"].includes(kind);
  const requiredBlock = ["blockOcr", "blockTranslation"].includes(kind);
  const translation = kind === "blockTranslation";
  const scopes = ["carrot.read", image ? "carrot.images" : "carrot.process"];
  return {
    ...spec,
    readOnly: image,
    destructive: kind === "erase",
    idempotent: true,
    openWorld: !image,
    requiredScopes: scopes,
    inputSchema: {
      type: "object",
      properties: {
        chapterId: identifierSchema,
        pageId: identifierSchema,
        ...(block ? { blockId: identifierSchema } : {}),
        ...(translation
          ? {
              contextMode: {
                type: "string",
                enum: ["none", "saved"],
                default: "saved",
              },
            }
          : {}),
        revision: { type: "string", pattern: "^page-v1:[a-f0-9]{16}$" },
        requestId: { type: "string", format: "uuid" },
      },
      required: [
        "chapterId",
        "pageId",
        "revision",
        "requestId",
        ...(requiredBlock ? ["blockId"] : []),
      ],
      additionalProperties: false,
    },
    invoke: async (args, context) => {
      const target = parseOperationTarget(args, kind);
      await operations.ready();
      const owner = principal(context);
      return textContent(
        await operations.start({
          owner,
          requestId: target.requestId,
          kind,
          parameters: target,
          assertAuthorized: () =>
            (context?.assertJobAuthorized ?? context?.assertAuthorized)?.(
              scopes,
            ),
          execute: (operation) => execute(target, operation),
        }),
      );
    },
  };
}
function parseOperationTarget(args: unknown, kind: string) {
  const parsed = targetSchema.safeParse(args);
  if (!parsed.success) throw new McpInvalidParams();
  const target = parsed.data;
  if (
    (!["erase", "blockOcr", "blockTranslation"].includes(kind) &&
      target.blockId !== undefined) ||
    (["blockOcr", "blockTranslation"].includes(kind) && !target.blockId) ||
    (kind !== "blockTranslation" && target.contextMode !== undefined)
  )
    throw new McpInvalidParams();
  readIdentifier(target.chapterId);
  readIdentifier(target.pageId);
  return kind === "blockTranslation"
    ? { ...target, contextMode: target.contextMode ?? ("saved" as const) }
    : target;
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
