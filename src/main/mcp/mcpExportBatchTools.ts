import { z } from "zod/v4";
import {
  McpExportPreflightInput,
  McpExportPagesTargetSchema,
  McpExportZipTargetSchema,
} from "../../shared/mcpExportBatch";
import type { McpExportBatchService } from "../application/mcpExportBatchService";
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
): McpTool[] {
  const tools: McpTool[] = [
    {
      name: "carrot_preflight_pages_export",
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
      requiredScopes: ["carrot.read"],
      inputSchema: z.toJSONSchema(McpExportPreflightInput),
      description:
        "Inspect ONE chapter or 1-50 selected saved pages for PNG export. Returns fixed chapter order, snapshot, page revisions, filenames and existing app export warnings. No images, rendering, model calls or writes. Omitted pageIds selects the whole chapter only when it fits the limit; no silent truncation. Warnings are not quality judgments or permission to run erasure. Use snapshot and explicit pageId/revision pairs for carrot_export_pages_png.",
      invoke: async (args, context) => {
        const parsed = McpExportPreflightInput.safeParse(args);
        if (!parsed.success) throw new McpInvalidParams();
        return textContent(
          await service.preflight(parsed.data, () =>
            context?.assertAuthorized(),
          ),
        );
      },
    },
  ];
  if (!allowImages) return tools;
  tools.push(
    actionTool(
      operations,
      McpExportPagesTargetSchema,
      "exportPages",
      "carrot_export_pages_png",
      "Export 1-50 explicitly selected saved pages in ONE chapter, sequentially through the existing app renderer at original resolution. Read carrot_preflight_pages_export first and retain its snapshot and pageId/revision pairs in chapter order. No OCR, translation, erasure or data edits. Stops on first failure/conflict/cancellation; inspect completed/failed/unprocessed pages using carrot_get_job. A receipt is NOT completion and never attaches files. Get each exported file explicitly with carrot_get_job_file(jobId,pageId), or create a ZIP separately. Session files expire; durable receipts do not restore files. Failed/unprocessed pages need a new preflight, not a forced revision retry.",
      (target, job, _owner, retained) => service.run(target, job, retained),
    ),
    actionTool(
      operations,
      McpExportZipTargetSchema,
      "exportZip",
      "carrot_create_export_zip",
      "Package PNGs from one owned, settled carrot_export_pages_png job using the app's streaming ZIP writer. Never rerenders or runs models. Preserves chapter order and includes a metadata-only manifest listing omissions. Incomplete/cancelled source jobs require explicit allowPartial=true; inspect first. Sources must still be available with matching page revisions and chapter order. Poll carrot_get_job, then explicitly request carrot_get_job_file for a text download link (attachment optional). A ZIP failure can be retried with a new requestId without rerendering valid PNGs. Limits: PNG 64 MiB, ZIP 128 MiB, total session outputs 256 MiB; no downscaling. Links expire after ten minutes or stop/revocation/content changes.",
      (target, job, owner, retained) =>
        service.zip(
          target,
          operations.exportSource(target.sourceJobId, owner),
          job,
          retained,
        ),
    ),
  );
  return tools;
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
