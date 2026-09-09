import { throwSoundEffectPhaseErrors } from "../src/main/jobs/soundEffectTranslationResult";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inpaintCreatedSoundEffectBlocks,
  type SoundEffectInpaintingDependencies,
} from "../src/main/jobs/soundEffectTargetedInpainting";
import { maybeInpaintTranslatedSoundEffectBlocks } from "../src/main/jobs/soundEffectTranslationInpainting";
import { handleSoundEffectTranslationJobError } from "../src/main/jobs/soundEffectTranslationJobRunner";
import {
  buildReviewedSoundEffectBlock,
  validateSoundEffectTranslationResponse,
} from "../src/main/jobs/soundEffectTranslationResult";
import {
  countChapterPendingSoundEffectRegions,
  resolveStoredSoundEffectTargets,
} from "../src/main/jobs/soundEffectTranslationTargets";
import { resolveEligiblePatternBlocks } from "../src/main/inpainting/patternBlockEligibility";
import {
  applyDismissedSoundEffectRegion,
  applyResolvedSoundEffectEntries,
} from "../src/main/libraryStore/librarySoundEffectMutations";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { createSoundEffectReviewPageRevision } from "../src/shared/pageRevision";
import {
  RegionAnalysisRequestSchema,
  StartSoundEffectTranslationRequestSchema,
} from "../src/shared/ipcJobSchemas";
import type { SoundEffectReviewRegion } from "../src/shared/soundEffectReview";
import {
  createTempDir,
  requestTranslation,
} from "./helpers/runtimeModelContracts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const promptRuntime =
  require("../src/main/runtime/semantic-ocr/sound-effect-translation.cjs") as {
    buildSoundEffectTranslationPrompt: (
      options: Record<string, unknown>,
    ) => string;
    buildSoundEffectTranslationSystemPrompt: (
      options: Record<string, unknown>,
    ) => string;
  };

const requestBuilders =
  require("../src/main/runtime/simple-page-request-builders.cjs") as {
    buildMessages: (
      options: Record<string, unknown>,
      variants: Array<Record<string, unknown>>,
      prompt?: string,
      systemPrompt?: string,
    ) => Array<{ role: string; content: Array<{ text?: string }> }>;
  };

