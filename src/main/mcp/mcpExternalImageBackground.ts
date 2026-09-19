import type { MangaPage } from "../../shared/libraryTypes";
import type { ExternalImageRequest } from "../application/mcpExternalImagePolicy";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { McpEditError } from "../application/mcpEditPolicy";
import { assertMcpBatchMembership } from "../application/mcpPageBatchPolicy";
import { openChapter } from "../library";
import { createMcpPageEditScope } from "./mcpPageEditScope";
import { readMcpImageEditPage } from "./mcpImageEditEvidence";
import { withExternalImageAssets } from "./mcpExternalImageAssets";
import { prepareMcpExternalImage } from "./mcpExternalImagePreparation";
import { stageMcpExternalBackground } from "./mcpExternalImageArtifact";
import {
  publishMcpImageEdit,
  replayMcpImageEdit,
  type McpImageHistory,
} from "./mcpImageEditPersistence";
import type { McpImageUploadStore } from "./mcpImageUploadStore";

type Editing = {
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};
type ContextScope = <T>(run: () => Promise<T>) => Promise<T>;

export function createMcpExternalBackgroundAdapter(
  app: InpaintingJobContext,
  editing: Editing,
  uploads: McpImageUploadStore,
  lifetime: AbortSignal,
) {
  const references = new Set<string>();
  const pageScope = createMcpPageEditScope(app, openChapter, lifetime);
  const requireHistory = (): McpImageHistory => {
    const history = app.inpaintingRevisionStore;
    if (!history?.inspectSinglePageTransaction || !history.applySinglePageTransaction || !history.releaseTransactions)
      throw new McpEditError("invalid_edit", "Native image recovery is unavailable; no external background can be saved.");
    return history as McpImageHistory;
  };
  return {
    assertAvailable: () => { requireHistory(); },
    save: async (
      request: ExternalImageRequest,
      membership: string,
      guard: () => void,
      committed: (page: MangaPage) => void,
      contextScope: ContextScope,
    ) => {
      const history = requireHistory();
      await pageScope(request, guard, (authorize) => contextScope(async () => {
        await editing.assertWritable(request.chapterId, request.pageId);
        const chapter = await openChapter(request.chapterId);
        authorize();
        assertMcpBatchMembership(chapter, membership);
        const page = await readMcpImageEditPage(request, authorize);
        if (request.direction === "apply") {
          if (references.size >= 64)
            throw new McpEditError("editor_busy", "This session retains 64 external image edits; existing recovery remains available.");
          await withExternalImageAssets(uploads, request.owner, request.input, authorize, async (assets) => {
            const prepared = await prepareMcpExternalImage(page, request.input, assets);
            if (prepared.change.stats.snapshot !== request.change.stats.snapshot)
              throw new McpEditError("revision_conflict", "Reviewed external background changed before application.");
            const next = await stageMcpExternalBackground(page, prepared.pixels.bytes, assets.guard);
            await publishMcpImageEdit({
              history, request, before: page,
              product: { page: next, componentsChanged: 1, componentsIncomplete: 0 },
              mask: prepared.pixels.mask, guard: assets.guard, committed,
              remember: (id) => references.add(id),
            });
          });
        } else {
          await replayMcpImageEdit(history, request, authorize, async (revision) => {
            committed(await readMcpImageEditPage({ ...request, revision }, () => {}));
          });
        }
        editing.notifySaved(request.chapterId, request.pageId);
      }));
    },
    close: async () => {
      if (!references.size) return;
      await requireHistory().releaseTransactions([...references]);
      references.clear();
    },
  };
}
