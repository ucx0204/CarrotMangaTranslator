import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { translationBatchFixture } from "./mcpTranslationBatch.fixture";
import {
  McpSelectionAnalysisService,
  assertMcpSelectionFreshness,
  validateMcpSelection,
} from "../src/main/application/mcpSelectionAnalysisService";
import { mcpBatchMembership } from "../src/main/application/mcpPageBatchPolicy";
import {
  McpSelectionOcrSchema,
  McpSelectionTranslationSchema,
  type McpSelectionAnalysisItem,
} from "../src/shared/mcpSelectionAnalysis";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";

function fixture() {
  const f = translationBatchFixture();
  let now = 1000;
  const input = McpSelectionTranslationSchema.parse({
    chapterId: f.chapter.id,
    contextRevision: mcpContextRevision(f.saved),
    requestId: randomUUID(),
    expectedEngine: "openai-api",
    allowExternal: true,
    pages: f.chapter.pages.map((page) => ({
      pageId: page.id,
      revision: createPageRevision(page),
      blockIds: [page.blocks[0].id],
    })),
  });
  const binding = {
    chapterId: input.chapterId,
    contextRevision: input.contextRevision,
    membership: mcpBatchMembership(f.chapter),
    pages: input.pages.map(({ pageId, revision }) => ({ pageId, revision })),
  };
  const items: McpSelectionAnalysisItem[] = input.pages.map((page, i) => ({
    itemId: `item-${i}`,
    pageId: page.pageId,
    revision: page.revision,
    blockId: page.blockIds[0],
    regionId: null,
    excludedReason: "existing_translation_preserved",
    engine: null,
    ocr: null,
    translation: null,
    overlaps: [],
  }));
  const analyze = vi.fn(async () => ({
    binding: structuredClone(binding),
    items: structuredClone(items),
  }));
  const verify = vi.fn(async (value: typeof binding, guard: () => void) => {
    guard();
    assertMcpSelectionFreshness(f.saved, value);
  });
  const service = new McpSelectionAnalysisService(
    { read: f.read, analyze, verify },
    () => now,
  );
  const operation = () => ({
    id: randomUUID(),
    signal: new AbortController().signal,
    assertAuthorized: f.guard,
    progress: vi.fn(),
  });
  return {
    ...f,
    input,
    binding,
    items,
    analyze,
    verify,
    service,
    operation,
    advance: (ms: number) => {
      now += ms;
    },
    close: async () => {
      service.close();
      await f.service.close();
    },
  };
}

it("isolates owners and returned objects and expires evidence without extending it on reads", async () => {
  const f = fixture();
  try {
    const operation = f.operation();
    const result = await f.service.run(f.owner, f.input, operation);
    expect(result.performed).toEqual([]);
    expect(f.save).not.toHaveBeenCalled();
    const first = f.service.get(
      f.owner,
      { analysisId: operation.id, limit: 1 },
      f.guard,
    );
    expect(first.nextOffset).toBe(1);
    first.items[0].excludedReason = "tampered";
    expect(
      f.service.get(f.owner, { analysisId: operation.id }, f.guard).items[0]
        .excludedReason,
    ).toBe("existing_translation_preserved");
    expect(() =>
      f.service.get("other", { analysisId: operation.id }, f.guard),
    ).toThrow();
    f.advance(30 * 60000 - 1);
    expect(
      f.service.get(f.owner, { analysisId: operation.id }, f.guard).expiresAt,
    ).toBe(result.selectionAnalysis.expiresAt);
    f.advance(1);
    expect(() =>
      f.service.get(f.owner, { analysisId: operation.id }, f.guard),
    ).toThrow("expired");
  } finally {
    await f.close();
  }
});

