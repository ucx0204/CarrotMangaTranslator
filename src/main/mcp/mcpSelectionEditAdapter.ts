import type { AppActivityResource } from "../../shared/appActivityTypes";
import type { BlockFormatDefaults } from "../../shared/blockFormat";
import type { McpPageEditService } from "../application/mcpPageEditService";
import type { McpOperationService } from "../application/mcpOperationService";
import type { McpSelectionAnalysisService } from "../application/mcpSelectionAnalysisService";
import type {
  SelectionPlanningPorts,
  SelectionSnapshotRequest,
} from "../application/mcpSelectionEditPolicy";
import { applyMcpSelectionSnapshots } from "../application/mcpSelectionEditSnapshots";
import { McpEditError } from "../application/mcpEditPolicy";
import { retainLibrarySnapshot, withLibraryRead } from "../library/lock";
import { createMcpPageBatchPorts } from "./mcpTranslationBatchAdapter";
import { verifyMcpSelectionEvidence } from "./mcpSelectionEvidence";

export function createMcpSelectionEditAdapter(
  edits: McpPageEditService,
  operations: McpOperationService,
  analyses: McpSelectionAnalysisService,
  defaults: () => Promise<BlockFormatDefaults | undefined>,
) {
  const planning: SelectionPlanningPorts = {
    prepare: async (_saved, input, access) => {
      access.guard();
      if (input.command.kind === "references") return { evidence: null };
      await operations.ready();
      access.guard();
      const id = input.command.analysisId;
      const job = operations.status(id, access.owner);
      if (
        !["selectionOcr", "selectionTranslation"].includes(job.kind) ||
        job.status !== "completed" ||
        job.result?.selectionAnalysis?.analysisId !== id
      )
        throw new McpEditError(
          "not_found",
          "An owned completed selection analysis is required.",
        );
      const evidence = analyses.require(access.owner, id, access.guard);
      if (
        evidence.binding.chapterId !== input.chapterId ||
        evidence.kind !== (job.kind === "selectionOcr" ? "ocr" : "translation")
      )
        throw new McpEditError(
          "invalid_edit",
          "Analysis identity or chapter does not match this request.",
        );
      await verifyMcpSelectionEvidence(evidence.binding, access.guard);
      const format = input.pages.some((page) =>
        page.edits.some((edit) => edit.kind === "append"),
      )
        ? await defaults()
        : undefined;
      access.guard();
      return { evidence, defaults: format };
    },
  };
  const ports = createMcpPageBatchPorts<SelectionSnapshotRequest>(
    (request, membership, guard, committed, scope) => {
      const authorize = () => {
        guard();
        if (
          request.direction !== "undo" &&
          request.evidenceExpiresAt !== null &&
          request.evidenceExpiresAt <= Date.now()
        )
          throw new McpEditError(
            "not_found",
            "Selection evidence expired; prepare a new analysis.",
          );
      };
      return edits.commitSnapshotBatch(
        request,
        membership,
        authorize,
        committed,
        (run) => scope(() => withSelectionEvidence(request, authorize, run)),
        applyMcpSelectionSnapshots,
      );
    },
  );
  return { planning, ports };
}

async function withSelectionEvidence<T>(
  request: SelectionSnapshotRequest,
  guard: () => void,
  run: () => Promise<T>,
): Promise<T> {
  guard();
  // Exact undo needs current ownership/revision, not the old model or expiring observation.
  if (request.direction === "undo") return run();
  const resources: AppActivityResource[] = [
    {
      kind: "library-structure",
      scope: `chapter:${request.chapterId}`,
      access: "read",
    },
    ...request.binding.pages.map((page) => ({
      kind: "page-content" as const,
      scope: `${request.chapterId}/${page.pageId}`,
      access: "read" as const,
    })),
  ];
  // Native page handoff already owns the target. Never acquire these leases in reverse order.
  const release = await withLibraryRead(async () =>
    retainLibrarySnapshot(resources, []),
  );
  try {
    await verifyMcpSelectionEvidence(request.binding, guard);
    guard();
    return await run();
  } finally {
    release();
  }
}
