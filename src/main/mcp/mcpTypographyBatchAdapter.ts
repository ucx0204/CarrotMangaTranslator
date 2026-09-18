import type { AppActivityResource } from "../../shared/appActivityTypes";
import { McpTypographyAnalysisObservationSchema } from "../../shared/mcpTypographyAnalysis";
import type { McpPageEditService } from "../application/mcpPageEditService";
import type { McpOperationService } from "../application/mcpOperationService";
import {
  assertTypographyEvidence,
  type TypographyPlanningPorts,
  type TypographySnapshotRequest,
} from "../application/mcpTypographyBatchPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { readWorkContextForEdit } from "../library";
import { retainLibrarySnapshot, withLibraryRead } from "../library/lock";
import { createMcpPageBatchPorts } from "./mcpTranslationBatchAdapter";
import { verifyMcpTypographySourceEvidence } from "./mcpTypographySourceEvidence";
import { projectMcpTypographyApplication } from "./mcpTypographyApplyProjection";

/** The job store is the only observation authority; callers submit IDs, not evidence. */
export function createMcpTypographyBatchAdapter(
  edits: McpPageEditService,
  operations: McpOperationService,
) {
  const planning: TypographyPlanningPorts = {
    prepare: async (saved, input, access) => {
      access.guard();
      await operations.ready();
      access.guard();
      const job = operations.status(input.analysisJobId, access.owner);
      if (
        job.kind !== "typographyAnalysis" ||
        job.status !== "completed" ||
        job.target?.chapterId !== input.chapterId ||
        !job.result?.typographyAnalysis
      )
        throw new McpEditError(
          "not_found",
          "A completed, unexpired typography analysis owned by this connection is required.",
        );
      const observation = McpTypographyAnalysisObservationSchema.parse(
        job.result.typographyAnalysis,
      );
      const dependencies = observation.pages.map(({ pageId, revision }) => ({
        pageId,
        revision,
      }));
      const environment = await verifyMcpTypographySourceEvidence(
        saved,
        observation,
        dependencies,
        access.guard,
      );
      const current = await readWorkContextForEdit(input.chapterId);
      access.guard();
      assertTypographyEvidence(current, observation);
      return {
        observation,
        project: (page, block, evidence, selection) =>
          projectMcpTypographyApplication(
            page,
            block,
            evidence,
            selection,
            input.preserveManualFontSize,
            { workId: saved.workId, chapterId: input.chapterId },
            environment,
          ),
      };
    },
  };
  const ports = createMcpPageBatchPorts<TypographySnapshotRequest>(
    (request, membership, guard, committed, scope) =>
      edits.commitTypographyBatch(
        request,
        membership,
        guard,
        committed,
        (run) => scope(() => withForwardEvidence(request, guard, run)),
      ),
  );
  return { planning, ports };
}

async function withForwardEvidence<T>(
  request: TypographySnapshotRequest,
  guard: () => void,
  run: () => Promise<T>,
): Promise<T> {
  guard();
  // Undo restores the exact owned snapshot even after observation expiry or font removal.
  // The shared page transaction still checks current revision, membership and authority.
  if (request.direction === "undo") return run();
  const resources: AppActivityResource[] = [
    { kind: "library-structure", scope: `chapter:${request.chapterId}`, access: "read" },
    ...request.dependencies.map((page) => ({
      kind: "page-content" as const,
      scope: `${request.chapterId}/${page.pageId}`,
      access: "read" as const,
    })),
  ];
  // This nonwaiting lease is acquired AFTER native page handoff, never in reverse order.
  const release = await withLibraryRead(async () => retainLibrarySnapshot(resources, []));
  try {
    guard();
    const saved = await readWorkContextForEdit(request.chapterId);
    guard();
    await verifyMcpTypographySourceEvidence(
      saved,
      request.observation,
      request.dependencies,
      guard,
    );
    guard();
    return await run();
  } finally {
    release();
  }
}
