import { createCodexRunContext } from "../src/main/pipeline/codexTypesettingContext";
import { buildPageStoryMemory } from "../src/main/pipeline/storyMemoryBuilder";
import type { PipelineOptions } from "../src/main/pipeline/types";
import type { CodexPageReading } from "../src/shared/codexTypesettingTypes";
import { describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../src/shared/workContextTypes";
import {
  persistPageContextAfterSuccess,
  type PageContextPersistenceLogger,
  type PageContextPersistenceRepository,
} from "../src/main/pipeline/pageContextPersistence";
import { createWarningCollector } from "../src/main/pipeline/warningCollector";

const NOW = "2026-01-01T00:00:00.000Z";

describe("page context persistence", () => {
  it("does not retain orphan AI IDs when style-guide storage fails", async () => {
    const dependencies = makeDependencies();
    dependencies.repository.saveWorkStyleGuide = vi.fn(
      async () => await Promise.reject(new Error("style disk failure")),
    );
    const styleGuide = makeGuide();
    const workContext = {
      workId: "work-a",
      chapterId: "chapter-a",
      styleGuide,
      storyMemory: makeMemory(),
      recentPageCount: 6,
    };
    const warnings = createWarningCollector();

    await persistPageContextAfterSuccess(
      {
        page: makePage(),
        pageIndex: 0,
        pageContext: {
          visualSummary: "용사가 문 앞에 선다.",
          glossary: [{ source: "勇者", target: "용사", category: "term" }],
          characters: [],
        },
        collectPageContext: true,
        warningCollector: warnings,
        workContext,
      },
      dependencies,
    );

    expect(workContext.styleGuide).toBe(styleGuide);
    expect(workContext.storyMemory.pages[0]).toMatchObject({
      visualSummary: "용사가 문 앞에 선다.",
      glossaryEntryIds: [],
    });
    expect(
      dependencies.repository.saveChapterStoryMemory,
    ).toHaveBeenCalledOnce();
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      "Cumulative page context save failed",
      expect.objectContaining({ kind: "용어/캐릭터 기억" }),
    );
    expect(warnings.warnings).toEqual([
      expect.stringContaining("용어/캐릭터 기억 저장에 실패했지만"),
    ]);
  });

  it("keeps the approved translation context in memory when page-memory storage fails", async () => {
    const dependencies = makeDependencies();
    dependencies.repository.saveChapterStoryMemory = vi.fn(
      async () => await Promise.reject(new Error("memory disk failure")),
    );
    const workContext = {
      workId: "work-a",
      chapterId: "chapter-a",
      styleGuide: makeGuide(),
      storyMemory: makeMemory(),
      recentPageCount: 6,
    };
    const warnings = createWarningCollector();

    await persistPageContextAfterSuccess(
      {
        page: makePage(),
        pageIndex: 0,
        pageContext: {
          visualSummary: "용사가 문 앞에 선다.",
          glossary: [{ source: "勇者", target: "용사", category: "term" }],
          characters: [],
        },
        collectPageContext: true,
        warningCollector: warnings,
        workContext,
      },
      dependencies,
    );

    expect(workContext.styleGuide.glossary).toEqual([
      expect.objectContaining({ source: "勇者", origin: "ai" }),
    ]);
    expect(workContext.storyMemory.pages).toHaveLength(1);
    expect(dependencies.repository.saveWorkStyleGuide).toHaveBeenCalledOnce();
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      "Cumulative page context save failed",
      expect.objectContaining({ kind: "페이지 기억" }),
    );
    expect(warnings.warnings).toEqual([
      expect.stringContaining("페이지 기억 저장에 실패했지만"),
    ]);
  });
});

function makeDependencies(): {
  repository: PageContextPersistenceRepository;
  logger: PageContextPersistenceLogger;
} {
  return {
    repository: {
      saveChapterStoryMemory: vi.fn(async (memory) => memory),
      saveWorkStyleGuide: vi.fn(async (guide) => guide),
    },
    logger: { warn: vi.fn() },
  };
}

