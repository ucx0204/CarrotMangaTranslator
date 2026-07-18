import { describe, expect, it } from "vitest";
import {
  ApplyInpaintingHistoryTransactionRequestSchema,
  AppSettingsSchema,
  AnalyzeWorkContextRequestSchema,
  ChapterSnapshotSchema,
  JobEventSchema,
  ModelTestProgressEventSchema,
  parseIpcPayload,
  ReleaseInpaintingHistoryTransactionsRequestSchema,
  SavePageBlocksRequestSchema,
  StartAnalysisRequestSchema,
  StartInpaintingRequestSchema,
  TranslationBlockSchema,
  WorkShareImportRequestSchema,
} from "../src/shared/ipcSchemas";
import { MAX_MAX_TOKENS } from "../src/shared/modelPresets";

const workId = "11111111-1111-4111-8111-111111111111";
const chapterId = "22222222-2222-4222-8222-222222222222";
const pageId = "33333333-3333-4333-8333-333333333333";

describe("IPC schemas", () => {
  it("rejects forged ids before IPC handlers reach filesystem paths", () => {
    expect(() =>
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId: "../outside", runMode: "all" },
        "번역 작업",
      ),
    ).toThrow(/요청 형식/);
  });

  it("requires pageId only for single-page analysis", () => {
    expect(
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "pending" },
        "번역 작업",
      ).runMode,
    ).toBe("pending");
    expect(
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "all" },
        "번역 작업",
      ).runMode,
    ).toBe("all");
    expect(() =>
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "single-page" },
        "번역 작업",
      ),
    ).toThrow(/요청 형식/);
    const parsed = parseIpcPayload(
      StartAnalysisRequestSchema,
      { chapterId, runMode: "single-page", pageId },
      "번역 작업",
    );
    expect(parsed.runMode).toBe("single-page");
    if (parsed.runMode !== "single-page") {
      throw new Error("single-page request was not parsed as single-page");
    }
    expect(parsed.pageId).toBe(pageId);
  });

  it("accepts an optional keep-blocks mode for analysis requests", () => {
    expect(
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "all", blockMode: "keep" },
        "번역 작업",
      ).blockMode,
    ).toBe("keep");
    expect(
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "single-page", pageId, blockMode: "auto" },
        "번역 작업",
      ).blockMode,
    ).toBe("auto");
    expect(() =>
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "pending", blockMode: "merge" },
        "번역 작업",
      ),
    ).toThrow(/요청 형식/);
  });

  it("accepts a bounded page-set analysis request and rejects malformed ones", () => {
    const parsed = parseIpcPayload(
      StartAnalysisRequestSchema,
      { chapterId, runMode: "page-set", pageIds: [pageId] },
      "번역 작업",
    );
    expect(parsed.runMode).toBe("page-set");
    if (parsed.runMode !== "page-set") {
      throw new Error("page-set request was not parsed as page-set");
    }
    expect(parsed.pageIds).toEqual([pageId]);

    expect(() =>
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "page-set", pageIds: [] },
        "번역 작업",
      ),
    ).toThrow(/요청 형식/);

    expect(() =>
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "page-set", pageIds: ["../escape"] },
        "번역 작업",
      ),
    ).toThrow(/요청 형식/);

    expect(() =>
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "page-set", pageIds: [pageId], pageId },
        "번역 작업",
      ),
    ).toThrow(/요청 형식/);
  });

  it("accepts a base page timestamp for conflict-aware block saves", () => {
    const parsed = parseIpcPayload(
      SavePageBlocksRequestSchema,
      {
        chapterId,
        pageId,
        baseUpdatedAt: "2026-01-01T00:00:00.000Z",
        baseBlocksHash: "0123456789abcdef",
        dirtyVersion: 3,
        saveReason: "autosave",
        blocks: makeChapterSnapshot().pages[0].blocks,
      },
      "페이지 블록 저장",
    );
    expect(parsed.baseUpdatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.baseBlocksHash).toBe("0123456789abcdef");
    expect(parsed.dirtyVersion).toBe(3);
    expect(parsed.saveReason).toBe("autosave");
  });

  it("accepts rotation, perspective, and curve data in autosave payloads", () => {
    const block = {
      ...makeChapterSnapshot().pages[0].blocks[0],
      rotationDeg: -135,
      perspectiveTransform: {
        version: 1,
        corners: [
          { x: 0.1, y: 0 },
          { x: 0.9, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
      },
      curveLayout: {
        version: 1,
        path: {
          type: "quadratic",
          start: { x: 0, y: 0.5 },
          control: { x: 0.5, y: -0.2 },
          end: { x: 1, y: 0.5 },
        },
        alignment: "center",
        offsetEm: 0,
        orientation: "tangent",
      },
    };
    const parsed = parseIpcPayload(
      SavePageBlocksRequestSchema,
      {
        chapterId,
        pageId,
        dirtyVersion: 1,
        saveReason: "autosave",
        blocks: [block],
      },
      "페이지 블록 저장",
    );

    expect(parsed.blocks[0].rotationDeg).toBe(-135);
    expect(parsed.blocks[0].perspectiveTransform?.version).toBe(1);
    expect(parsed.blocks[0].curveLayout?.path.type).toBe("quadratic");
  });

  it("accepts bounded AI work context analysis requests", () => {
    const parsed = parseIpcPayload(
      AnalyzeWorkContextRequestSchema,
      { chapterId, maxInputChars: 12000 },
      "AI 용어/기억 분석",
    );
    expect(parsed.chapterId).toBe(chapterId);
    expect(parsed.maxInputChars).toBe(12000);
    expect(() =>
      parseIpcPayload(
        AnalyzeWorkContextRequestSchema,
        { chapterId: "../outside" },
        "AI 용어/기억 분석",
      ),
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(
        AnalyzeWorkContextRequestSchema,
        { chapterId, maxInputChars: 999 },
        "AI 용어/기억 분석",
      ),
    ).toThrow(/요청 형식/);
  });

  it("rejects unknown fields in full chapter snapshots", () => {
    const payload = makeChapterSnapshot();
    expect(() =>
      parseIpcPayload(
        ChapterSnapshotSchema,
        {
          ...payload,
          pages: [
            {
              ...payload.pages[0],
              unexpected: "renderer should not be able to persist this",
            },
          ],
        },
        "화 저장",
      ),
    ).toThrow(/요청 형식/);
  });

  it("accepts a valid share import command but keeps package ids bounded strings", () => {
    const parsed = parseIpcPayload(
      WorkShareImportRequestSchema,
      {
        previewId: "44444444-4444-4444-8444-444444444444",
        target: { mode: "existing", workId },
        entries: [
          {
            source: "package",
            packageChapterId: "chapter-in-package",
            title: "1화",
          },
        ],
      },
      "공유 파일 가져오기",
    );
    expect(parsed.entries[0]?.source).toBe("package");
  });

  it("rejects file paths in share import commands after preview sessions are created", () => {
    expect(() =>
      parseIpcPayload(
        WorkShareImportRequestSchema,
        {
          previewId: "44444444-4444-4444-8444-444444444444",
          packagePath: "C:\\temp\\sample.mgtshare",
          target: { mode: "existing", workId },
          entries: [],
        },
        "공유 파일 가져오기",
      ),
    ).toThrow(/요청 형식/);
  });

  it("bounds drawn inpainting masks to runtime stroke limits", () => {
    const point = { x: 1, y: 1 };
    const validStroke = {
      radiusPx: 12,
      points: Array.from({ length: 1200 }, () => point),
    };

    const parsed = parseIpcPayload(
      StartInpaintingRequestSchema,
      {
        chapterId,
        mode: "page-pattern-drawn",
        pageId,
        strokes: Array.from({ length: 200 }, () => validStroke),
      },
      "인페인팅 작업",
    );
    expect(parsed.mode).toBe("page-pattern-drawn");
    expect(
      parsed.mode === "page-pattern-drawn" ? parsed.strokes : [],
    ).toHaveLength(200);

    expect(() =>
      parseIpcPayload(
        StartInpaintingRequestSchema,
        {
          chapterId,
          mode: "page-pattern-drawn",
          pageId,
          strokes: Array.from({ length: 201 }, () => validStroke),
        },
        "인페인팅 작업",
      ),
    ).toThrow(/요청 형식/);

    expect(() =>
      parseIpcPayload(
        StartInpaintingRequestSchema,
        {
          chapterId,
          mode: "page-pattern-drawn",
          pageId,
          strokes: [
            { radiusPx: 12, points: Array.from({ length: 1201 }, () => point) },
          ],
        },
        "인페인팅 작업",
      ),
    ).toThrow(/요청 형식/);
  });

  it("accepts bounded multi-chapter automatic inpainting selections", () => {
    const otherChapterId = "44444444-4444-4444-8444-444444444444";
    const otherPageId = "55555555-5555-4555-8555-555555555555";
    const parsed = parseIpcPayload(
      StartInpaintingRequestSchema,
      {
        mode: "selection-pattern",
        workId,
        selections: [
          { chapterId, mode: "all" },
          {
            chapterId: otherChapterId,
            mode: "page-set",
            pageIds: [pageId, otherPageId],
          },
        ],
      },
      "인페인팅 작업",
    );

    expect(parsed.mode).toBe("selection-pattern");
    expect(
      parsed.mode === "selection-pattern" ? parsed.selections : [],
    ).toHaveLength(2);
    expect(() =>
      parseIpcPayload(
        StartInpaintingRequestSchema,
        { mode: "selection-pattern", workId, selections: [] },
        "인페인팅 작업",
      ),
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(
        StartInpaintingRequestSchema,
        {
          mode: "selection-pattern",
          workId,
          selections: [{ chapterId, mode: "page-set", pageIds: [] }],
        },
        "인페인팅 작업",
      ),
    ).toThrow(/요청 형식/);
  });

  it("validates opaque inpainting history transaction commands", () => {
    const transactionId = "66666666-6666-4666-8666-666666666666";
    expect(
      parseIpcPayload(
        ApplyInpaintingHistoryTransactionRequestSchema,
        { transactionId, direction: "undo" },
        "인페인팅 기록",
      ),
    ).toEqual({ transactionId, direction: "undo" });
    expect(
      parseIpcPayload(
        ReleaseInpaintingHistoryTransactionsRequestSchema,
        { transactionIds: [transactionId] },
        "인페인팅 기록",
      ).transactionIds,
    ).toEqual([transactionId]);
    expect(() =>
      parseIpcPayload(
        ApplyInpaintingHistoryTransactionRequestSchema,
        { transactionId: "../outside", direction: "undo" },
        "인페인팅 기록",
      ),
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(
        ReleaseInpaintingHistoryTransactionsRequestSchema,
        { transactionIds: [] },
        "인페인팅 기록",
      ),
    ).toThrow(/요청 형식/);
  });

  it("uses the same max token and OAuth port bounds as app settings normalization", () => {
    const payload = {
      modelProvider: "openai-codex",
      translation: {
        sourceLanguage: "zh-Hans",
        targetLanguage: "en",
      },
      gemma: {
        modelSource: "huggingface",
        modelRepo: "owner/repo",
        modelFile: "model.gguf",
        vramMode: "economy",
        llamaRuntimeProfile: "rtx50",
        llamaRocmTarget: "gfx1100",
      },
      codex: {
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        oauthPort: 10531,
      },
      api: {
        baseUrl: "http://127.0.0.1:1234/v1/chat/completions/",
        model: "local-vision-model",
        apiKey: "sk-test",
        temperature: null,
        topP: 0.8,
        topK: 8,
        reasoningEffort: "minimal",
        extraBodyJson: '{"provider":{"sort":"throughput"}}',
        customHeadersJson: '{"X-OpenRouter-Title":"Manga Translator"}',
      },
      ocr: {
        device: "cpu",
        qualityMode: "economy",
        gpuBackend: "rocm",
      },
      inpainting: {
        model: "lama",
        fluxBackend: "rocm",
        koharuBackend: "amd",
      },
      maxTokens: 32768,
      ctx: 131072,
    };

    const parsed = parseIpcPayload(AppSettingsSchema, payload, "설정 저장");
    expect(parsed.maxTokens).toBe(32768);
    expect(parsed.ctx).toBe(131072);
    expect(parsed.translation).toEqual({
      sourceLanguage: "zh-Hans",
      targetLanguage: "en",
    });
    expect(parsed.gemma.vramMode).toBe("economy26b");
    expect(parsed.gemma.llamaRuntimeProfile).toBe("rtx50");
    expect(parsed.gemma.llamaRocmTarget).toBe("gfx110X");
    expect(parsed.api.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(parsed.api.temperature).toBeNull();
    expect(parsed.codex.reasoningEffort).toBe("ultra");
    expect(parsed.api.reasoningEffort).toBe("minimal");
    expect(parsed.ocr.qualityMode).toBe("economy");
    expect(parsed.ocr.gpuBackend).toBe("rocm-transformers");
    expect(parsed.inpainting?.model).toBe("lama-manga");
    expect(parsed.inpainting?.fluxBackend).toBe("zluda-native");
    expect(parsed.inpainting?.koharuBackend).toBe("zluda-native");
    expect(
      parseIpcPayload(
        AppSettingsSchema,
        {
          ...payload,
          gemma: { ...payload.gemma, llamaRuntimeProfile: "cuda13.3" },
        },
        "설정 저장",
      ).gemma.llamaRuntimeProfile,
    ).toBe("rtx50");
    expect(() =>
      parseIpcPayload(
        AppSettingsSchema,
        { ...payload, maxTokens: MAX_MAX_TOKENS + 1 },
        "설정 저장",
      ),
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(
        AppSettingsSchema,
        {
          ...payload,
          translation: {
            sourceLanguage: "en-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-cc-dd",
            targetLanguage: "ko",
          },
        },
        "설정 저장",
      ),
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(AppSettingsSchema, { ...payload, ctx: 512 }, "설정 저장"),
    ).toThrow(/요청 형식/);
    expect(
      parseIpcPayload(
        AppSettingsSchema,
        {
          ...payload,
          gemma: { ...payload.gemma, llamaRuntimeProfile: "metal" },
        },
        "설정 저장",
      ).gemma.llamaRuntimeProfile,
    ).toBe("metal");
    expect(() =>
      parseIpcPayload(
        AppSettingsSchema,
        { ...payload, gemma: { ...payload.gemma, vramMode: "custom" } },
        "설정 저장",
      ),
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(
        AppSettingsSchema,
        { ...payload, codex: { ...payload.codex, oauthPort: 0 } },
        "설정 저장",
      ),
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(
        AppSettingsSchema,
        { ...payload, api: { ...payload.api, baseUrl: "file:///tmp/model" } },
        "설정 저장",
      ),
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(
        AppSettingsSchema,
        { ...payload, api: { ...payload.api, extraBodyJson: "[]" } },
        "설정 저장",
      ),
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(
        AppSettingsSchema,
        {
          ...payload,
          api: {
            ...payload.api,
            customHeadersJson: '{"Authorization":"Bearer nope"}',
          },
        },
        "설정 저장",
      ),
    ).toThrow(/요청 형식/);
  });

  it("treats progressPercent as a 0..1 ratio in all IPC progress events", () => {
    expect(
      JobEventSchema.safeParse({
        id: "job-1",
        kind: "gemma-analysis",
        status: "running",
        progressText: "downloading",
        progressMode: "determinate",
        progressPercent: 1,
      }).success,
    ).toBe(true);
    expect(
      ModelTestProgressEventSchema.safeParse({
        id: "test-1",
        progressText: "downloading",
        progressMode: "determinate",
        progressPercent: 0.5,
      }).success,
    ).toBe(true);
    expect(
      JobEventSchema.safeParse({
        id: "job-1",
        kind: "gemma-analysis",
        status: "running",
        progressText: "downloading",
        progressMode: "determinate",
        progressPercent: 50,
      }).success,
    ).toBe(false);
    expect(
      ModelTestProgressEventSchema.safeParse({
        id: "test-1",
        progressText: "downloading",
        progressMode: "determinate",
        progressPercent: 50,
      }).success,
    ).toBe(false);
  });

  it("normalizes obsolete render directions to horizontal when saving chapters", () => {
    const payload = makeChapterSnapshot();
    payload.pages[0].blocks[0].renderDirection = "hidden";

    const parsed = parseIpcPayload(ChapterSnapshotSchema, payload, "화 저장");

    expect(parsed.pages[0].blocks[0].renderDirection).toBe("horizontal");
  });

  it("normalizes legacy block types to the current nonsolid type", () => {
    const payload = makeChapterSnapshot();
    payload.pages[0].blocks[0].type = "caption";

    const parsed = parseIpcPayload(ChapterSnapshotSchema, payload, "화 저장");

    expect(parsed.pages[0].blocks[0].type).toBe("nonsolid");
  });

  it("clamps legacy zero-sized bboxes when parsing stored chapters", () => {
    const payload = makeChapterSnapshot();
    payload.pages[0].blocks[0].bbox = { x: 1000, y: 1000, w: 0, h: 0 };

    const parsed = parseIpcPayload(ChapterSnapshotSchema, payload, "화 저장");

    expect(parsed.pages[0].blocks[0].bbox).toEqual({
      x: 999,
      y: 999,
      w: 1,
      h: 1,
    });
  });

  it("accepts optional review/name memory fields on translation blocks", () => {
    const block = makeChapterSnapshot().pages[0].blocks[0];
    expect(TranslationBlockSchema.safeParse(block).success).toBe(true);

    const parsed = parseIpcPayload(
      TranslationBlockSchema,
      {
        ...block,
        reviewStatus: "needs_review",
        reviewNote: "말투 확인",
        speakerId: "hero",
        glossaryEntryIds: ["glossary-1"],
      },
      "블록",
    );

    expect(parsed.reviewStatus).toBe("needs_review");
    expect(parsed.reviewNote).toBe("말투 확인");
    expect(parsed.speakerId).toBe("hero");
    expect(parsed.glossaryEntryIds).toEqual(["glossary-1"]);
  });

  it("accepts an in-range 장평 (fontWidthScale) on translation blocks", () => {
    const block = makeChapterSnapshot().pages[0].blocks[0];
    const parsed = parseIpcPayload(
      TranslationBlockSchema,
      { ...block, fontWidthScale: 0.8 },
      "블록",
    );
    expect(parsed.fontWidthScale).toBe(0.8);
  });

  it("accepts only a normalized text opacity on translation blocks", () => {
    const block = makeChapterSnapshot().pages[0].blocks[0];
    const parsed = parseIpcPayload(
      TranslationBlockSchema,
      { ...block, textOpacity: 0.45 },
      "블록",
    );
    expect(parsed.textOpacity).toBe(0.45);
    expect(() =>
      parseIpcPayload(
        TranslationBlockSchema,
        { ...block, textOpacity: 1.1 },
        "블록",
      ),
    ).toThrow(/요청 형식/);
  });

  it("rejects an out-of-range 장평 (fontWidthScale)", () => {
    const block = makeChapterSnapshot().pages[0].blocks[0];
    expect(() =>
      parseIpcPayload(
        TranslationBlockSchema,
        { ...block, fontWidthScale: 3 },
        "블록",
      ),
    ).toThrow(/요청 형식/);
  });

  it("rejects invalid review block metadata", () => {
    const block = makeChapterSnapshot().pages[0].blocks[0];
    expect(() =>
      parseIpcPayload(
        TranslationBlockSchema,
        { ...block, reviewStatus: "done" },
        "블록",
      ),
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(
        TranslationBlockSchema,
        { ...block, reviewNote: "x".repeat(4001) },
        "블록",
      ),
    ).toThrow(/요청 형식/);
  });
});

function makeChapterSnapshot() {
  return {
    id: chapterId,
    workId,
    title: "1화",
    sourceKind: "folder",
    status: "completed",
    pageOrder: [pageId],
    pages: [
      {
        id: pageId,
        name: "001.png",
        imagePath:
          "C:\\library\\works\\work\\chapters\\chapter\\pages\\001.png",
        dataUrl: "",
        width: 100,
        height: 120,
        blocks: [
          {
            id: "block-1",
            type: "nonsolid",
            bbox: { x: 10, y: 10, w: 100, h: 100 },
            sourceText: "こんにちは",
            translatedText: "안녕",
            confidence: 0.9,
            sourceDirection: "vertical",
            renderDirection: "vertical",
            fontSizePx: 20,
            lineHeight: 1.2,
            textAlign: "center",
            textColor: "#111111",
            backgroundColor: "#ffffff",
            opacity: 0.9,
          },
        ],
        analysisStatus: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