describe("dedicated sound-effect translation contract", () => {
  it("accepts the dedicated IPC request and rejects the removed generic intent", () => {
    const chapter = makeChapter();
    const page = chapter.pages[0];
    const request = {
      chapterId: chapter.id,
      targets: [
        {
          pageId: page.id,
          pageRevision: createSoundEffectReviewPageRevision(page),
          regionIds: ["FX001"],
        },
      ],
      inpaintAfterTranslation: false,
      autoFontMatching: true,
    };
    expect(StartSoundEffectTranslationRequestSchema.parse(request)).toEqual(
      request,
    );
    expect(
      RegionAnalysisRequestSchema.safeParse({
        chapterId: chapter.id,
        pageId: page.id,
        bbox: { x: 10, y: 20, w: 100, h: 120 },
        intent: "sound-effect-review",
      }).success,
    ).toBe(false);
    expect(
      StartSoundEffectTranslationRequestSchema.safeParse({
        ...request,
        targets: [request.targets[0], request.targets[0]],
      }).success,
    ).toBe(false);
  });

  it("runs targeted inpainting only when the SFX option created blocks", async () => {
    const emit = vi.fn();
    const inpaintCreatedBlocks = vi.fn(async () => ({
      changedPageIds: ["page-1"],
      warnings: ["warning"],
    }));
    const state = {
      createdBlocksByPage: [{ pageId: "page-1", blockIds: ["block-1"] }],
      warnings: [] as string[],
    };
    await maybeInpaintTranslatedSoundEffectBlocks({
      abortController: new AbortController(),
      context: { decodeImage: vi.fn() } as never,
      emit,
      id: "job-1",
      inpaintCreatedBlocks,
      pageTotal: 1,
      request: {
        chapterId: "chapter-1",
        targets: [],
        inpaintAfterTranslation: true,
        autoFontMatching: true,
      },
      state,
    });
    expect(inpaintCreatedBlocks).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "inpainting_running" }),
    );
    expect(state.warnings).toEqual(["warning"]);

    inpaintCreatedBlocks.mockClear();
    await maybeInpaintTranslatedSoundEffectBlocks({
      abortController: new AbortController(),
      context: { decodeImage: vi.fn() } as never,
      emit,
      id: "job-2",
      inpaintCreatedBlocks,
      pageTotal: 1,
      request: {
        chapterId: "chapter-1",
        targets: [],
        inpaintAfterTranslation: false,
      },
      state,
    });
    expect(inpaintCreatedBlocks).not.toHaveBeenCalled();
  });

  it("re-resolves renderer targets from persisted pending candidates", () => {
    const chapter = makeChapter();
    const page = chapter.pages[0];
    const revision = createSoundEffectReviewPageRevision(page);
    const targets = resolveStoredSoundEffectTargets(chapter, {
      chapterId: chapter.id,
      targets: [{ pageId: page.id, pageRevision: revision }],
      inpaintAfterTranslation: false,
    });

    expect(targets[0]?.regions.map((region) => region.id)).toEqual(["FX001"]);
    expect(countChapterPendingSoundEffectRegions(chapter)).toBe(1);
    expect(() =>
      resolveStoredSoundEffectTargets(chapter, {
        chapterId: chapter.id,
        targets: [
          { pageId: page.id, pageRevision: revision, regionIds: ["FX002"] },
        ],
        inpaintAfterTranslation: false,
      }),
    ).toThrow(/pending/u);
    expect(() =>
      resolveStoredSoundEffectTargets(chapter, {
        chapterId: chapter.id,
        targets: [
          { pageId: page.id, pageRevision: "page-v1:0000000000000000" },
        ],
        inpaintAfterTranslation: false,
      }),
    ).toThrow(/변경/u);
  });

  it("keeps chapter page positions for a sparse selection in reverse order", () => {
    const chapter = makeChapter();
    chapter.pages = Array.from({ length: 10 }, (_, index) => ({
      ...makePage(),
      id: `page-${index}`,
      name: `${index}.jpg`,
    }));
    const selected = [chapter.pages[8], chapter.pages[3]];
    const targets = resolveStoredSoundEffectTargets(chapter, {
      chapterId: chapter.id,
      targets: selected.map((page) => ({
        pageId: page.id,
        pageRevision: createSoundEffectReviewPageRevision(page),
      })),
      inpaintAfterTranslation: false,
    });
    expect(targets.map((target) => target.pageIndex)).toEqual([8, 3]);
  });

  it("includes glossary, character, rules, and six-page story context", () => {
    const workContext = {
      styleGuide: {
        glossary: [
          {
            source: "魔王",
            target: "마왕",
            category: "term",
            enabled: true,
          },
        ],
        characters: [
          {
            displayName: "아리",
            targetName: "아리",
            sourceNames: ["アリ"],
            speechStyle: "polite",
            enabled: true,
          },
        ],
        rules: {
          honorifics: "keep",
          sfxMode: "translate",
          defaultTone: "natural_korean",
        },
      },
      storyMemory: {
        pages: Array.from({ length: 7 }, (_, index) => ({
          pageId: `p${index}`,
          pageName: `${index + 1}.png`,
          pageIndex: index,
          visualSummary: `장면-${index}`,
        })),
      },
    };
    const options = {
      targetLanguage: "ko",
      workContext,
      soundEffectTranslationRegions: [
        {
          regionId: "FX001",
          bbox: { x: 10, y: 20, w: 100, h: 120 },
          recognizedText: "ブレないなぁ",
        },
      ],
    };
    const system =
      promptRuntime.buildSoundEffectTranslationSystemPrompt(options);
    const prompt = promptRuntime.buildSoundEffectTranslationPrompt(options);
    expect(prompt).toContain("魔王 => 마왕");
    expect(prompt).toContain("sourceNames=アリ");
    expect(prompt).toContain("honorifics=keep");
    const {
      buildSystemPrompt,
    } = require("../src/main/runtime/prompts/system-prompt.cjs");
    const {
      buildRegionTaskSection,
    } = require("../src/main/runtime/prompts/task-sections.cjs");
    expect(system).toBe(
      buildSystemPrompt({ ...options, regionCropMode: true }),
    );
    for (const line of buildRegionTaskSection()) expect(prompt).toContain(line);
    expect(prompt).toContain("natural Korean comic lettering");
    expect(prompt).not.toContain("장면-0");
    expect(prompt).toContain("장면-6");
    expect(prompt).toContain("regionId=FX001");
    expect(prompt).toContain("ブレないなぁ");
    expect(prompt).toContain("Do not return bbox");

    const messages = requestBuilders.buildMessages(
      options,
      [{ role: "original", dataUrl: "data:image/png;base64,AA==" }],
      prompt,
      system,
    );
    expect(messages[0]?.content[0]?.text).toBe(system);
    expect(messages[1]?.content.at(-1)?.text).toBe(prompt);
  });

  it("keeps non-Korean guidance neutral and marks missing or invalid OCR as optional", () => {
    const baseOptions = {
      targetLanguage: "en",
      soundEffectTranslationRegions: [
        {
          regionId: "FX001",
          bbox: { x: 10, y: 20, w: 100, h: 120 },
          detectorConfidence: Number.NaN,
        },
      ],
    };
    const system = promptRuntime.buildSoundEffectTranslationSystemPrompt({
      ...baseOptions,
      targetLanguage: "en",
    });
    const emptyOcrPrompt =
      promptRuntime.buildSoundEffectTranslationPrompt(baseOptions);
    const punctuationOcrPrompt =
      promptRuntime.buildSoundEffectTranslationPrompt({
        ...baseOptions,
        soundEffectTranslationRegions: [
          {
            ...baseOptions.soundEffectTranslationRegions[0],
            recognizedText: "!!",
          },
        ],
      });
    expect(system).not.toContain("Korean");
    expect(emptyOcrPrompt).toContain("natural English comic lettering");
    expect(emptyOcrPrompt).not.toContain("Korean");
    expect(emptyOcrPrompt).toContain("NONE (read the image yourself)");
    expect(emptyOcrPrompt).toContain("detectorConfidence=0");
    expect(punctuationOcrPrompt).toContain("IGNORE: no Japanese script");
  });

  it("uses one marked context plus one target crop even when ordinary OCR is empty", async () => {
    const outputDir = createTempDir("sound-effect-request-");
    const contextPath = join(outputDir, "marked-page-context.png");
    const cropPath = join(outputDir, "target-crop.png");
    writeFileSync(contextPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(cropPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    items: [
                      {
                        regionId: "FX001",
                        verdict: "sound",
                        confirmedSource: "ドン",
                        translation: "쿵",
                        confidence: 0.95,
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    const result = await requestTranslation(
      { baseUrl: "http://127.0.0.1:18180/v1" },
      {
        label: "sound-effect-page",
        modelProvider: "gemma",
        modelRepo: "test/gemma",
        modelFile: "gemma.gguf",
        sourceLanguage: "ja",
        targetLanguage: "ko",
        imagePath: cropPath,
        regionCropMode: true,
        regionContextImagePath: contextPath,
        regionContextImageWidth: 1000,
        regionContextImageHeight: 1000,
        outputDir,
        imageWidth: 700,
        imageHeight: 500,
        ocrBboxHints: [],
        includeEnhancedVariant: false,
        maxTokens: 1024,
        temperature: 0.2,
        topP: 0.95,
        topK: 64,
        translationAttempt: 1,
        disableUnused49LogitBias: true,
        soundEffectTranslationMode: true,
        soundEffectTranslationRegions: [
          {
            regionId: "FX001",
            bbox: { x: 10, y: 20, w: 100, h: 120 },
            recognizedText: "ドン",
            detectorConfidence: 0.9,
          },
        ],
        soundEffectTargetMarker: "cyan-fill-magenta-outline-v1",
      },
    );

    expect(JSON.parse(result.outputText)).toMatchObject({
      items: [{ regionId: "FX001", translation: "쿵" }],
    });
    expect(result.requestBody).toMatchObject({
      soundEffectTranslationContractVersion: 3,
      soundEffectTranslationRegionIds: ["FX001"],
      noTextDetected: true,
    });
    const messages = (
      requestBody as {
        messages?: Array<{ content: Array<{ type: string; text?: string }> }>;
      }
    )?.messages;
    const imageDescriptions = messages
      ?.flatMap((message) => message.content)
      .filter((part) => part.type === "text" && part.text?.startsWith("Image "))
      .map((part) => part.text);
    expect(imageDescriptions?.[0]).toContain("Image 1:");
    expect(imageDescriptions?.[0]).toContain("crop");
    expect(imageDescriptions?.[1]).toContain("Image 2:");
    expect(imageDescriptions?.[1]).toContain("full manga page");
    const serialized = JSON.stringify(requestBody);
    expect(serialized).toContain("regionId=FX001");
    expect(serialized).toContain("translucent cyan");
    expect(serialized).toContain("enlarged high-detail crop");
    expect(serialized).toContain('optionalHayaiOcrHint=\\"ドン\\"');
    expect(serialized).toContain("independent reading; reconcile");
    expect(serialized).not.toContain("fixedBlocks=");
  });

  it("validates fixed ids and OCR anchors, then keeps detector geometry", () => {
    const regions = [
      effect("FX001", "ドン", { x: 10, y: 20, w: 100, h: 120 }),
      effect("FX002", "ブレないなぁ", { x: 300, y: 50, w: 140, h: 80 }),
    ];
    const result = validateSoundEffectTranslationResponse(
      {
        items: [
          {
            regionId: "FX001",
            verdict: "sound",
            confirmedSource: "ドン",
            translation: "쿵",
            confidence: 0.93,
          },
          {
            regionId: "FX002",
            verdict: "reaction",
            confirmedSource: "ブレないなぁ",
            translation: "한결같네",
            confidence: 0.88,
          },
        ],
      },
      regions,
      "ko",
    );
    expect(result.retryRegionIds).toEqual([]);
    expect(result.valid.map((item) => item.verdict)).toEqual([
      "sound",
      "reaction",
    ]);

    const block = buildReviewedSoundEffectBlock(
      makeChapter().pages[0],
      regions[0],
      result.valid[0],
      "job-1",
      0,
    );
    expect(block).toMatchObject({
      bbox: regions[0].bbox,
      sourceText: "ドン",
      translatedText: "쿵",
      textRole: "sound",
      autoFitText: true,
    });
    expect(block).not.toHaveProperty("reviewStatus");
    expect(block).not.toHaveProperty("inpaintExcluded");
  });

  it("rejects model-created geometry or other fields outside the fixed contract", () => {
    const regions = [effect("FX001", "ドン", { x: 10, y: 20, w: 100, h: 120 })];
    const result = validateSoundEffectTranslationResponse(
      {
        items: [
          {
            regionId: "FX001",
            verdict: "sound",
            confirmedSource: "ドン",
            translation: "쿵",
            confidence: 0.93,
            bbox: { x: 0, y: 0, w: 900, h: 900 },
          },
        ],
      },
      regions,
      "ko",
    );
    expect(result.valid).toEqual([]);
    expect(result.retryRegionIds).toEqual(["FX001"]);
  });

  it.each([
    ["zh-Hans", "轰隆！"],
    ["zh-Hant", "轟隆！"],
    ["ko", "쾅"],
    ["en", "BANG"],
  ])(
    "accepts a valid %s SFX target without a special SFX language override",
    (language, text) => {
      const region = effect("FX001", "ドン", { x: 10, y: 20, w: 100, h: 120 });
      {
        const result = validateSoundEffectTranslationResponse(
          { items: [sfxResponse(region.id, "ドン", text)] },
          [region],
          language,
        );
        expect(result.retryRegionIds).toEqual([]);
        expect(result.valid).toEqual([
          expect.objectContaining({ regionId: region.id, translation: text }),
        ]);
        expect(
          buildReviewedSoundEffectBlock(
            makePage(),
            region,
            result.valid[0],
            "language-regression",
            0,
          ).translatedText,
        ).toBe(text);
      }
    },
  );

  it.each([
    ["zh-Hans", "轰ドン"],
    ["zh-Hant", "轟どん"],
    ["ko", "轟隆"],
    ["en", "轰隆"],
    ["ko", "ドン"],
    ["en", "どん"],
  ])(
    "keeps unintended Japanese residue pending for %s (%s)",
    (language, text) => {
      const region = effect("FX001", "ドン", { x: 10, y: 20, w: 100, h: 120 });
      {
        const result = validateSoundEffectTranslationResponse(
          { items: [sfxResponse(region.id, "ドン", text)] },
          [region],
          language,
        );
        expect(result.valid).toEqual([]);
        expect(result.retryRegionIds).toEqual([region.id]);
      }
    },
  );

  it("trusts direct visual reading over OCR but retries duplicate or invalid-language ids", () => {
    const regions = [
      effect("FX001", "ドン", { x: 10, y: 20, w: 100, h: 120 }),
      effect("FX002", "ガタン", { x: 200, y: 20, w: 100, h: 120 }),
      effect("FX003", "キラ", { x: 400, y: 20, w: 100, h: 120 }),
    ];
    const result = validateSoundEffectTranslationResponse(
      {
        items: [
          {
            regionId: "FX001",
            verdict: "sound",
            confirmedSource: "ガラガラ",
            translation: "우르릉",
            confidence: 0.9,
          },
          {
            regionId: "FX002",
            verdict: "sound",
            confirmedSource: "ガタン",
            translation: "쿵",
            confidence: 0.9,
          },
          {
            regionId: "FX002",
            verdict: "sound",
            confirmedSource: "ガタン",
            translation: "덜컹",
            confidence: 0.9,
          },
          {
            regionId: "FX003",
            verdict: "sound",
            confirmedSource: "キラ",
            translation: "キラ",
            confidence: 0.9,
          },
        ],
      },
      regions,
      "ko",
    );
    expect(result.valid).toEqual([
      expect.objectContaining({
        regionId: "FX001",
        confirmedSource: "ガラガラ",
        translation: "우르릉",
      }),
    ]);
    expect(result.retryRegionIds).toEqual(["FX002", "FX003"]);
    expect(result.warnings.join("\n")).toContain("이미지에서 읽은 원문을 사용");
  });

  it.each([
    null,
    [],
    {},
    { items: null },
    { items: [] },
    { items: [null, [], "bad"] },
    { items: [{}] },
  ])("keeps candidates pending for an unusable response %j", (payload) => {
    const region = effect("FX001", "ドン", { x: 10, y: 20, w: 100, h: 120 });
    const result = validateSoundEffectTranslationResponse(
      payload,
      [region],
      "ko",
    );
    expect(result.valid).toEqual([]);
    expect(result.retryRegionIds).toEqual([region.id]);
    expect(result.warnings.join(" ")).toContain("누락");
  });

  it.each([
    { confidence: -0.1 },
    { confidence: 1.1 },
    { confidence: "invalid" },
    { regionId: "" },
    { regionId: "not-requested" },
    { verdict: null },
    { verdict: "ordinary" },
    { confirmedSource: null },
    { confirmedSource: "!!" },
    { translation: null },
    { translation: "가".repeat(121) },
    { translation: "BANG" },
    { verdict: "uncertain", translation: "" },
    { verdict: "uncertain", translation: "쿵" },
  ])("keeps invalid or uncertain SFX pending: %j", (override) => {
    const region = effect("FX001", "ドン", { x: 10, y: 20, w: 100, h: 120 });
    const result = validateSoundEffectTranslationResponse(
      {
        items: [{ ...sfxResponse(region.id, "ドン", "쿵"), ...override }],
      },
      [region],
      "ko",
    );
    expect(result.valid).toEqual([]);
    expect(result.retryRegionIds).toEqual([region.id]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it.each([undefined, "", "!!"])(
    "accepts image reading when OCR has no usable hint (%s)",
    (hint) => {
      const region = {
        ...effect("FX001", "ドン", { x: 10, y: 20, w: 100, h: 120 }),
        recognizedText: hint,
      };
      const result = validateSoundEffectTranslationResponse(
        {
          items: [sfxResponse(region.id, "ドン", "쿵")],
        },
        [region],
        "ko-KR",
      );
      expect(result.valid[0]?.confirmedSource).toBe("ドン");
      expect(result.retryRegionIds).toEqual([]);
      expect(result.warnings).toEqual([]);
    },
  );

  it("preserves retry evidence and target identity when localizing the prompt", () => {
    const prompt = promptRuntime.buildSoundEffectTranslationPrompt({
      targetLanguage: "en",
      translationAttempt: 2,
      soundEffectRetryFeedback: "번역문이\n비어 있습니다.",
      soundEffectTranslationRegions: [
        { regionId: "ko", recognizedText: "ドン" },
      ],
    });
    expect(prompt).toContain("- Validation failure: 번역문이 비어 있습니다.");
    expect(prompt).toContain("regionId=ko");
    expect(prompt).toContain("Read Image 1 again");
  });

  it.each([undefined, [], [null], [{ bbox: [] }]])(
    "handles incomplete target metadata without inventing OCR (%j)",
    (regions) => {
      const prompt = promptRuntime.buildSoundEffectTranslationPrompt({
        translationAttempt: 2,
        soundEffectTranslationRegions: regions,
      });
      expect(prompt).toContain("bbox=0,0,0,0");
      expect(prompt).toContain("NONE (read the image yourself)");
      expect(prompt).not.toContain("Validation failure:");
    },
  );

  it("does not override scene-dependent translations with a fixed word dictionary", () => {
    const region = effect("FX001", "ブンブン", {
      x: 10,
      y: 20,
      w: 100,
      h: 120,
    });
    for (const translation of ["부릉부릉", "붕붕", "윙윙"]) {
      const result = validateSoundEffectTranslationResponse(
        { items: [sfxResponse(region.id, "ブンブン", translation)] },
        [region],
        "ko",
      );
      expect(result.valid[0]?.translation).toBe(translation);
      expect(result.retryRegionIds).toEqual([]);
    }
  });

  it("returns stable cancelled and failed results from the SFX job boundary", async () => {
    const chapter = makeChapter();
    const request = {
      chapterId: chapter.id,
      targets: [],
      inpaintAfterTranslation: false,
    };
    const state = {
      chapter: null,
      createdBlocksByPage: [],
      translatedRegionCount: 0,
      warnings: [] as string[],
    };
    const openChapter = vi.fn(async () => chapter);
    const emit = vi.fn();
    const abortController = new AbortController();
    abortController.abort();
    const cancelled = await handleSoundEffectTranslationJobError({
      abortController,
      emit,
      error: new DOMException("cancelled", "AbortError"),
      id: "sfx-cancelled",
      request,
      state,
      context: {
        jobs: { current: { lastEvent: { pageTotal: 3 } } },
      } as never,
      dependencies: { openChapter } as never,
    });
    expect(cancelled).toMatchObject({ status: "cancelled", chapter });

    const failed = await handleSoundEffectTranslationJobError({
      abortController: new AbortController(),
      emit,
      error: new Error("model failed"),
      id: "sfx-failed",
      request,
      state,
      context: { jobs: { current: null } } as never,
      dependencies: { openChapter } as never,
    });
    expect(failed).toMatchObject({ status: "failed", error: "model failed" });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sfx-failed", status: "failed" }),
    );
  });

  it("accepts image-read Japanese when Hayai OCR has no source text", () => {
    const region = effect("FX001", "", { x: 10, y: 20, w: 100, h: 120 });
    const result = validateSoundEffectTranslationResponse(
      {
        items: [
          {
            regionId: "FX001",
            verdict: "sound",
            confirmedSource: "ズドン",
            translation: "쿠웅",
            confidence: 0.86,
          },
        ],
      },
      [region],
      "ko",
    );
    expect(result.retryRegionIds).toEqual([]);
    expect(result.valid[0]).toMatchObject({
      confirmedSource: "ズドン",
      translation: "쿠웅",
    });
  });

  it("builds one inpainting selection from only the newly created SFX ids", () => {
    const page = makePage();
    page.blocks = [
      makeBlock("dialogue", false),
      makeBlock("sfx-new-1", false),
      makeBlock("sfx-new-2", false),
      makeBlock("sfx-old", true),
    ];
    page.inpaintedImagePath = "C:/manga/dialogue-clean.png";
    page.translationCompletion = {
      workflow: "bubble-layout",
      status: "pending",
      erasedBlockIds: ["dialogue"],
    };
    expect(
      resolveEligiblePatternBlocks(page, undefined, undefined, [
        "sfx-new-1",
        "sfx-new-2",
      ]).map((block) => block.id),
    ).toEqual(["sfx-new-1", "sfx-new-2"]);
  });

  it("appends blocks and resolution records together while preserving detector audit data", () => {
    const page = makePage();
    const block = makeBlock("sfx-new", true);
    const updated = applyResolvedSoundEffectEntries(
      page,
      [{ regionId: "FX001", block }],
      TS,
    );
    expect(updated.blocks.map((candidate) => candidate.id)).toEqual([
      "sfx-new",
    ]);
    expect(updated.soundEffectReview?.regions).toEqual(
      page.soundEffectReview?.regions,
    );
    expect(updated.soundEffectReview?.resolvedRegions).toEqual([
      { regionId: "FX003", blockId: "block-3", resolvedAt: TS },
      { regionId: "FX001", blockId: "sfx-new", resolvedAt: TS },
    ]);

    const dismissed = applyDismissedSoundEffectRegion(page, "FX001", TS);
    expect(dismissed.soundEffectReview?.regions).toEqual(
      page.soundEffectReview?.regions,
    );
    expect(dismissed.soundEffectReview?.dismissedRegionIds).toEqual([
      "FX002",
      "FX001",
    ]);
  });

  it("keeps prior erased ids while a new SFX waits for additive inpainting", () => {
    const page = makePage();
    page.blocks = [makeBlock("dialogue", false)];
    page.translationCompletion = {
      workflow: "bubble-layout",
      status: "completed",
      erasedBlockIds: ["dialogue"],
    };

    const updated = applyResolvedSoundEffectEntries(
      page,
      [{ regionId: "FX001", block: makeBlock("sfx-new", false) }],
      TS,
    );

    expect(updated.translationCompletion).toEqual({
      workflow: "bubble-layout",
      status: "pending",
      erasedBlockIds: ["dialogue"],
    });
  });

  it("runs one integrated inpainting call per page using only new SFX blocks", async () => {
    const page = makePage();
    page.blocks = [
      makeBlock("dialogue", false),
      makeBlock("sfx-new-1", false),
      makeBlock("sfx-new-2", false),
      makeBlock("sfx-old", true),
    ];
    page.inpaintedImagePath = "C:/manga/dialogue-clean.png";
    page.translationCompletion = {
      workflow: "bubble-layout",
      status: "pending",
      erasedBlockIds: ["dialogue"],
    };
    const chapter = { ...makeChapter(), pages: [page] };
    const release = vi.fn();
    const updatePages = vi.fn(async () => chapter);
    const inpaintPage = vi.fn(
      async (
        inputPage: MangaPage,
        options: { blockIds?: readonly string[] },
      ) => ({
        page: { ...inputPage, inpaintedImagePath: "C:/manga/inpainted.png" },
        blocksErased: options.blockIds?.length ?? 0,
        erasedBlockIds: [...(options.blockIds ?? [])],
      }),
    );
    const result = await inpaintCreatedSoundEffectBlocks(
      chapter.id,
      [{ pageId: page.id, blockIds: ["sfx-new-1", "sfx-new-2"] }],
      vi.fn() as never,
      new AbortController().signal,
      {
        getAppPaths: () => ({}) as never,
        getAppSettings: async () => ({ inpainting: {} }) as never,
        acquireEngine: async () =>
          ({ engine: { model: "flux-klein" }, release }) as never,
        openChapter: async () => chapter,
        inpaintPage,
        updatePages,
      } as SoundEffectInpaintingDependencies,
    );

    expect(inpaintPage).toHaveBeenCalledOnce();
    expect(inpaintPage).toHaveBeenCalledWith(
      page,
      expect.objectContaining({
        blockIds: ["sfx-new-1", "sfx-new-2"],
        preserveExistingInpainting: true,
      }),
    );
    expect(updatePages).toHaveBeenCalledWith(chapter.id, [
      expect.objectContaining({
        inpaintedImagePath: "C:/manga/inpainted.png",
        translationCompletion: {
          workflow: "bubble-layout",
          status: "completed",
          erasedBlockIds: ["dialogue", "sfx-new-1", "sfx-new-2"],
        },
      }),
    ]);
    expect(result).toEqual({ changedPageIds: [page.id], warnings: [] });
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps a page without a prior completion receipt receipt-free", async () => {
    const page = makePage();
    page.blocks = [makeBlock("sfx-new", false)];
    const chapter = { ...makeChapter(), pages: [page] };
    let persisted: MangaPage | undefined;
    const updatePages = vi.fn(
      async (_chapterId: string, pages: MangaPage[]) => {
        persisted = pages[0];
        return chapter;
      },
    );

    await inpaintCreatedSoundEffectBlocks(
      chapter.id,
      [{ pageId: page.id, blockIds: ["sfx-new"] }],
      vi.fn() as never,
      new AbortController().signal,
      {
        getAppPaths: () => ({}) as never,
        getAppSettings: async () => ({ inpainting: {} }) as never,
        acquireEngine: async () =>
          ({ engine: { model: "flux-klein" }, release: vi.fn() }) as never,
        openChapter: async () => chapter,
        inpaintPage: async (inputPage: MangaPage) => ({
          page: {
            ...inputPage,
            inpaintedImagePath: "C:/manga/sfx-clean.png",
          },
          blocksErased: 1,
          erasedBlockIds: ["sfx-new"],
        }),
        updatePages,
      } as SoundEffectInpaintingDependencies,
    );

    expect(persisted?.inpaintedImagePath).toBe("C:/manga/sfx-clean.png");
    expect(persisted).not.toHaveProperty("translationCompletion");
  });

  it("keeps completion pending while an eligible dialogue block remains", async () => {
    const page = makePage();
    page.blocks = [
      makeBlock("dialogue-not-erased", false),
      makeBlock("sfx-new", false),
    ];
    page.translationCompletion = {
      workflow: "bubble-layout",
      status: "pending",
    };
    const chapter = { ...makeChapter(), pages: [page] };
    let persisted: MangaPage | undefined;
    const updatePages = vi.fn(
      async (_chapterId: string, pages: MangaPage[]) => {
        persisted = pages[0];
        return chapter;
      },
    );

    await inpaintCreatedSoundEffectBlocks(
      chapter.id,
      [{ pageId: page.id, blockIds: ["sfx-new"] }],
      vi.fn() as never,
      new AbortController().signal,
      {
        getAppPaths: () => ({}) as never,
        getAppSettings: async () => ({ inpainting: {} }) as never,
        acquireEngine: async () =>
          ({ engine: { model: "flux-klein" }, release: vi.fn() }) as never,
        openChapter: async () => chapter,
        inpaintPage: async (inputPage: MangaPage) => ({
          page: inputPage,
          blocksErased: 1,
          erasedBlockIds: ["sfx-new"],
        }),
        updatePages,
      } as SoundEffectInpaintingDependencies,
    );

    expect(persisted?.translationCompletion).toEqual({
      workflow: "bubble-layout",
      status: "pending",
      erasedBlockIds: ["sfx-new"],
    });
  });

  it("keeps translated blocks when targeted inpainting fails", async () => {
    const page = makePage();
    page.blocks = [makeBlock("sfx-new", true)];
    const chapter = { ...makeChapter(), pages: [page] };
    const updatePages = vi.fn();
    const result = await inpaintCreatedSoundEffectBlocks(
      chapter.id,
      [{ pageId: page.id, blockIds: ["sfx-new"] }],
      vi.fn() as never,
      new AbortController().signal,
      {
        getAppPaths: () => ({}) as never,
        getAppSettings: async () => ({ inpainting: {} }) as never,
        acquireEngine: async () =>
          ({ engine: { model: "flux-klein" }, release: vi.fn() }) as never,
        openChapter: async () => chapter,
        inpaintPage: async () => {
          throw new Error("engine exploded");
        },
        updatePages,
      } as SoundEffectInpaintingDependencies,
    );

    expect(result.changedPageIds).toEqual([]);
    expect(result.warnings.join("\n")).toContain("engine exploded");
    expect(updatePages).not.toHaveBeenCalled();
    expect(page.blocks[0]).toMatchObject({
      id: "sfx-new",
      inpaintExcluded: true,
      translatedText: "쿵",
    });
  });
});

const TS = "2026-09-01T00:00:00.000Z";

function makeChapter(): ChapterSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workId: "00000000-0000-4000-8000-000000000002",
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: ["00000000-0000-4000-8000-000000000003"],
    pages: [makePage()],
    createdAt: TS,
    updatedAt: TS,
  };
}

function makePage(): MangaPage {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    name: "001.png",
    imagePath: "C:/manga/001.png",
    dataUrl: "data:image/png;base64,",
    width: 1000,
    height: 1000,
    blocks: [],
    soundEffectReview: {
      contractVersion: 3,
      producer: "hayai-regions-v1",
      regionOverrides: [],
      manualRegions: [],
      regions: [
        effect("FX001", "ドン", { x: 10, y: 20, w: 100, h: 120 }),
        effect("FX002", "ガタン", { x: 200, y: 20, w: 100, h: 120 }),
        effect("FX003", "キラ", { x: 400, y: 20, w: 100, h: 120 }),
      ],
      resolvedRegions: [
        { regionId: "FX003", blockId: "block-3", resolvedAt: TS },
      ],
      dismissedRegionIds: ["FX002"],
    },
    analysisStatus: "completed",
    createdAt: TS,
    updatedAt: TS,
  };
}

function effect(
  id: string,
  recognizedText: string,
  bbox: SoundEffectReviewRegion["bbox"],
): SoundEffectReviewRegion {
  return { id, recognizedText, bbox, detectorConfidence: 0.9 };
}

function sfxResponse(
  regionId: string,
  confirmedSource: string,
  translation: string,
) {
  return {
    regionId,
    verdict: "sound",
    confirmedSource,
    translation,
    confidence: 0.99,
  };
}

function makeBlock(id: string, inpaintExcluded: boolean) {
  return {
    id,
    type: "nonsolid" as const,
    bbox: { x: 10, y: 20, w: 100, h: 120 },
    sourceText: "ドン",
    translatedText: "쿵",
    confidence: 0.9,
    sourceDirection: "vertical" as const,
    renderDirection: "vertical" as const,
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center" as const,
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 0,
    inpaintExcluded,
  };
}

it("surfaces translation and persistence failures together without dropping either cause", () => {
  const translation = new Error("translation failed");
  const saving = new Error("save failed");
  expect(() => throwSoundEffectPhaseErrors(translation, undefined)).toThrow(
    translation,
  );
  expect(() => throwSoundEffectPhaseErrors(undefined, saving)).toThrow(saving);
  expect(() => throwSoundEffectPhaseErrors(undefined, undefined)).not.toThrow();
  try {
    throwSoundEffectPhaseErrors(translation, saving);
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([translation, saving]);
  }
});
