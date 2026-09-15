import { expect, it, vi } from "vitest";
import { preflightPageImageExport } from "../src/main/jobs/pageImageExportSelection";
import { describeMcpTool } from "../src/main/mcp/mcpReadTools";
import { mcpReviewOutputSchemas } from "../src/shared/mcpReviewSchemas";
import { reviewToolsFixture } from "./mcpReviewTools.fixture";

it("exposes metadata-only tools with strict structured output and read permission", async () => {
  const f = reviewToolsFixture();
  const before = structuredClone(f.chapter);
  for (const tool of f.tools)
    expect(describeMcpTool(tool)).toMatchObject({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: { type: "object" },
    });
  expect(f.tools.map((t) => t.requiredScopes)).toEqual([
    ["carrot.read"],
    ["carrot.read"],
  ]);
  const result = await f.call(0, { chapterId: "chapter" });
  expect(result.isError).toBe(false);
  expect(
    mcpReviewOutputSchemas.carrot_get_chapter_review.safeParse(
      result.structuredContent,
    ).success,
  ).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE|private|original-a|sourceText/,
  );
  expect(f.repository.listLibrary).not.toHaveBeenCalled();
  expect(f.chapter).toEqual(before);
});
it("requires a snapshot for later pages and rejects mixing edits into pagination", async () => {
  const f = reviewToolsFixture();
  f.chapter.pages.push({
    ...structuredClone(f.chapter.pages[0]),
    id: "next",
    blocks: [],
  });
  f.chapter.pageOrder.push("next");
  const first = mcpReviewOutputSchemas.carrot_get_chapter_review.parse(
    (await f.call(0, { chapterId: "chapter", limit: 1 })).structuredContent,
  );
  const next = await f.call(0, {
    chapterId: "chapter",
    offset: 1,
    limit: 1,
    snapshot: first.snapshot,
  });
  expect(next.structuredContent).toMatchObject({
    total: 2,
    nextOffset: null,
    pages: [{ pageId: "next" }],
  });
  f.chapter.pages[1].analysisStatus = "failed";
  await expect(
    f.call(0, { chapterId: "chapter", offset: 1, snapshot: first.snapshot }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
});
it.each([
  { chapterId: "../private" },
  { chapterId: "chapter", path: "/private" },
  { chapterId: "chapter", filter: "anything" },
  { chapterId: "chapter", filter: null },
  { chapterId: "chapter", offset: 1 },
  { chapterId: "chapter", offset: -1 },
  { chapterId: "chapter", limit: 101 },
  { chapterId: "chapter", limit: 1.5 },
  { chapterId: "chapter", snapshot: "bad" },
  { chapterId: "chapter", snapshot: null },
])(
  "rejects invalid review arguments before accessing data: %j",
  async (args) => {
    const f = reviewToolsFixture();
    await expect(f.call(0, args)).rejects.toThrow();
    expect(f.repository.openChapter).not.toHaveBeenCalled();
  },
);
it.each([
  { chapterId: "chapter", pageId: "../private" },
  { chapterId: "chapter", pageId: "page", outputDir: "/private" },
  { chapterId: "chapter", pageId: "page", omitText: true },
  { chapterId: "chapter", pageId: "page", outputFormat: "psd" },
])("rejects unsupported preflight options: %j", async (args) => {
  const f = reviewToolsFixture();
  await expect(f.call(1, args)).rejects.toThrow();
  expect(f.repository.openChapter).not.toHaveBeenCalled();
});
it.each(["idle", "running", "completed", "failed"] as const)(
  "matches the existing desktop PNG rules for %s pages",
  async (status) => {
    const f = reviewToolsFixture();
    f.chapter.pages[0].analysisStatus = status;
    f.chapter.pages[0].blocks.forEach((b) => {
      b.translatedText = "";
    });
    const desktop = await preflightPageImageExport(
      {
        workId: "work",
        outputFormat: "png",
        omitText: false,
        selections: [
          { chapterId: "chapter", mode: "page-set", pageIds: ["page"] },
        ],
      },
      f.repository,
    );
    const before = structuredClone(f.chapter);
    const result = await f.call(1, { chapterId: "chapter", pageId: "page" });
    expect(result.structuredContent).toMatchObject({
      issues: desktop.issues.map(({ code, severity }) => ({ code, severity })),
      executionReserved: false,
      notChecked: expect.arrayContaining([
        "translation-quality",
        "image-file-readability",
        "image-transfer-permission-and-redaction",
      ]),
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|private|sampleRelativePath|outputPolicy|sourceText/,
    );
    expect(f.chapter).toEqual(before);
  },
);
it("checks access before and after awaited inspection without hiding a revocation", async () => {
  const f = reviewToolsFixture();
  const deny = vi.fn(() => {
    throw new Error("revoked");
  });
  await expect(f.call(0, { chapterId: "chapter" }, deny)).rejects.toThrow(
    "revoked",
  );
  expect(f.repository.openChapter).not.toHaveBeenCalled();
  let permitted = true;
  f.repository.listLibrary.mockImplementationOnce(async () => {
    permitted = false;
    return { works: [], workOrder: [] };
  });
  await expect(
    f.call(1, { chapterId: "chapter", pageId: "page" }, () => {
      if (!permitted) throw new Error("revoked");
    }),
  ).rejects.toThrow();
});
it("pins the inspected chapter and refuses a changed page rather than returning mixed export warnings", async () => {
  const f = reviewToolsFixture();
  const library = await f.repository.listLibrary();
  f.repository.listLibrary.mockImplementationOnce(async () => {
    f.chapter.pages[0].analysisStatus = "failed";
    return library;
  });
  await expect(
    f.call(1, { chapterId: "chapter", pageId: "page" }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(f.repository.openChapter).toHaveBeenCalledTimes(2);
});
