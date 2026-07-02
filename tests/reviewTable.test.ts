import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LibraryChapter, LibraryWork } from "../src/shared/types";
import {
  buildReviewRows,
  parseReviewTable,
  serializeReviewRows,
} from "../src/shared/reviewTable";

const tempDirs: string[] = [];

describe("review CSV/TSV tables", () => {
  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("round-trips CSV cells with commas, quotes, newlines, and BOM", () => {
    const rows = buildReviewRows(makeChapter());
    rows[0].translated_text = '쉼표, "따옴표"\n줄바꿈';

    const serialized = serializeReviewRows(rows, "csv", true);
    const parsed = parseReviewTable(serialized, "csv");

    expect(serialized.charCodeAt(0)).toBe(0xfeff);
    expect(parsed[0]?.translated_text).toBe('쉼표, "따옴표"\n줄바꿈');
  });

  it("round-trips TSV and rejects missing required columns", () => {
    const rows = buildReviewRows(makeChapter());
    rows[0].review_note = "탭\t포함";

    const parsed = parseReviewTable(serializeReviewRows(rows, "tsv"), "auto");

    expect(parsed[0]?.review_note).toBe("탭\t포함");
    expect(() => parseReviewTable("chapter_id,block_id\nx,y\n", "csv")).toThrow(
      /필수 컬럼/,
    );
  });

  it("imports by block_id, warns on duplicate and source mismatch, and preserves OCR by default", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    const chapter = await library.openChapter("chapter-a");
    const rows = buildReviewRows(chapter);
    rows[0].translated_text = "첫 번째 수정";
    rows[0].review_status = "reviewed";
    rows[0].review_note = "확정";
    rows.push({ ...rows[0], translated_text: "중복 수정" });
    rows[1].source_text = "원문 불일치";
    rows[1].translated_text = "두 번째 수정";

    const result = await library.importReviewText({
      chapterId: "chapter-a",
      content: serializeReviewRows(rows, "csv"),
      format: "csv",
      updateSourceText: false,
      requireSourceMatch: false,
    });

    expect(result.updatedBlockCount).toBe(2);
    expect(result.skippedRowCount).toBe(1);
    expect(result.warnings.join("\n")).toContain("중복 block_id");
    expect(result.warnings.join("\n")).toContain("OCR 원문");
    expect(result.chapter.pages[0]?.blocks[0]?.translatedText).toBe(
      "첫 번째 수정",
    );
    expect(result.chapter.pages[0]?.blocks[0]?.reviewStatus).toBe("reviewed");
    expect(result.chapter.pages[0]?.blocks[0]?.reviewNote).toBe("확정");
    expect(result.chapter.pages[0]?.blocks[1]?.sourceText).toBe("またね");
    expect(result.chapter.pages[0]?.blocks[1]?.translatedText).toBe(
      "두 번째 수정",
    );
  });

  it("uses page_id to import rows when block_id is duplicated across pages", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir, { duplicateBlockIdsAcrossPages: true });
    const chapter = await library.openChapter("chapter-a");
    const rows = buildReviewRows(chapter);
    const secondPageRow = rows.find((row) => row.page_id === "page-b");
    expect(secondPageRow).toBeDefined();
    secondPageRow!.translated_text = "둘째 페이지 수정";

    const result = await library.importReviewText({
      chapterId: "chapter-a",
      content: serializeReviewRows(rows, "csv"),
      format: "csv",
      updateSourceText: false,
      requireSourceMatch: false,
    });

    expect(result.warnings).toEqual([]);
    expect(result.updatedBlockCount).toBe(1);
    expect(result.chapter.pages[0]?.blocks[0]?.translatedText).toBe("안녕");
    expect(result.chapter.pages[1]?.blocks[0]?.translatedText).toBe(
      "둘째 페이지 수정",
    );
  });

  it("skips source mismatches when requireSourceMatch is true and warns invalid statuses", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    const chapter = await library.openChapter("chapter-a");
    const rows = buildReviewRows(chapter);
    rows[0].source_text = "다른 원문";
    rows[0].translated_text = "건너뜀";
    rows[1].translated_text = "상태만 이상";
    rows[1].review_status = "done";

    const result = await library.importReviewText({
      chapterId: "chapter-a",
      content: serializeReviewRows(rows, "csv"),
      format: "csv",
      requireSourceMatch: true,
    });

    expect(result.updatedBlockCount).toBe(1);
    expect(result.skippedRowCount).toBe(1);
    expect(result.warnings.join("\n")).toContain("OCR 원문");
    expect(result.warnings.join("\n")).toContain("검수 상태 done");
    expect(result.chapter.pages[0]?.blocks[0]?.translatedText).toBe("안녕");
    expect(result.chapter.pages[0]?.blocks[1]?.translatedText).toBe(
      "상태만 이상",
    );
    expect(result.chapter.pages[0]?.blocks[1]?.reviewStatus).toBeUndefined();
  });
});