function makeGuide(): WorkStyleGuide {
  return {
    schemaVersion: 1,
    workId: "work-a",
    glossary: [],
    characters: [],
    rules: {
      honorifics: "adapt",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeMemory(): ChapterStoryMemory {
  return {
    schemaVersion: 1,
    workId: "work-a",
    chapterId: "chapter-a",
    pages: [],
    updatedAt: NOW,
  };
}

function makePage(): MangaPage {
  return {
    id: "page-a",
    name: "001.png",
    imagePath: "C:\\images\\001.png",
    dataUrl: "",
    width: 1000,
    height: 1400,
    blocks: [
      {
        id: "block-a",
        type: "nonsolid",
        bbox: { x: 10, y: 10, w: 100, h: 100 },
        sourceText: "勇者",
        translatedText: "용사",
        confidence: 0.95,
        sourceDirection: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 20,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#ffffff",
        opacity: 1,
      },
    ],
    analysisStatus: "completed",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function codexContextFixture() {
  const page = makePage();
  const guide = makeGuide();
  guide.glossary = [
    {
      id: "manual",
      source: "勇者",
      target: "용사님",
      category: "term",
      origin: "manual",
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "disabled",
      source: "幽霊",
      target: "비활성 용어",
      category: "term",
      origin: "manual",
      enabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  const memory = makeMemory();
  memory.pages = [
    {
      ...buildPageStoryMemory({
        page: { ...page, id: "earlier" },
        pageIndex: 2,
      }),
      visualSummary: "지난 장면",
    },
    {
      ...buildPageStoryMemory({
        page: { ...page, id: "future" },
        pageIndex: 9,
      }),
      visualSummary: "아직 읽지 않은 미래 장면",
    },
  ];
  const options: PipelineOptions = {
    jobId: "codex-memory",
    pages: [page],
    runPaths: {} as PipelineOptions["runPaths"],
    emit: vi.fn(),
    signal: new AbortController().signal,
    canonicalPageIndexById: new Map([[page.id, 5]]),
    onPageComplete: vi.fn(async () => true),
    workContext: {
      workId: guide.workId,
      chapterId: memory.chapterId,
      styleGuide: guide,
      storyMemory: memory,
      recentPageCount: 6,
    },
  };
  const reading: CodexPageReading = {
    summary: "용사가 성에 도착했다.",
    regions: [
      {
        id: "one",
        action: "text",
        role: "ordinary",
        sourceText: "勇者は城にいる",
        translatedText: "용사는 성에 있다",
        sourceBbox: page.blocks[0].bbox,
        renderBbox: page.blocks[0].bbox,
        direction: "vertical",
        background: "white",
        reason: "dialogue",
      },
    ],
    memory: {
      glossary: [
        { source: "勇者", target: "용사", category: "term" },
        { source: "城", target: "성", category: "place" },
        { source: "王女", target: "공주", category: "character" },
      ],
      characters: [],
    },
  };
  return { page, reading, options, dependencies: makeDependencies() };
}

describe("Codex terminology and memory", () => {
  it("publishes source and cleaned previews without changing stored page or memory authority", () => {
    const { page, reading, options, dependencies } = codexContextFixture();
    page.inpaintedImagePath = "previous-background.png";
    const before = structuredClone(page);
    const context = createCodexRunContext(options, dependencies);
    context.preview(page, reading, "reading");
    expect(options.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        codexProgress: expect.objectContaining({
          preview: expect.objectContaining({
            imagePath: page.imagePath,
            regions: [
              expect.objectContaining({
                translation: reading.regions[0].translatedText,
              }),
            ],
          }),
        }),
      }),
    );
    context.preview(
      { ...page, inpaintedImagePath: "clean.png" },
      undefined,
      "background",
    );
    expect(options.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        codexProgress: expect.objectContaining({
          preview: expect.objectContaining({
            imagePath: "clean.png",
            regions: [],
          }),
        }),
      }),
    );
    expect(options.onPageComplete).not.toHaveBeenCalled();
    expect(
      dependencies.repository.saveChapterStoryMemory,
    ).not.toHaveBeenCalled();
    expect(page).toEqual(before);
  });

  it("uses the original page context for each independent SFX crop", async () => {
    const { page, reading, options, dependencies } = codexContextFixture();
    const crop = { ...page, id: "crop" };
    options.pages = [crop];
    options.canonicalPageIndexById = undefined;
    options.regionContexts = new Map([
      [
        crop.id,
        {
          sourcePage: page,
          sourcePageIndex: 5,
          cropRect: { x: 1, y: 2, w: 10, h: 20 },
        },
      ],
    ]);
    const context = createCodexRunContext(options, dependencies);
    expect(context.translationContext(crop)).toContain("지난 장면");
    await context.commit(crop, reading);
    expect(
      dependencies.repository.saveChapterStoryMemory,
    ).not.toHaveBeenCalled();
  });
  it("uses enabled terminology and strictly prior memory at the canonical page index", () => {
    const { page, options, dependencies } = codexContextFixture();
    const context = createCodexRunContext(
      options,
      dependencies,
    ).translationContext(page);
    expect(context).toContain("용사님");
    expect(context).toContain("지난 장면");
    expect(context).not.toContain("비활성 용어");
    expect(context).not.toContain("아직 읽지 않은 미래 장면");
    expect(
      dependencies.repository.saveChapterStoryMemory,
    ).not.toHaveBeenCalled();
  });
  it("carries grounded readings forward without persisting early or overwriting manual terms", async () => {
    const { page, reading, options, dependencies } = codexContextFixture();
    const context = createCodexRunContext(options, dependencies);
    context.rememberReading(page, reading);
    const prompt = context.translationContext({ ...page, id: "next" });
    expect(prompt).toContain("용사님");
    expect(prompt).toContain("城");
    expect(prompt).not.toContain("王女");
    expect(dependencies.repository.saveWorkStyleGuide).not.toHaveBeenCalled();
    expect(options.workContext?.styleGuide.glossary).toHaveLength(2);
    const committed = {
      ...page,
      blocks: [
        {
          ...page.blocks[0],
          sourceText: reading.regions[0].sourceText,
          translatedText: reading.regions[0].translatedText,
        },
      ],
    };
    await context.commit(committed, reading);
    expect(options.onPageComplete).toHaveBeenCalledWith(committed);
    expect(dependencies.repository.saveWorkStyleGuide).toHaveBeenCalledWith(
      expect.objectContaining({
        glossary: expect.arrayContaining([
          expect.objectContaining({ source: "城", target: "성" }),
          expect.objectContaining({
            source: "勇者",
            target: "용사님",
            origin: "manual",
          }),
        ]),
      }),
    );
    expect(dependencies.repository.saveChapterStoryMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: expect.arrayContaining([
          expect.objectContaining({ pageId: page.id, pageIndex: 5 }),
        ]),
      }),
    );
  });
  it.each(["rejected", "region", "disabled", "unsaved"] as const)(
    "does not write memory for %s results",
    async (mode) => {
      const { page, reading, options, dependencies } = codexContextFixture();
      if (mode === "rejected") options.onPageComplete = async () => false;
      if (mode === "region")
        options.regionContext = {
          sourcePage: page,
          sourcePageIndex: 5,
          cropRect: { x: 1, y: 1, w: 20, h: 20 },
        };
      if (mode === "disabled") options.writeStoryMemory = false;
      if (mode === "unsaved") options.onPageComplete = undefined;
      await createCodexRunContext(options, dependencies).commit(page, reading);
      expect(dependencies.repository.saveWorkStyleGuide).not.toHaveBeenCalled();
      expect(
        dependencies.repository.saveChapterStoryMemory,
      ).not.toHaveBeenCalled();
    },
  );
});
