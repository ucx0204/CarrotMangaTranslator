import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpImageEditRequest } from "../application/mcpImageEditPolicy";
import { assertMcpBatchMembership } from "../application/mcpPageBatchPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { openChapter } from "../library";
import { createMcpPageEditScope } from "./mcpPageEditScope";
import { createMcpPageBatchPorts } from "./mcpTranslationBatchAdapter";
import { prepareMcpImageEdit, readMcpImageEditPage } from "./mcpImageEditEvidence";
import { produceMcpImageEdit, type McpImageEditRuntime, type McpImageProduct } from "./mcpImageEditExecution";
import {
  publishMcpImageEdit, replayMcpImageEdit, discardMcpImageProduct,
  type McpImageHistory,
} from "./mcpImageEditPersistence";
import type { MangaPage } from "../../shared/libraryTypes";
import type { McpImageEditPlanning } from "../application/mcpImageEditPolicy";

type Editing = {
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};
/** The batch service owns receipts; native jobs own leases; native history owns images. */
export function createMcpImageEditAdapter(
  app: InpaintingJobContext, history: McpImageHistory, editing: Editing,
  runtime: McpImageEditRuntime, lifetime: AbortSignal,
) {
  const references = new Set<string>();
  const planning: McpImageEditPlanning = {
    prepare: async (page, input, guard) => {
      const prepared = await prepareMcpImageEdit(page, input.command, guard, lifetime);
      await readMcpImageEditPage(input, guard);
      return prepared.evidence;
    },
  };
  const ports = createMcpPageBatchPorts<McpImageEditRequest>(
    async (request, membership, guard, committed, contextScope) => {
      const erasing = request.direction === "apply" && "expectedEngine" in request.change.command;
      const pageScope = createMcpPageEditScope(app, openChapter, lifetime,
        erasing ? [{ kind: "model-runtime", scope: "*", access: "write" }] : []);
      await pageScope(request, guard, (authorize, signal) => contextScope(async () => {
        await editing.assertWritable(request.chapterId, request.pageId);
        const chapter = await openChapter(request.chapterId);
        authorize();
        assertMcpBatchMembership(chapter, membership);
        const page = await readMcpImageEditPage(request, authorize);
        if (request.direction === "apply") {
          if (references.size >= 64)
            throw new McpEditError("editor_busy", "This session has 64 retained image edits. Existing recovery remains available; no new image was created.");
          await forwardImageEdit(app, history, runtime, request, page,
            authorize, signal, committed, (id) => references.add(id));
        } else {
          await replayMcpImageEdit(history, request, authorize, async (revision) => {
            const updated = await readMcpImageEditPage({ ...request, revision }, () => {});
            committed(updated);
          });
        }
        editing.notifySaved(request.chapterId, request.pageId);
      }));
    },
  );
  return {
    planning, ports,
    close: async () => {
      await history.releaseTransactions([...references]);
      references.clear();
    },
  };
}

async function forwardImageEdit(
  app: InpaintingJobContext, history: McpImageHistory, runtime: McpImageEditRuntime,
  request: McpImageEditRequest, page: MangaPage,
  guard: () => void, signal: AbortSignal, committed: (page: MangaPage) => void,
  remember: (id: string) => void,
) {
  const prepared = await prepareMcpImageEdit(page, request.change.command, guard, signal);
  if (prepared.evidence.mask.snapshot !== request.change.evidence.mask.snapshot)
    throw new McpEditError("revision_conflict", "Reviewed mask or original/cleaned image changed. Prepare a new plan.");
  let product: McpImageProduct | undefined;
  try {
    product = await produceMcpImageEdit(app, page, request.change.command,
      prepared, guard, signal, runtime, (value) => { product = value; });
  } catch (error) {
    if (product) return discardMcpImageProduct(page, product.page, error);
    throw error;
  }
  await publishMcpImageEdit({ history, request, before: page, product,
    mask: prepared.mask, guard, committed, remember });
}
