import { expect, it } from "vitest";
import { translationBatchFixture } from "./mcpTranslationBatch.fixture";
import { applyMcpSelectionSnapshots } from "../src/main/application/mcpSelectionEditSnapshots";
import type { SelectionSnapshotRequest } from "../src/main/application/mcpSelectionEditPolicy";
import { createPageRevision } from "../src/shared/pageRevision";
import { resolvePageBlockOrder } from "../src/shared/blockReadingOrder";
import { mcpBatchMembership } from "../src/main/application/mcpPageBatchPolicy";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";

function fixture() {
  const f = translationBatchFixture();
  const page = f.chapter.pages[0];
  const before = structuredClone(page.blocks[0]);
  const after = {
    ...structuredClone(before),
    translatedText: "new translation",
  };
  const request: SelectionSnapshotRequest = {
    chapterId: f.chapter.id,
    pageId: page.id,
    revision: createPageRevision(page),
    direction: "apply",
    expectedOrder: page.blockOrder,
    blockOrder: page.blockOrder,
    evidenceExpiresAt: null,
    binding: {
      chapterId: f.chapter.id,
      contextRevision: mcpContextRevision(f.saved),
      membership: mcpBatchMembership(f.chapter),
      pages: [{ pageId: page.id, revision: createPageRevision(page) }],
    },
    changes: [
      {
        pageId: page.id,
        blockId: before.id,
        reason: "Selected translation",
        requested: {
          kind: "translation",
          itemId: "owned-item",
          reason: "Selected translation",
        },
        before: {
          sourceText: before.sourceText,
          translatedText: before.translatedText,
        },
        after: {
          sourceText: after.sourceText,
          translatedText: after.translatedText,
        },
        beforeBlock: before,
        afterBlock: after,
        sourceRect: null,
        overlapBlockIds: [],
        excludedReason: null,
        changed: true,
        warnings: [],
      },
    ],
  };
  return { ...f, page, before, after, request };
}

it("permits only the exact selected field and rejects hidden geometry style identity or absent snapshot mutations", () => {
  const f = fixture();
  expect(applyMcpSelectionSnapshots(f.page, f.request).blocks[0]).toEqual(
    f.after,
  );
  for (const mutate of [
    (r: SelectionSnapshotRequest) => {
      if (r.changes[0].afterBlock) r.changes[0].afterBlock.fontSizePx += 1;
    },
    (r: SelectionSnapshotRequest) => {
      if (r.changes[0].afterBlock) r.changes[0].afterBlock.id = "different";
    },
    (r: SelectionSnapshotRequest) => {
      r.changes[0].beforeBlock = null;
    },
    (r: SelectionSnapshotRequest) => {
      r.changes[0].afterBlock = null;
    },
    (r: SelectionSnapshotRequest) => {
      r.changes[0].excludedReason = "excluded";
    },
    (r: SelectionSnapshotRequest) => {
      r.changes.push(r.changes[0]);
    },
    (r: SelectionSnapshotRequest) => {
      r.changes = [];
    },
  ]) {
    const request = structuredClone(f.request);
    mutate(request);
    expect(() => applyMcpSelectionSnapshots(f.page, request)).toThrow();
  }
  expect(f.page.blocks[0]).toEqual(f.before);
});

it("refuses later changes and unrelated reading-order edits without mutating the input", () => {
  const f = fixture();
  const changed = structuredClone(f.page);
  changed.blocks[0].translatedText = "user changed";
  expect(() => applyMcpSelectionSnapshots(changed, f.request)).toThrow(
    /changed/i,
  );
  const order = {
    ...f.request,
    blockOrder: [...resolvePageBlockOrder(f.page)].reverse(),
  };
  expect(() => applyMcpSelectionSnapshots(f.page, order)).toThrow(/reorder/i);
  expect(() =>
    applyMcpSelectionSnapshots(f.page, {
      ...f.request,
      expectedOrder: ["unknown"],
    }),
  ).toThrow(/order/i);
  expect(changed.blocks[0].translatedText).toBe("user changed");
});

it("requires complete new append order but restores an existing legacy partial order exactly on undo", () => {
  const f = fixture();
  f.page.blockOrder = ["b"];
  const request = structuredClone(f.request);
  const change = request.changes[0];
  change.beforeBlock = null;
  change.blockId = "new-owned";
  change.afterBlock = { ...f.after, id: change.blockId };
  change.requested = {
    kind: "append",
    itemId: "region",
    sequence: 0,
    allowOverlap: true,
    reason: "Reviewed discovery",
  };
  request.expectedOrder = ["b"];
  request.blockOrder = ["b", "a", change.blockId];
  const after = applyMcpSelectionSnapshots(f.page, request);
  expect(after.blocks).toHaveLength(f.page.blocks.length + 1);
  expect(() =>
    applyMcpSelectionSnapshots(f.page, {
      ...request,
      blockOrder: ["b", change.blockId],
    }),
  ).toThrow(/order/i);
  const restored = applyMcpSelectionSnapshots(
    { ...f.page, ...after },
    {
      ...request,
      direction: "undo",
      expectedOrder: request.blockOrder,
      blockOrder: ["b"],
    },
  );
  expect(restored).toEqual({ blocks: f.page.blocks, blockOrder: ["b"] });
  const edited = {
    ...f.page,
    ...after,
    blocks: after.blocks.map((block) =>
      block.id === change.blockId ? { ...block, sourceText: "later" } : block,
    ),
  };
  expect(() =>
    applyMcpSelectionSnapshots(edited, {
      ...request,
      direction: "undo",
      expectedOrder: request.blockOrder,
      blockOrder: ["b"],
    }),
  ).toThrow(/changed/i);
});

it("commits an order-only calculated snapshot while leaving all blocks unchanged and preserves array-only callers", async () => {
  const f = fixture();
  const target = {
    chapterId: f.chapter.id,
    pageId: f.page.id,
    revision: createPageRevision(f.page),
  };
  const before = structuredClone(f.page.blocks);
  const order = [...resolvePageBlockOrder(f.page)].reverse();
  await f.edits.commitSnapshotBatch(
    target,
    mcpBatchMembership(f.chapter),
    f.guard,
    () => {},
    async (run) => run(),
    (page) => ({ blocks: page.blocks, blockOrder: order }),
  );
  expect(f.page.blockOrder).toEqual(order);
  expect(f.page.blocks).toEqual(before);
  expect(f.save).toHaveBeenCalledOnce();
  await f.edits.commitSnapshotBatch(
    { ...target, revision: createPageRevision(f.page) },
    mcpBatchMembership(f.chapter),
    f.guard,
    () => {},
    async (run) => run(),
    (page) => page.blocks,
  );
  expect(f.save).toHaveBeenCalledOnce();
});