function makeChapter() {
  return {
    id: "chapter-a",
    workId: "work-a",
    title: "1화",
    sourceKind: "folder" as const,
    status: "completed" as const,
    pageOrder: ["page-a"],
    pages: [
      {
        id: "page-a",
        name: "001.png",
        imagePath: "C:\\library\\page.png",
        dataUrl: "",
        width: 100,
        height: 120,
        blocks: makeBlocks(),
        analysisStatus: "completed" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function createTempLibrary(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-review-table-"));
  tempDirs.push(rootDir);
  return rootDir;
}

async function loadLibrary(
  rootDir: string,
): Promise<typeof import("../src/main/library")> {
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
      isPackaged: false,
      repoRoot: rootDir,
      executableDir: rootDir,
      resourcesDir: rootDir,
      dataRoot: rootDir,
      settingsPath: join(rootDir, "settings.json"),
      libraryDir: rootDir,
      logsDir: join(rootDir, "logs"),
      logFile: join(rootDir, "logs", "app.log"),
      runtimeDir: join(rootDir, "runtime"),
      toolsDir: join(rootDir, "tools"),
      llamaRuntimeDir: join(rootDir, "tools", "llama"),
      llamaServerPath: join(rootDir, "tools", "llama", "llama-server.exe"),
    }),
  }));
  return import("../src/main/library");
}

type SeedLibraryOptions = {
  duplicateBlockIdsAcrossPages?: boolean;
};

async function seedLibrary(
  rootDir: string,
  options: SeedLibraryOptions = {},
): Promise<void> {
  const work: LibraryWork = {
    id: "work-1",
    title: "원본 작품",
    chapterOrder: ["chapter-a"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const chapter = makeStoredChapter(rootDir, options);
  await mkdir(
    join(rootDir, "works", "work-1", "chapters", "chapter-a", "pages"),
    {
      recursive: true,
    },
  );
  await writeFile(
    join(
      rootDir,
      "works",
      "work-1",
      "chapters",
      "chapter-a",
      "pages",
      "001.png",
    ),
    "image",
  );
  if (options.duplicateBlockIdsAcrossPages) {
    await writeFile(
      join(
        rootDir,
        "works",
        "work-1",
        "chapters",
        "chapter-a",
        "pages",
        "002.png",
      ),
      "image",
    );
  }
  await writeJson(join(rootDir, "index.json"), { workOrder: ["work-1"] });
  await writeJson(join(rootDir, "works", "work-1", "work.json"), work);
  await writeJson(
    join(rootDir, "works", "work-1", "chapters", "chapter-a", "chapter.json"),
    chapter,
  );
  expect(existsSync(join(rootDir, "index.json"))).toBe(true);
}

function makeStoredChapter(
  rootDir: string,
  options: SeedLibraryOptions = {},
): LibraryChapter {
  const pages: LibraryChapter["pages"] = [
    {
      id: "page-a",
      name: "001.png",
      imagePath: join(
        rootDir,
        "works",
        "work-1",
        "chapters",
        "chapter-a",
        "pages",
        "001.png",
      ),
      width: 100,
      height: 120,
      blocks: makeBlocks(),
      analysisStatus: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  if (options.duplicateBlockIdsAcrossPages) {
    pages.push({
      id: "page-b",
      name: "002.png",
      imagePath: join(
        rootDir,
        "works",
        "work-1",
        "chapters",
        "chapter-a",
        "pages",
        "002.png",
      ),
      width: 100,
      height: 120,
      blocks: [
        {
          ...makeBlocks()[0]!,
          sourceText: "こんばんは",
          translatedText: "좋은 저녁",
        },
      ],
      analysisStatus: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  return {
    id: "chapter-a",
    workId: "work-1",
    title: "1화",
    sourceKind: "folder",
    status: "completed",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlocks(): LibraryChapter["pages"][number]["blocks"] {
  return ["こんにちは", "またね"].map((sourceText, index) => ({
    id: `block-${index + 1}`,
    type: "nonsolid",
    bbox: { x: 100 - index * 90, y: 10, w: 80, h: 80 },
    sourceText,
    translatedText: index === 0 ? "안녕" : "또 봐",
    confidence: 0.95,
    sourceDirection: "vertical",
    renderDirection: "horizontal",
    fontSizePx: 18,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 0.8,
  }));
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
