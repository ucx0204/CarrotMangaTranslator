import { McpPageEditService } from "../application/mcpPageEditService";
import { applyMcpExternalLettering, type ExternalImagePlanning, type ExternalImageRequest } from "../application/mcpExternalImagePolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { openChapter, savePageBlocks } from "../library";
import { createMcpPageEditScope } from "./mcpPageEditScope";
import { createMcpPageBatchPorts } from "./mcpTranslationBatchAdapter";
import { verifyMcpImageFiles } from "./mcpImageEditEvidence";
import type { McpImageUploadStore } from "./mcpImageUploadStore";
import { withExternalImageAssets } from "./mcpExternalImageAssets";
import { prepareMcpExternalImage } from "./mcpExternalImagePreparation";

export function createMcpExternalImageAdapter(
  app: InpaintingJobContext,
  editing: { assertWritable: (chapterId: string, pageId: string) => Promise<void>; notifySaved: (chapterId: string, pageId: string) => void },
  uploads: McpImageUploadStore,
  lifetime: AbortSignal,
) {
  const edits = new McpPageEditService({ openChapter, savePageBlocks, ...editing,
    withPageEdit: createMcpPageEditScope(app, openChapter, lifetime),
  });
  const planning: ExternalImagePlanning = (page, input, owner, guard) =>
    withExternalImageAssets(uploads, owner, input, guard, async (assets) => {
      const { change } = await prepareMcpExternalImage(page, input, assets);
      if (input.command.kind !== "lettering") {
        change.changed = false;
        change.excludedReason = "background_application_not_connected";
        change.warnings.push("background_preview_only_no_apply_or_image_history_claim");
      }
      return change;
    });
  const ports = createMcpPageBatchPorts<ExternalImageRequest>((request, membership, guard, committed, scope) => {
    if (request.input.command.kind !== "lettering")
      throw new McpEditError("invalid_edit", "Background candidates can be inspected, but background publication is not connected yet.");
    let evidenceGuard = guard;
    const authorize = () => evidenceGuard();
    return edits.commitSnapshotBatch(request, membership, authorize, committed,
      (run) => scope(async () => {
        await verifyMcpImageFiles(request.change.evidence.files, guard);
        if (request.direction !== "apply") return run();
        return withExternalImageAssets(uploads, request.owner, request.input, guard, async (assets) => {
          const page = await edits.readStructurePage(request);
          const current = await prepareMcpExternalImage(page, request.input, assets);
          if (current.change.stats.snapshot !== request.change.stats.snapshot)
            throw new McpEditError("revision_conflict", "Reviewed external image changed before application.");
          evidenceGuard = assets.guard;
          authorize();
          return run();
        });
      }), applyMcpExternalLettering);
  });
  return { planning, ports };
}