it("keeps bounded capacity and removes expired evidence before admitting new analyses", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 16; i++)
      await f.service.run(f.owner, f.input, f.operation());
    await expect(
      f.service.run(f.owner, f.input, f.operation()),
    ).rejects.toThrow("capacity");
    expect(f.analyze).toHaveBeenCalledTimes(16);
    f.advance(30 * 60000);
    await expect(
      f.service.run(f.owner, f.input, f.operation()),
    ).resolves.toMatchObject({ pagesChanged: 0 });
  } finally {
    await f.close();
  }
});

it.each(["incomplete", "duplicate", "invalid", "oversize"])(
  "refuses %s observations without retaining a partial result",
  async (mode) => {
    const f = fixture();
    try {
      const items = structuredClone(f.items);
      if (mode === "incomplete") items.pop();
      if (mode === "duplicate") items[1].itemId = items[0].itemId;
      if (mode === "invalid") items[0].revision = "invalid";
      if (mode === "oversize") items[0].excludedReason = "x".repeat(1_000_001);
      f.analyze.mockResolvedValueOnce({ binding: f.binding, items });
      const operation = f.operation();
      await expect(
        f.service.run(f.owner, f.input, operation),
      ).rejects.toThrow();
      expect(() =>
        f.service.get(f.owner, { analysisId: operation.id }, f.guard),
      ).toThrow();
    } finally {
      await f.close();
    }
  },
);

it("prevents late publication after shutdown, cancellation or failed final verification", async () => {
  for (const mode of ["closed", "cancelled", "changed"]) {
    const f = fixture();
    const controller = new AbortController();
    const operation = { ...f.operation(), signal: controller.signal };
    f.verify.mockImplementationOnce(async () => {
      if (mode === "closed") f.service.close();
      if (mode === "cancelled") controller.abort();
      if (mode === "changed") throw new Error("changed");
    });
    try {
      await expect(
        f.service.run(f.owner, f.input, operation),
      ).rejects.toThrow();
      expect(() =>
        f.service.get(f.owner, { analysisId: operation.id }, f.guard),
      ).toThrow();
      expect(f.save).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  }
});

it("validates duplicate targets, the total target budget and all selected context/page revisions", async () => {
  const f = fixture();
  try {
    const base = {
      chapterId: f.input.chapterId,
      contextRevision: f.input.contextRevision,
      requestId: randomUUID(),
    };
    const pages = f.input.pages.slice(0, 2).map(({ pageId, revision }) => ({
      pageId,
      revision,
      targets: Array.from({ length: 50 }, (_, i) => ({
        kind: "region",
        regionId: `region-${i}`,
        sourceRect: { x: 0, y: 0, w: 1, h: 1 },
      })),
    }));
    const allowed = McpSelectionOcrSchema.parse({ ...base, pages });
    expect(() => validateMcpSelection(f.saved, allowed)).not.toThrow();
    const excessive = structuredClone(allowed);
    excessive.pages[0].targets.push({
      kind: "region",
      regionId: "extra",
      sourceRect: { x: 0, y: 0, w: 1, h: 1 },
    });
    expect(() => validateMcpSelection(f.saved, excessive)).toThrow("100");
    const duplicate = structuredClone(allowed);
    duplicate.pages[0].targets[1] = duplicate.pages[0].targets[0];
    expect(() => validateMcpSelection(f.saved, duplicate)).toThrow("unique");
    expect(() =>
      validateMcpSelection(f.saved, {
        ...allowed,
        pages: [allowed.pages[0], allowed.pages[0]],
      }),
    ).toThrow("distinct");
    expect(() =>
      validateMcpSelection(f.saved, {
        ...allowed,
        contextRevision: "0".repeat(16),
      }),
    ).toThrow("context");
    const changed = structuredClone(f.binding);
    changed.pages[1].revision = "page-v1:" + "0".repeat(16);
    expect(() => assertMcpSelectionFreshness(f.saved, changed)).toThrow(
      "page changed",
    );
    expect(() =>
      assertMcpSelectionFreshness(f.saved, {
        ...f.binding,
        membership: "wrong",
      }),
    ).toThrow("membership");
    expect(f.analyze).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
