import { createMcpLetteringResources } from "./mcpLetteringResourcesAdapter";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpPageEditService } from "../application/mcpPageEditService";
import {
  applyMcpLetteringSnapshots,
  type LetteringSnapshotRequest,
} from "../application/mcpLetteringPolicy";
import { createMcpPageBatchPorts } from "./mcpTranslationBatchAdapter";
import { readWorkContextForEdit } from "../library";
import { withLibraryRead, retainLibrarySnapshot } from "../library/lock";
import type { AppActivityResource } from "../../shared/appActivityTypes";
import { createMcpLetteringPreparation } from "./mcpLetteringPreparation";
import {
  captureMcpLetteringBinding,
  assertMcpLetteringBinding,
} from "./mcpLetteringEvidence";

export function createMcpLetteringAdapter(
  app: InpaintingJobContext,
  edits: McpPageEditService,
  runtime?: Parameters<typeof createMcpLetteringPreparation>[2],
) {
  const resources = createMcpLetteringResources(app.appPaths);
  return {
    resources,
    prepare: createMcpLetteringPreparation(app, resources, runtime),
    ports: createMcpPageBatchPorts<LetteringSnapshotRequest>(
      (request, membership, guard, committed, scope) =>
        edits.commitSnapshotBatch(
          request,
          membership,
          guard,
          committed,
          (run) =>
            scope(() => withForwardLettering(request, guard, run, resources)),
          applyMcpLetteringSnapshots,
        ),
    ),
  };
}
async function withForwardLettering<T>(
  request: LetteringSnapshotRequest,
  guard: () => void,
  run: () => Promise<T>,
  resources: ReturnType<typeof createMcpLetteringResources>,
): Promise<T> {
  guard();
  if (request.direction === "undo") return run();
  const leases: AppActivityResource[] = [
    {
      kind: "library-structure",
      scope: `chapter:${request.chapterId}`,
      access: "read",
    },
    ...request.dependencies.map((page) => ({
      kind: "page-content" as const,
      scope: `${request.chapterId}/${page.pageId}`,
      access: "read" as const,
    })),
  ];
  const release = await withLibraryRead(async () =>
    retainLibrarySnapshot(leases, []),
  );
  try {
    guard();
    const saved = await readWorkContextForEdit(request.chapterId);
    const pages = request.dependencies.map((page) => ({ ...page, edits: [] }));
    const current = await captureMcpLetteringBinding(
      saved,
      { command: request.command, pages },
      guard,
    );
    assertMcpLetteringBinding(request.binding, current.binding);
    if (request.command.kind === "resource")
      await resources.assertCurrent(request.command, guard);
    guard();
    return await run();
  } finally {
    release();
  }
}
