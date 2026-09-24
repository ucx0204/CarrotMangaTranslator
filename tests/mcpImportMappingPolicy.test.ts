import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  McpImportCreateSchema,
  McpImportReceiptSchema,
} from "../src/shared/mcpLibraryImport";
import { McpWorkFileCreateSchema } from "../src/shared/mcpWorkFileImport";
import { matchesMcpImportPageMapping } from "../src/shared/mcpImportMapping";
import {
  prepareMcpImageImportMapping,
  prepareMcpWorkFileMapping,
} from "../src/main/application/mcpImportMappingPolicy";
import { McpImportMappingPublication } from "../src/main/mcp/mcpImportMappingPublication";
import {
  matchesImageImportMapping,
  matchesWorkFileImportMapping,
} from "../src/main/mcp/mcpImportMappingIntegrity";
import type { NativeImportedPageEvidence } from "../src/main/libraryStore/importPublicationEvidence";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function imageSelection() {
  const input = McpImportCreateSchema.parse({
    requestId: randomUUID(),
    previewId: randomUUID(),
    snapshot: "a".repeat(16),
    allowNativePreparation: true,
    target: { mode: "new", title: "Reviewed" },
    chapters: [
      {
        draftId: randomUUID(),
        title: "Ordered",
        pageIds: [randomUUID(), randomUUID()],
      },
    ],
  });
  const sources = input.chapters[0].pageIds.map((_, pageIndex) => ({
    draftId: input.chapters[0].draftId,
    pageIndex,
    bytes: 100 + pageIndex,
    sha256: hash(`source-${pageIndex}`),
  }));
  return { input, sources };
}
function nativeEvidence(
  plan: ReturnType<typeof prepareMcpImageImportMapping>,
  index: number,
): NativeImportedPageEvidence {
  const selected = plan.items[index];
  return {
    source: {
      kind: plan.kind,
      chapterId: selected.sourceChapterId,
      pageIndex: selected.pageIndex,
      ...(selected.sourcePageId === undefined
        ? {}
        : { pageId: selected.sourcePageId }),
      ...(selected.source ?? { bytes: 100, sha256: hash("package-image") }),
      format: "png",
    },
    original: {
      ...(selected.source ?? { bytes: 100, sha256: hash("package-image") }),
      format: "png",
    },
    page: {
      workId: "saved-work",
      chapterId: `saved-${selected.chapterIndex}`,
      pageId: `page-${index}`,
      revision: `page-v1:${"b".repeat(16)}`,
      reviewRevision: `page-v1:${"c".repeat(16)}`,
      blockCount: 101,
      blockIdsSha256: hash("all-101-native-block-identities"),
      filesSha256: hash("native-file-role-evidence"),
    },
  };
}
function metadata(
  collector: McpImportMappingPublication,
  chapterCount: number,
) {
  collector.observeMetadata(
    { kind: "work", workId: "saved-work", sha256: hash("saved-work") },
    async () => {},
  );
  collector.observeMetadata(
    { kind: "work-guide", workId: "saved-work", sha256: null },
    async () => {},
  );
  for (let index = 0; index < chapterCount; index += 1)
    collector.observeMetadata(
      {
        kind: "chapter",
        workId: "saved-work",
        chapterId: `saved-${index}`,
        sha256: hash(`saved-chapter-${index}`),
        memorySha256: null,
      },
      async () => {},
    );
}
function publish(plan: ReturnType<typeof prepareMcpImageImportMapping>) {
  const collector = new McpImportMappingPublication(plan);
  plan.items.forEach((_, index) =>
    collector.observePage(nativeEvidence(plan, index), async () => {}),
  );
  metadata(collector, plan.review.maxChapters);
  return collector.finish({
    workId: "saved-work",
    chapterIds: Array.from(
      { length: plan.review.maxChapters },
      (_, index) => `saved-${index}`,
    ),
  });
}

