import { z } from "zod/v4";
import {
  McpExportPreflightInput,
  McpExportPagesTargetSchema,
  McpExportZipTargetSchema,
  McpBatchRasterExportOptionsSchema,
} from "../../shared/mcpExportBatch";
import { McpPsdExportOptionsSchema } from "../../shared/mcpOutputFormats";
import type {
  McpExportBatchService,
  McpExportSource,
} from "../application/mcpExportBatchService";
import type {
  McpOperationService,
  McpOperationContext,
} from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import { McpInvalidParams } from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

const scopes = ["carrot.read", "carrot.images"];
export function createMcpExportBatchTools(
  service: McpExportBatchService,
  operations: McpOperationService,
  allowImages: boolean,
  resolveSource?: (
    owner: string,
    sourceJobId: string,
    guard: () => void,
  ) => Promise<McpExportSource>,
): McpTool[] {
  const tools: McpTool[] = [preflightTool(service)];
  if (!allowImages) return tools;
  tools.push(
    actionTool(
      operations,
      McpExportPagesTargetSchema.omit({ imageExport: true }),
      "exportPages",
      "carrot_export_pages_png",
      "Export 1-50 explicitly selected saved pages in ONE chapter, sequentially through the existing app renderer at original resolution. Read carrot_preflight_pages_export WITHOUT imageExport first and retain its snapshot and pageId/revision pairs in chapter order. No OCR, translation, erasure or data edits. Stops on first failure/conflict/cancellation; inspect completed/failed/unprocessed pages using carrot_get_job. Receipts never attach files. Get each file explicitly with carrot_get_job_file(jobId,pageId), or create a ZIP separately. Session links expire; retained output IDs permit a separately checked reissue without rendering. Failed/unprocessed pages require fresh preflight, not a forced revision retry.",
      (target, job, _owner, retained) => service.run(target, job, retained),
    ),
    actionTool(
      operations,
      McpExportPagesTargetSchema.extend({
        imageExport: McpBatchRasterExportOptionsSchema,
      }),
      "exportPages",
      "carrot_export_pages_images",
      "Export 1-50 saved pages from ONE chapter as explicit PNG/JPEG/WebP or a reviewed per-page source policy using native original-resolution capture. Source mode uses saved sourceFileName or page name: PNG/JPG/JPEG/WebP keep their codec; unsupported suffixes require the preflighted unsupportedSource=png fallback, or reject. Both jpegQuality and webpQuality must be explicit 1-100. Names, resolved options and fallback decisions stay bound to preflight, retained access and ZIP. No source bytes are passed through. Use the SAME imageExport options and snapshot from carrot_preflight_pages_export. JPEG/WebP require integer quality 1-100; PNG forbids quality. omitText=true requires existing inpainting and omits ALL text/generated-lettering overlays without changing saved blocks or running erasure. No original-image fallback for missing inpainting, format substitution, downscaling, OCR, translation or model. Stops at first failure with partial outcomes. Polling is metadata-only. Fetch a selected page using carrot_get_job_file, pack its valid images with carrot_create_export_zip, or inspect/reissue each retainedOutputId after restart. No automatic attachment.",
      (target, job, _owner, retained) => service.run(target, job, retained),
    ),
    actionTool(
      operations,
      McpExportPagesTargetSchema.extend({
        imageExport: McpPsdExportOptionsSchema,
      }),
      "exportPages",
      "carrot_export_pages_psd",
      "Export 1-50 reviewed saved pages from ONE chapter to original-resolution layered PSD using the existing native PSD writer. Use the SAME imageExport={format:psd,acknowledgeOriginalLayer:true,acknowledgeRasterLayers:true} and snapshot/page revisions from preflight. PSD INCLUDES the ORIGINAL background, optional stored cleaned background, composite and native text/block layers. Supported simple text is editable; unsupported effects/vertical/rich text/generated lettering stay faithfully rasterized layers, not invented editable text. Fonts are not bundled. No clean-only PSD, quality option, flattening substitute, downscale, OCR, erasure, model or source edits. Per-page admission: 200 blocks, 30,000-pixel sides and estimated 256-MiB decoded layers; output 64 MiB. Not a profile/history/mask backup. Stops on first failure with partial status. File retrieval and ZIP are separate explicit calls; retained reissue never rerenders. Existing permission, source and redaction guards remain.",
      (target, job, _owner, retained) => service.run(target, job, retained),
    ),
    actionTool(
      operations,
      McpExportZipTargetSchema,
      "exportZip",
      "carrot_create_export_zip",
      "Package files from one owned settled page-export job with the existing streaming ZIP writer, without rendering or model calls. Supports PNG/JPEG/WebP and layered PSD. Preserves numbered order/extensions and metadata-only options/omissions. Incomplete/cancelled source jobs require explicit allowPartial=true. Sources must remain available with matching revisions, order and options. Poll carrot_get_job, then explicitly request carrot_get_job_file; attachment is optional. Limits: file 64 MiB, ZIP 128 MiB, session 256 MiB; no downscaling. Expired session links may be borrowed from the exact owned retained page bytes after all source/options checks; never regenerate missing files.",
      async (target, job, owner, retained) =>
        service.zip(
          target,
          resolveSource
            ? await resolveSource(owner, target.sourceJobId, retained)
            : operations.exportSource(target.sourceJobId, owner),
          job,
          retained,
        ),
    ),
  );
  return tools;
}
function preflightTool(service: McpExportBatchService): McpTool {
  return {
    name: "carrot_preflight_pages_export",
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    requiredScopes: ["carrot.read"],
    inputSchema: z.toJSONSchema(McpExportPreflightInput),
    description:
      "Inspect ONE chapter or 1-50 selected saved pages for export. Default is the old PNG plan. imageExport selects png/jpeg/webp, source or psd. Source requires explicit jpegQuality and webpQuality (1-100) plus unsupportedSource=png|reject; omitText defaults to false. It resolves each saved source name to a concrete PNG/JPEG/WebP option and reports the fallback; it is rendered output, not original-byte passthrough. JPEG/WebP require quality 1-100; PNG/PSD forbid quality. PSD requires acknowledgeOriginalLayer=true and acknowledgeRasterLayers=true: the original background is INCLUDED and unsupported typography remains a raster layer. Returns option-bound snapshot, page revisions, numbered names and native warnings. No rendering, model, image transfer or writes. Preflight does not reserve execution or guarantee file/renderer/budget success. Keep SAME options/snapshot/page revisions: use carrot_export_pages_psd for PSD, carrot_export_pages_images for explicit raster or source options, otherwise carrot_export_pages_png.",
    invoke: async (args, context) => {
      const parsed = McpExportPreflightInput.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      return textContent(
        await service.preflight(parsed.data, () => context?.assertAuthorized()),
      );
    },
  };
}
function actionTool<S extends z.ZodType>(
  operations: McpOperationService,
  schema: S,
  kind: string,
  name: string,
  description: string,
  execute: (
    target: z.output<S>,
    job: McpOperationContext,
    owner: string,
    retained: () => void,
  ) => Promise<Record<string, unknown>>,
): McpTool {
  return {
    name,
    description,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    requiredScopes: scopes,
    inputSchema: z.toJSONSchema(schema),
    invoke: async (args, context) => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      if (
        !context?.principalId ||
        !context.assertScopes ||
        !context.assertJobAuthorized
      )
        throw new McpEditError(
          "access_denied",
          "An approved image-transfer connection is required.",
        );
      context.assertAuthorized();
      context.assertScopes(scopes);
      const owner = context.principalId;
      const assertJobAuthorized = context.assertJobAuthorized;
      const retained = () => assertJobAuthorized(scopes);
      await operations.ready();
      return textContent(
        await operations.start({
          owner,
          requestId: (parsed.data as { requestId: string }).requestId,
          kind,
          parameters: parsed.data,
          assertAuthorized: retained,
          execute: (job) => execute(parsed.data, job, owner, retained),
        }),
      );
    },
  };
}
