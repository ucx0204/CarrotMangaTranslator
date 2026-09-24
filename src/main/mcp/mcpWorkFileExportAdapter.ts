import { z } from "zod/v4";
import {
  McpWorkFileExportReviewInputSchema,
  McpWorkFileExportTargetSchema,
} from "../../shared/mcpWorkFileExport";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpWorkFileExportService } from "../application/mcpWorkFileExportService";
import { McpEditError } from "../application/mcpEditPolicy";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { readImageRedactionState } from "../imageRedactionStore";
import type { McpArtifactStore } from "./mcpArtifactStore";
import { McpInvalidParams } from "./mcpArguments";
import { createMcpBatchTool } from "./mcpBatchTool";
import { runMcpAppJob } from "./mcpAppJob";
import { textContent, type McpTool } from "./mcpReadTools";
import {
  readMcpWorkFileExportState,
  checkMcpWorkFileExportBinding,
  writeMcpWorkFileExport,
} from "./mcpWorkFileExportSource";

const scopes = ["carrot.read", "carrot.images"];

type Options = {
  app: InpaintingJobContext;
  operations: McpOperationService;
  artifacts: McpArtifactStore;
  allowImages: boolean;
};

export function createMcpWorkFileExportAdapter(options: Options) {
  const service = createService(options.artifacts);
  const tools = [createPreflightTool(service)];
  if (options.allowImages) tools.push(createExportTool(options, service));
  return { tools };
}

function createService(artifacts: McpArtifactStore) {
  return new McpWorkFileExportService({
    read: readMcpWorkFileExportState,
    check: checkMcpWorkFileExportBinding,
    write: writeMcpWorkFileExport,
    store: artifacts.putWorkFile.bind(artifacts),
    assertImageAccess: async () => {
      if ((await readImageRedactionState()).enabled)
        throw new McpEditError(
          "access_denied",
          "Working-file output contains originals and is blocked by image redaction review.",
        );
    },
  });
}

function createPreflightTool(service: McpWorkFileExportService): McpTool {
  return {
    ...createMcpBatchTool({
      name: "carrot_preflight_work_file_export",
      schema: McpWorkFileExportReviewInputSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Review 1-10 explicitly selected complete chapters in ONE existing work for native editable .mgtshare v1 output, totaling 1-50 pages. Returns native chapter order, page revisions, metadata snapshot AND sourceSnapshot, counts and v1 omissions. Includes the work style guide and original/stored processed images, editable blocks and supported formatting. No rendering, library change, picker, file transfer or model. V1 excludes chapter memory files, local masks, jobs, undo history, internal checkpoints/font continuity and profile settings; fonts are not bundled. Saved state only. Selection is not reserved; exact archive bytes are checked by the native writer. Preserve both snapshots and returned chapterIds for carrot_export_work_file.",
      execute: (args, _owner, guard) =>
        service.preflight(
          McpWorkFileExportReviewInputSchema.parse(args),
          guard,
        ),
    }),
    openWorld: false,
  };
}

function createExportTool(
  options: Options,
  service: McpWorkFileExportService,
): McpTool {
  return {
    name: "carrot_export_work_file",
    description:
      "Export the reviewed complete chapters to ONE editable .mgtshare v1 file through the native streaming share writer. Use unchanged metadata snapshot, sourceSnapshot and chapterIds in the preflight's native order; acknowledgeOriginalImages=true and acknowledgeV1Limitations=true are required. Preserves editable blocks, supported formatting/reading order, original and stored processed images, work style guide. V1 does NOT contain local masks, chapter memory files, jobs, undo history, internal checkpoints/font continuity or a complete profile backup; no fonts bundled. Maximum 10 chapters/50 pages/2,000 entries, 128 MiB output, 256 MiB expanded/session; reserves 128 MiB until actual size is known. Writer aborts at limits with no truncation or format substitution. No renderer, OCR, translation, erasure, model or source edits. Poll carrot_get_job for metadata, explicitly call carrot_get_job_file without pageId for a link or requested attachment. Retained reissue is separate and never repackages. Ownership, source, metadata/guide and redaction remain checked; delivery is not client receipt.",
    oauth: true,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    requiredScopes: scopes,
    inputSchema: z.toJSONSchema(McpWorkFileExportTargetSchema),
    invoke: async (args, context) => {
      const parsed = McpWorkFileExportTargetSchema.safeParse(args);
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
      const guard = () => assertJobAuthorized(scopes);
      await options.operations.ready();
      return textContent(
        await options.operations.start({
          owner,
          requestId: parsed.data.requestId,
          kind: "workFileExport",
          parameters: parsed.data,
          assertAuthorized: guard,
          execute: (job) =>
            runMcpAppJob(
              options.app,
              job,
              "page-export",
              (native) => service.run(parsed.data, native, guard),
              { resources: [] },
            ),
        }),
      );
    },
  };
}
