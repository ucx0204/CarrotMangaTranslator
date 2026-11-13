import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { expect, it } from "vitest";
import { preflightCompositeImport } from "../src/main/mcp/mcpCompositeNativeContext";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import {
  McpImportCreateSchema,
  McpImportPreviewReferenceSchema,
  mcpLibraryImportOutputs,
} from "../src/shared/mcpLibraryImport";

function selection(count: number) {
  return {
    requestId: randomUUID(),
    previewId: randomUUID(),
    snapshot: "0".repeat(16),
    allowNativePreparation: true,
    target: { mode: "new", title: "500 pages" },
    chapters: [
      {
        draftId: randomUUID(),
        title: "One chapter",
        pageIds: Array.from({ length: count }, () => randomUUID()),
      },
    ],
  };
}
it.each([50, 51, 499, 500])("accepts %i pages as one chapter", (count) => {
  expect(
    McpImportCreateSchema.parse(selection(count)).chapters[0].pageIds,
  ).toHaveLength(count);
});
it("rejects 501 pages both in a single chapter and across individually valid chapters", () => {
  expect(McpImportCreateSchema.safeParse(selection(501)).success).toBe(false);
  const input = selection(250);
  input.chapters.push(selection(251).chapters[0]);
  expect(McpImportCreateSchema.safeParse(input).success).toBe(false);
  input.chapters[1].pageIds.pop();
  expect(McpImportCreateSchema.safeParse(input).success).toBe(true);
});

it.each(["images", "archive"] as const)(
  "imports 500 actual %s, persists the complete mapping and replays after restart",
  async (kind) => {
    const f = await libraryImportFixture({}, true);
    try {
      const paths: string[] = [];
      const zip = new AdmZip();
      for (let i = 0; i < 500; i++) {
        const name = `${String(i).padStart(3, "0")}.png`;
        if (kind === "archive") zip.addFile(name, f.bytes);
        else {
          const path = join(f.env.root, name);
          await writeFile(path, f.bytes);
          paths.push(path);
        }
      }
      if (kind === "archive") {
        const path = join(f.env.root, "chapter.zip");
        await writeFile(path, zip.toBuffer());
        paths.push(path);
      }
      f.choose.mockResolvedValueOnce(paths);
      const prepared = await f.settle(
        await f.invoke("carrot_choose_import_files", {
          source: "local",
          kind,
          requestId: randomUUID(),
        }),
      );
      const ref = McpImportPreviewReferenceSchema.parse(
        prepared.result?.importPreview,
      );
      const pages: Array<{ pageId: string; draftId: string }> = [];
      for (let offset = 0; offset < 500; offset += 25) {
        const view = mcpLibraryImportOutputs.carrot_get_import_preview.parse(
          await f.invoke("carrot_get_import_preview", {
            previewId: ref.previewId,
            snapshot: ref.snapshot,
            offset,
            limit: 25,
          }),
        );
        pages.push(...view.pages);
      }
      expect(pages).toHaveLength(500);
      const input = McpImportCreateSchema.parse({
        ...selection(1),
        previewId: ref.previewId,
        snapshot: ref.snapshot,
        chapters: [
          {
            draftId: pages[0].draftId,
            title: "One complete chapter",
            pageIds: pages.map((p) => p.pageId),
          },
        ],
      });
      const before = await f.library.listLibrary();
      const session = f.current().session;
      await expect(
        preflightCompositeImport(
          {
            imageReviewMapping: session.reviewMapping,
            workFileReviewMapping: session.workFileReviewMapping,
          },
          "import-owner",
          { phaseId: "import", action: { kind: "import-create", input } },
          () => {},
        ),
      ).rejects.toMatchObject({ code: "invalid_edit" });
      expect(await f.library.listLibrary()).toEqual(before);
      const receipt = await f.create(input);
      expect(receipt.chapterIds).toHaveLength(1);
      expect(receipt.pageCount).toBe(500);
      const saved = await f.library.openChapter(receipt.chapterIds[0]);
      expect(saved.pages).toHaveLength(500);
      for (const index of [0, 249, 499]) {
        expect(receipt.pageMapping?.items[index].page.pageId).toBe(
          saved.pages[index].id,
        );
        expect(receipt.pageMapping?.items[index].pageIndex).toBe(index);
        expect(await readFile(saved.pages[index].imagePath)).toEqual(f.bytes);
      }
      await f.restart();
      expect(await f.create(input)).toEqual(receipt);
      expect(f.validate).toHaveBeenCalledTimes(500);
    } finally {
      await f.close();
    }
  },
  120_000,
);

it("rolls back a 500-page native import when the middle image validator fails", async () => {
  const f = await libraryImportFixture({}, true);
  try {
    const paths: string[] = [];
    for (let i = 0; i < 500; i++) {
      const path = join(f.env.root, `${i}.png`);
      await writeFile(path, f.bytes);
      paths.push(path);
    }
    f.choose.mockResolvedValueOnce(paths);
    const ref = await f.prepare();
    const pages: Array<{ pageId: string; draftId: string }> = [];
    for (let offset = 0; offset < 500; offset += 25) {
      const view = mcpLibraryImportOutputs.carrot_get_import_preview.parse(
        await f.invoke("carrot_get_import_preview", {
          previewId: ref.previewId,
          snapshot: ref.snapshot,
          offset,
          limit: 25,
        }),
      );
      pages.push(...view.pages);
    }
    const before = await f.library.listLibrary();
    f.validate.mockImplementation(async () => {
      if (f.validate.mock.calls.length === 250)
        throw new Error("Injected midpoint failure");
    });
    const input = McpImportCreateSchema.parse({
      ...selection(1),
      previewId: ref.previewId,
      snapshot: ref.snapshot,
      chapters: [
        {
          draftId: pages[0].draftId,
          title: "Rollback",
          pageIds: pages.map((p) => p.pageId),
        },
      ],
    });
    const done = await f.settle(
      await f.invoke("carrot_import_chapters", input),
    );
    expect(done.status).toBe("failed");
    expect(f.validate).toHaveBeenCalledTimes(250);
    expect(await f.library.listLibrary()).toEqual(before);
    expect(
      (await f.storage.index()).entries.some((e) => e.kind === "import"),
    ).toBe(false);
    expect(await readFile(paths[249])).toEqual(f.bytes);
  } finally {
    await f.close();
  }
}, 120_000);
