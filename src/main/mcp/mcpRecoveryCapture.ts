import { retainedContextRevision } from "./mcpRetainedContext";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { McpTool } from "./mcpReadTools";
import { withLibraryChapterHistory } from "../libraryStore/libraryChapterHistory";
import {
  readChapterFile,
  type ChapterFile,
} from "../libraryStore/libraryFiles";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import { hydrateChapter } from "../libraryStore/chapterSnapshots";
import { mcpBatchMembership } from "../application/mcpPageBatchPolicy";
import { capturePageRecovery } from "../../shared/pageRecoverySnapshot";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  RetainedChangeSchema,
  MCP_RETENTION_MS,
  type RetainedChange,
} from "./mcpRetentionRecords";
import {
  captureRetainedPage,
  verifyRetainedFiles,
} from "./mcpRetentionEvidence";
import type { McpRetentionStorage } from "./mcpRetentionStorage";

type Invocation = {
  owner: string;
  operation: string;
  requestId: string | null;
  assertAuthorized: () => void;
};
const invocations = new AsyncLocalStorage<Invocation>();
export function currentRetentionInvocation() {
  return invocations.getStore();
}
type Staged = { before: ChapterFile; after: ChapterFile };

/** Background tasks inherit the initiating owner, while existing request/job guards
 * remain authoritative. This records actual commits, not speculative model plans. */
export function wrapRetainedTool(
  storage: McpRetentionStorage,
  tool: McpTool,
): McpTool {
  if (
    (tool.readOnly !== false &&
      ![
        "carrot_export_page_png",
        "carrot_export_pages_png",
        "carrot_export_pages_images",
        "carrot_export_pages_psd",
        "carrot_export_work_file",
        "carrot_export_text_file",
        "carrot_export_context_json",
        "carrot_create_export_zip",
      ].includes(tool.name)) ||
    [
      "carrot_apply_memory_refresh",
      "carrot_apply_context_import",
      "carrot_apply_context_migration",
      "carrot_undo_context_migration",
      "carrot_redo_context_migration",
      "carrot_undo_change",
      "carrot_redo_change",
      "carrot_discard_retained",
      "carrot_get_output_file",
    ].includes(tool.name)
  )
    return tool;
  return {
    ...tool,
    invoke: (args, context) => {
      if (!context?.principalId) return tool.invoke(args, context);
      const invocation = {
        owner: context.principalId,
        operation: tool.name,
        requestId: typeof args?.requestId === "string" ? args.requestId : null,
        assertAuthorized: () => {
          if (context.assertJobAuthorized)
            context.assertJobAuthorized(tool.requiredScopes);
          else context.assertAuthorized();
        },
      };
      const pending = new WeakMap<LibraryTransaction, Staged[]>();
      return invocations.run(invocation, () => {
        // Exports retain ownership, not page-write authority or change snapshots.
        if (tool.readOnly !== false) return tool.invoke(args, context);
        return withLibraryChapterHistory(
          async (transaction, chapter) => {
            let stages = pending.get(transaction);
            if (!stages) {
              stages = [];
              pending.set(transaction, stages);
              const captured = stages;
              transaction.beforePublish(() =>
                retainChanges(storage, transaction, invocation, captured),
              );
            }
            const previous = await readChapterFile(chapter.workId, chapter.id);
            if (previous)
              stages.push({
                before: previous,
                after: structuredClone(chapter),
              });
          },
          () => tool.invoke(args, context),
        );
      });
    },
  };
}
async function retainChanges(
  storage: McpRetentionStorage,
  transaction: LibraryTransaction,
  invocation: Invocation,
  stages: Staged[],
) {
  const changed = changedPages(stages);
  if (!changed.length) return;
  if (
    changed.length > 50 ||
    Buffer.byteLength(
      JSON.stringify(
        changed.map((item) => [
          capturePageRecovery(item.before),
          capturePageRecovery(item.after),
        ]),
      ),
    ) >
      4 * 1024 * 1024
  )
    throw new McpEditError(
      "invalid_edit",
      "Durable recovery supports at most 50 changed pages and 4 MiB of page metadata per native commit. Split the explicit target set.",
    );
  const index = await storage.prune(transaction, await storage.index());
  const id = randomUUID();
  const directory = await storage.create(transaction, id);
  const pages = await captureChangedPages(changed, directory.stagingDirectory);
  const record = RetainedChangeSchema.parse({
    version: 1,
    id,
    owner: invocation.owner,
    pages,
    actions: [],
  });
  let bytes = await storage.writeRecord(directory.stagingDirectory, record);
  const assets = new Map(
    record.pages
      .flatMap((item) => [...item.before.files, ...item.after.files])
      .filter((file) => file.asset)
      .map((file) => [file.asset, file.bytes]),
  );
  bytes += [...assets.values()].reduce((sum, size) => sum + size, 0);
  invocation.assertAuthorized();
  index.entries.push({
    id,
    owner: invocation.owner,
    operation: invocation.operation,
    requestId: invocation.requestId,
    kind: "change",
    createdAt: storage.now(),
    expiresAt: storage.now() + MCP_RETENTION_MS,
    bytes,
    pageCount: pages.length,
    mimeType: null,
    sha256: null,
  });
  await storage.stageIndex(transaction, index);
  transaction.beforePublish(async () => {
    invocation.assertAuthorized();
    for (const item of pages)
      await verifyRetainedFiles([...item.before.files, ...item.after.files]);
    invocation.assertAuthorized();
  });
}

function changedPages(stages: Staged[]) {
  return stages.flatMap((stage) =>
    stage.after.pages.flatMap((page) => {
      const before = stage.before.pages.find(
        (candidate) => candidate.id === page.id,
      );
      return before &&
        hashStableValue(capturePageRecovery(before)) !==
          hashStableValue(capturePageRecovery(page))
        ? [{ stage, before, after: page }]
        : [];
    }),
  );
}
async function captureChangedPages(
  changed: ReturnType<typeof changedPages>,
  directory: string,
): Promise<RetainedChange["pages"]> {
  const copied = new Set<string>();
  const pages: RetainedChange["pages"] = [];
  for (const item of changed) {
    const before = await captureRetainedPage(item.before, directory, copied);
    const after = await captureRetainedPage(item.after, directory, copied);
    if (
      before.page.imagePath !== after.page.imagePath ||
      before.page.width !== after.page.width ||
      before.page.height !== after.page.height ||
      before.files.find((file) => file.path === before.page.imagePath)
        ?.sha256 !==
        after.files.find((file) => file.path === after.page.imagePath)?.sha256
    )
      throw new McpEditError(
        "revision_conflict",
        "MCP recovery cannot replace the original source identity.",
      );
    pages.push({
      workId: item.stage.after.workId,
      chapterId: item.stage.after.id,
      membership: mcpBatchMembership(hydrateChapter(item.stage.after)),
      contextRevision: await retainedContextRevision(item.stage.after.id),
      before,
      after,
    });
  }
  // A path-only replacement is still retained as an exact native commit.
  if (!pages.length)
    throw new McpEditError(
      "invalid_edit",
      "No recoverable page content changed.",
    );
  return pages;
}
