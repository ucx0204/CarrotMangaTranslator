import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";
import {
  gatherText,
  filterPagesByField,
  formatGatheredText,
} from "../src/shared/gatherText";
import {
  buildReviewRows,
  serializeReviewRows,
} from "../src/shared/reviewTable";
import { resolveReadingDirection } from "../src/shared/blockReadingOrder";
import { resolveSourceReadingDirection } from "../src/shared/translationLanguages";
import type { McpTextExchangeOptions } from "../src/shared/mcpExchangeFiles";
import type { LibraryChapter } from "../src/shared/libraryTypes";

const options: McpTextExchangeOptions[] = [
  { format: "txt", field: "both", includeHeaders: true },
  { format: "txt", field: "translated", includeHeaders: false },
  { format: "txt", field: "source", includeHeaders: true },
  { format: "csv", includeBom: true },
  { format: "csv", includeBom: false },
  { format: "tsv", includeBom: true },
  { format: "tsv", includeBom: false },
];

it.each(options)(
  "matches native serializer bytes for %j without reading images",
  async (option) => {
    const f = await typographyAnalysisAppFixture();
    const { readMcpTextExportSource } =
      await import("../src/main/mcp/mcpTextExportSource");
    const { getAppSettings } = await import("../src/main/settingsStore");
    const { hydrateChapter } =
      await import("../src/main/libraryStore/chapterSnapshots");
    try {
      const stored: LibraryChapter = JSON.parse(
        await readFile(f.chapterPath, "utf8"),
      );
      stored.pages[0].name = "quoted, page\tname.png";
      stored.pages[0].blocks[0].sourceText = '  원문, "인용"\r\n둘째 줄  ';
      stored.pages[0].blocks[0].translatedText = '  =SUM(1,2)\t"literal"  ';
      stored.pages[0].blocks[0].reviewNote = "  note\r\nwith\ttabs  ";
      stored.pages[0].blocks[1].sourceText = " \t ";
      stored.pages[0].blocks[1].translatedText = " \r\n ";
      await writeFile(f.chapterPath, JSON.stringify(stored));
      const workPath = join(f.env.libraryDir, "works", "work", "work.json");
      const work = JSON.parse(await readFile(workPath, "utf8"));
      work.readingDirection = "ltr";
      await writeFile(workPath, JSON.stringify(work));
      const before = await readFile(f.chapterPath);
      const workBefore = await readFile(workPath);
      const settings = await getAppSettings();
      const inferred = resolveSourceReadingDirection(
        settings.translation?.sourceLanguage,
      );
      const direction =
        option.format === "txt"
          ? resolveReadingDirection("ltr", inferred)
          : inferred;
      const chapter = hydrateChapter(stored);
      const expected =
        option.format === "txt"
          ? formatGatheredText(
              filterPagesByField(
                gatherText({
                  chapter,
                  page: null,
                  scope: "chapter",
                  direction,
                }),
                option.field,
              ),
              option.field,
              option.includeHeaders,
            )
          : serializeReviewRows(
              buildReviewRows(chapter, direction),
              option.format,
              option.includeBom,
            );
      const input = {
        chapterId: "chapter",
        pageIds: ["second", "page"],
        options: option,
      };
      const source = await readMcpTextExportSource(input, vi.fn());
      expect(source.bytes).toEqual(Buffer.from(expected, "utf8"));
      expect(source.review.bytes).toBe(Buffer.byteLength(expected, "utf8"));
      expect(source.binding.pages.map((page) => page.pageId)).toEqual([
        "page",
        "second",
      ]);
      expect(source.binding.direction).toBe(direction);
      expect(source.review.executionReserved).toBe(false);
      for (const page of chapter.pages) {
        expect(await readFile(page.imagePath)).toEqual(f.bytes);
        await rm(page.imagePath);
      }
      const missingImages = await readMcpTextExportSource(input, vi.fn());
      expect(missingImages.bytes).toEqual(source.bytes);
      expect(missingImages.binding).toEqual(source.binding);
      await source.verifySources();
      expect(await readFile(f.chapterPath)).toEqual(before);
      expect(await readFile(workPath)).toEqual(workBefore);
      expect(f.handoffPages).toEqual([]);
      expect(f.app.jobs.all).toEqual([]);
      expect(f.prepare).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it.each([
  "page-name",
  "page-order",
  "block-order",
  "reading-direction",
] as const)(
  "rejects a stale native TXT binding after saved %s changes",
  async (change) => {
    const f = await typographyAnalysisAppFixture();
    const { readMcpTextExportSource } =
      await import("../src/main/mcp/mcpTextExportSource");
    try {
      const workPath = join(f.env.libraryDir, "works", "work", "work.json");
      const work = JSON.parse(await readFile(workPath, "utf8"));
      work.readingDirection = "rtl";
      await writeFile(workPath, JSON.stringify(work));
      const source = await readMcpTextExportSource(
        {
          chapterId: "chapter",
          options: { format: "txt", field: "both", includeHeaders: true },
        },
        vi.fn(),
      );
      if (change === "reading-direction") {
        work.readingDirection = "ltr";
        await writeFile(workPath, JSON.stringify(work));
      } else {
        const stored: LibraryChapter = JSON.parse(
          await readFile(f.chapterPath, "utf8"),
        );
        if (change === "page-name") stored.pages[0].name = "renamed.png";
        if (change === "page-order") stored.pageOrder = ["second", "page"];
        if (change === "block-order") stored.pages[0].blockOrder = ["a", "b"];
        await writeFile(f.chapterPath, JSON.stringify(stored));
      }
      const changed = await readFile(f.chapterPath);
      const workChanged = await readFile(workPath);
      await expect(source.verifySources()).rejects.toMatchObject({
        code: "revision_conflict",
      });
      expect(await readFile(f.chapterPath)).toEqual(changed);
      expect(await readFile(workPath)).toEqual(workChanged);
      expect(f.handoffPages).toEqual([]);
      expect(f.prepare).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("binds review-table order to the saved source language", async () => {
  const f = await typographyAnalysisAppFixture();
  const { readMcpTextExportSource } =
    await import("../src/main/mcp/mcpTextExportSource");
  const { updateAppSettings } = await import("../src/main/settingsStore");
  try {
    await updateAppSettings((settings) => ({
      ...settings,
      translation: {
        ...settings.translation,
        sourceLanguage: "ja",
        targetLanguage: settings.translation?.targetLanguage ?? "en",
      },
    }));
    const source = await readMcpTextExportSource(
      {
        chapterId: "chapter",
        options: { format: "csv", includeBom: false },
      },
      vi.fn(),
    );
    expect(source.binding.direction).toBe("rtl");
    const before = await readFile(f.chapterPath);
    await updateAppSettings((settings) => ({
      ...settings,
      translation: {
        ...settings.translation,
        sourceLanguage: "en",
        targetLanguage: settings.translation?.targetLanguage ?? "en",
      },
    }));
    await expect(source.verifySources()).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});

it.each([{ pageIds: ["page", "page"] }, { pageIds: ["page", "missing"] }])(
  "rejects an inexact page selection %j without changing saved bytes",
  async ({ pageIds }) => {
    const f = await typographyAnalysisAppFixture();
    const { readMcpTextExportSource } =
      await import("../src/main/mcp/mcpTextExportSource");
    try {
      const before = await readFile(f.chapterPath);
      await expect(
        readMcpTextExportSource(
          {
            chapterId: "chapter",
            pageIds,
            options: { format: "tsv", includeBom: true },
          },
          vi.fn(),
        ),
      ).rejects.toMatchObject({ code: "invalid_edit" });
      expect(await readFile(f.chapterPath)).toEqual(before);
      expect(f.handoffPages).toEqual([]);
    } finally {
      await f.close();
    }
  },
);