describe("exact native import mapping", () => {
  it("binds exact source bytes and reviewed order while excluding request replay identity", () => {
    const { input, sources } = imageSelection();
    const first = prepareMcpImageImportMapping(input, sources);
    expect(first.review.itemKeys).toHaveLength(2);
    expect(
      first.review.itemKeys.every((key) => /^[a-f0-9]{64}$/.test(key)),
    ).toBe(true);
    const replay = { ...input, requestId: randomUUID() };
    expect(prepareMcpImageImportMapping(replay, sources).review).toEqual(
      first.review,
    );
    expect(
      prepareMcpImageImportMapping(
        {
          previewId: input.previewId,
          snapshot: input.snapshot,
          chapters: input.chapters,
          target: input.target,
        },
        sources,
      ).review,
    ).toEqual(first.review);
    const reordered = {
      ...input,
      chapters: [
        {
          ...input.chapters[0],
          pageIds: [...input.chapters[0].pageIds].reverse(),
        },
      ],
    };
    const sourceOrder = [...sources]
      .reverse()
      .map((source, pageIndex) => ({ ...source, pageIndex }));
    const second = prepareMcpImageImportMapping(reordered, sourceOrder);
    expect(second.review.itemKeys).toEqual(
      [...first.review.itemKeys].reverse(),
    );
    expect(second.review.selectionFingerprint).not.toBe(
      first.review.selectionFingerprint,
    );
    expect(
      prepareMcpImageImportMapping(
        { ...input, target: { title: "Reviewed", mode: "new" } },
        sources,
      ).review,
    ).toEqual(first.review);
    expect(
      prepareMcpImageImportMapping(input, [
        { ...sources[0], sha256: hash("changed") },
        sources[1],
      ]).review.itemKeys[0],
    ).not.toBe(first.review.itemKeys[0]);
    expect(
      prepareMcpImageImportMapping(
        { ...input, target: { mode: "new", title: "Other destination" } },
        sources,
      ).review.selectionFingerprint,
    ).not.toBe(first.review.selectionFingerprint);
  });

  it("keeps batch item identity and reviewed chapter titles in the selection fingerprint", () => {
    const { input, sources } = imageSelection();
    const item = {
      itemId: randomUUID(),
      previewId: input.previewId,
      snapshot: input.snapshot,
      chapters: input.chapters,
    };
    const batch = { target: input.target, items: [item] };
    const first = prepareMcpImageImportMapping(batch, sources).review;
    for (const changed of [
      { ...item, itemId: randomUUID() },
      {
        ...item,
        chapters: [{ ...item.chapters[0], title: "Changed chapter title" }],
      },
    ]) {
      const next = prepareMcpImageImportMapping(
        { ...batch, items: [changed] },
        sources,
      ).review;
      expect(next.itemKeys).toEqual(first.itemKeys);
      expect(next.selectionFingerprint).not.toBe(first.selectionFingerprint);
    }
  });

  it("rejects missing, extra, reordered and malformed source identity evidence", () => {
    const { input, sources } = imageSelection();
    for (const identities of [
      sources.slice(0, 1),
      [...sources, sources[0]],
      [...sources].reverse(),
      [{ ...sources[0], sha256: "bad" }, sources[1]],
      [{ ...sources[0], bytes: 0 }, sources[1]],
    ]) {
      expect(() => prepareMcpImageImportMapping(input, identities)).toThrow();
    }
  });

  it("requires every native callback in reviewed order and preserves whole-page block identity", async () => {
    const { input, sources } = imageSelection();
    const plan = prepareMcpImageImportMapping(input, sources);
    const collector = new McpImportMappingPublication(plan);
    const first = nativeEvidence(plan, 0);
    let checks = 0;
    expect(() =>
      collector.observePage(nativeEvidence(plan, 1), async () => {}),
    ).toThrow();
    collector.observePage(first, async () => {
      checks += 1;
    });
    first.page.pageId = "mutated-callback-object";
    expect(() =>
      collector.finish({ workId: "saved-work", chapterIds: ["saved-0"] }),
    ).toThrow();
    collector.observePage(nativeEvidence(plan, 1), async () => {
      checks += 1;
    });
    await collector.verify();
    expect(checks).toBe(2);
    expect(() =>
      collector.finish({ workId: "saved-work", chapterIds: ["saved-0"] }),
    ).toThrow("publication lacks");
    metadata(collector, plan.review.maxChapters);
    const mapping = collector.finish({
      workId: "saved-work",
      chapterIds: ["saved-0"],
    });
    expect(mapping.items[0].page).toMatchObject({
      pageId: "page-0",
      blockCount: 101,
    });
    expect(mapping.items.map((item) => item.itemKey)).toEqual(
      plan.review.itemKeys,
    );
    expect(matchesImageImportMapping(input, mapping)).toBe(true);
    expect(() =>
      collector.observePage(nativeEvidence(plan, 1), async () => {}),
    ).toThrow();
    expect(() =>
      collector.finish({ workId: "other", chapterIds: ["saved-0"] }),
    ).toThrow();
  });

  it("rejects mismatched source digests, duplicate saved IDs and a failed final verifier", async () => {
    const { input, sources } = imageSelection();
    const plan = prepareMcpImageImportMapping(input, sources);
    const collector = new McpImportMappingPublication(plan);
    const changed = nativeEvidence(plan, 0);
    changed.source.sha256 = hash("changed-source");
    expect(() => collector.observePage(changed, async () => {})).toThrow();
    collector.observePage(nativeEvidence(plan, 0), async () => {
      throw new Error("stored bytes changed");
    });
    const duplicate = nativeEvidence(plan, 1);
    duplicate.page.pageId = "page-0";
    collector.observePage(duplicate, async () => {});
    metadata(collector, plan.review.maxChapters);
    await expect(collector.verify()).rejects.toThrow("stored bytes changed");
    expect(() =>
      collector.finish({ workId: "saved-work", chapterIds: ["saved-0"] }),
    ).toThrow();
  });

  it("seals package indices with the full archive digest and supports native empty selected chapters", () => {
    const packageId = "chapter-" + "x".repeat(190);
    const input = McpWorkFileCreateSchema.parse({
      requestId: randomUUID(),
      uploadId: randomUUID(),
      snapshot: "a".repeat(16),
      target: { mode: "new", title: "Workfile" },
      chapters: [
        { packageChapterId: "empty", title: "Empty" },
        { packageChapterId: packageId, title: "Actual" },
      ],
      allowNativePreparation: true,
      acknowledgeV1Limitations: true,
    });
    const chapters = [
      { packageChapterId: "empty", pageIds: [] },
      { packageChapterId: packageId, pageIds: ["second", "first"] },
    ];
    const plan = prepareMcpWorkFileMapping(input, hash("archive"), chapters);
    const mapping = publish(plan);
    expect(mapping.chapterPageCounts).toEqual([0, 2]);
    expect(mapping.items.map((item) => item.chapterIndex)).toEqual([1, 1]);
    expect(matchesWorkFileImportMapping(input, mapping)).toBe(true);
    expect(plan.items.map((item) => item.sourcePageId)).toEqual([
      "second",
      "first",
    ]);
    expect(JSON.stringify(mapping)).not.toContain(packageId);
    expect(
      prepareMcpWorkFileMapping(input, hash("changed archive"), chapters).review
        .itemKeys,
    ).not.toEqual(plan.review.itemKeys);
    const collector = new McpImportMappingPublication(plan);
    const wrong = nativeEvidence(plan, 0);
    wrong.source.pageId = "first";
    expect(() => collector.observePage(wrong, async () => {})).toThrow();
  });

  it("detects altered retained mappings without reading or reconstructing current chapter order", () => {
    const { input, sources } = imageSelection();
    const mapping = publish(prepareMcpImageImportMapping(input, sources));
    const changed = structuredClone(mapping);
    changed.items[0].itemKey = hash("forged");
    expect(matchesImageImportMapping(input, changed)).toBe(false);
    changed.items[0].itemKey = mapping.items[0].itemKey;
    changed.selectionFingerprint = hash("forged selection");
    expect(matchesImageImportMapping(input, changed)).toBe(false);
    const wrongOrder = { ...mapping, items: [...mapping.items].reverse() };
    expect(
      matchesMcpImportPageMapping({
        workId: "saved-work",
        chapterIds: ["saved-0"],
        pageCount: 2,
        pageMapping: wrongOrder,
      }),
    ).toBe(false);
  });

  it("keeps legacy receipts inspectable without manufacturing any page proof", () => {
    const receipt = McpImportReceiptSchema.parse({
      id: randomUUID(),
      requestId: randomUUID(),
      status: "imported",
      workId: "legacy-work",
      chapterIds: ["legacy-chapter"],
      pageCount: 2,
      source: "local",
      createdAt: 1,
      expiresAt: 2,
      retention: "seven-days",
    });
    expect(receipt.pageMapping).toBeUndefined();
    expect(matchesMcpImportPageMapping(receipt)).toBe(true);
  });

  it("reads legacy page mappings without manufacturing publication metadata or SFX review proof", () => {
    const { input, sources } = imageSelection();
    const legacy = publish(prepareMcpImageImportMapping(input, sources));
    delete legacy.publication;
    for (const item of legacy.items) delete item.page.reviewRevision;
    const receipt = McpImportReceiptSchema.parse({
      id: randomUUID(),
      requestId: input.requestId,
      status: "imported",
      workId: "saved-work",
      chapterIds: ["saved-0"],
      pageCount: 2,
      source: "local",
      pageMapping: legacy,
      createdAt: 1,
      expiresAt: 2,
      retention: "seven-days",
    });
    expect(receipt.pageMapping?.publication).toBeUndefined();
    expect(receipt.pageMapping?.items[0].page.reviewRevision).toBeUndefined();
    expect(matchesMcpImportPageMapping(receipt)).toBe(true);
  });
});
