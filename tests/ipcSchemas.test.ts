import { describe, expect, it } from "vitest";
import {
  ApplyInpaintingHistoryTransactionRequestSchema,
  AppSettingsSchema,
  AnalyzeWorkContextRequestSchema,
  ChapterSnapshotSchema,
  InpaintingRetouchRequestSchema,
  JobEventSchema,
  ModelTestProgressEventSchema,
  parseIpcPayload,
  ReleaseInpaintingHistoryTransactionsRequestSchema,
  SavePageBlocksRequestSchema,
  SavePagesBlocksRequestSchema,
  StartAnalysisRequestSchema,
  StartInpaintingRequestSchema,
  TranslationBlockSchema,
  WorkShareImportRequestSchema,
} from "../src/shared/ipcSchemas";
import { MAX_MAX_TOKENS } from "../src/shared/modelPresets";
import { createWarpPreset } from "../src/shared/blockTransforms";
import { TEST_INTERNET_RESEARCH_SETTINGS } from "./fixtures/internetResearchSettings";

const workId = "11111111-1111-4111-8111-111111111111";
const chapterId = "22222222-2222-4222-8222-222222222222";
const pageId = "33333333-3333-4333-8333-333333333333";
const blockId = "block-1";

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

  it("accepts only a boolean natural text layout option", () => {
    expect(
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "all", naturalTextLayout: true },
        "번역 작업",
      ).naturalTextLayout,
    ).toBe(true);
    expect(() =>
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "all", naturalTextLayout: "yes" },
        "번역 작업",
      ),
    ).toThrow(/요청 형식/);
  });

  it("accepts automatic font matching on every analysis run mode", () => {
    const requests = [
      { chapterId, runMode: "pending", autoFontMatching: true },
      { chapterId, runMode: "all", autoFontMatching: true },
      {
        chapterId,
        runMode: "single-page",
        pageId,
        autoFontMatching: true,
      },
      {
        chapterId,
        runMode: "page-set",
        pageIds: [pageId],
        autoFontMatching: true,
      },
    ] as const;

    for (const request of requests) {
      expect(
        parseIpcPayload(StartAnalysisRequestSchema, request, "번역 작업")
          .autoFontMatching,
      ).toBe(true);
    }
    expect(() =>
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "all", autoFontMatching: "yes" },
        "번역 작업",
      ),
    ).toThrow(/요청 형식/);
  });

  it("accepts only known combined-workflow completion requirements", () => {
    const parsed = parseIpcPayload(
      StartAnalysisRequestSchema,
      {
        chapterId,
        runMode: "all",
        completionWorkflow: "bubble-layout",
      },
      "번역 작업",
    );
    expect(parsed.completionWorkflow).toBe("bubble-layout");
    expect(() =>
      parseIpcPayload(
        StartAnalysisRequestSchema,
        { chapterId, runMode: "all", completionWorkflow: "unknown" },
        "번역 작업",
      ),
    ).toThrow(/요청 형식/);
  });

  it("accepts strict stroke and filled-shape retouch geometries", () => {
    const base = {
      chapterId,
      pageId,
      mode: "paint" as const,
      color: "#ffffff",
    };
    const geometries = [
      {
        kind: "stroke" as const,
        points: [{ x: 10, y: 20 }],
        radiusPx: 28,
      },
      {
        kind: "rectangle" as const,
        start: { x: 10, y: 20 },
        end: { x: 200, y: 300 },
      },
      {
        kind: "ellipse" as const,
        start: { x: 200, y: 300 },
        end: { x: 10, y: 20 },
      },
    ];

    for (const geometry of geometries) {
      expect(
        parseIpcPayload(
          InpaintingRetouchRequestSchema,
          { ...base, geometry },
          "수동 보정",
        ).geometry,
      ).toEqual(geometry);
    }

    expect(() =>
      parseIpcPayload(
        InpaintingRetouchRequestSchema,
        {
          ...base,
          geometry: {
            kind: "rectangle",
            start: { x: 0, y: 0 },
            end: { x: 20, y: 20 },
            radiusPx: 4,
          },
        },
        "수동 보정",
      ),
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(
        InpaintingRetouchRequestSchema,
        {
          ...base,
          points: [{ x: 0, y: 0 }],
          radiusPx: 4,
        },
        "수동 보정",
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

  it("accepts a page batch and rejects empty or duplicate page ids", () => {
    const secondPageId = "44444444-4444-4444-8444-444444444444";
    const pageUpdate = {
      pageId,
      baseUpdatedAt: "2026-01-01T00:00:00.000Z",
      baseBlocksHash: "0123456789abcdef",
      blocks: makeChapterSnapshot().pages[0].blocks,
    };
    const parsed = parseIpcPayload(
      SavePagesBlocksRequestSchema,
      {
        chapterId,
        dirtyVersion: 4,
        saveReason: "manual",
        pages: [
          pageUpdate,
          {
            ...pageUpdate,
            pageId: secondPageId,
          },
        ],
      },
      "페이지 블록 일괄 저장",
    );

    expect(parsed.pages.map((page) => page.pageId)).toEqual([
      pageId,
      secondPageId,
    ]);
    expect(() =>
      parseIpcPayload(
        SavePagesBlocksRequestSchema,
        { chapterId, pages: [] },
        "페이지 블록 일괄 저장",
      ),
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(
        SavePagesBlocksRequestSchema,
        { chapterId, pages: [pageUpdate, pageUpdate] },
        "페이지 블록 일괄 저장",
      ),
    ).toThrow(/요청 형식/);
  });

  it("accepts rotation, perspective, curve, and warp data in autosave payloads", () => {
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
      warpTransform: createWarpPreset("wave", 3),
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
    expect(parsed.blocks[0].warpTransform?.points).toHaveLength(16);
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

  it("accepts only strict bubble-layout postprocess options", () => {
    const parsed = parseIpcPayload(
      StartInpaintingRequestSchema,
      {
        chapterId,
        mode: "page-pattern",
        pageId,
        postprocess: {
          bubbleLayout: {
            enabled: true,
            policy: "balanced",
            naturalTextLayout: true,
          },
        },
      },
      "인페인팅 작업",
    );
    expect(parsed.postprocess?.bubbleLayout).toEqual({
      enabled: true,
      policy: "balanced",
      naturalTextLayout: true,
    });
    expect(() =>
      parseIpcPayload(
        StartInpaintingRequestSchema,
        {
          chapterId,
          mode: "page-pattern",
          pageId,
          postprocess: {
            bubbleLayout: { enabled: true, policy: "aggressive" },
          },
        },
        "인페인팅 작업",
      ),
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(
        StartInpaintingRequestSchema,
        {
          chapterId,
          mode: "page-pattern",
          pageId,
          postprocess: {
            bubbleLayout: {
              enabled: true,
              policy: "safe",
              bbox: { x: 0, y: 0, w: 1, h: 1 },
            },
          },
        },
        "인페인팅 작업",
      ),
    ).toThrow(/요청 형식/);

    expect(
      parseIpcPayload(
        StartInpaintingRequestSchema,
        {
          chapterId,
          mode: "page-bubble-layout",
          pageId,
          policy: "maximize",
        },
        "인페인팅 작업",
      ),
    ).toMatchObject({
      mode: "page-bubble-layout",
      policy: "maximize",
    });
  });

  it("accepts one optional block target for automatic page actions", () => {
    expect(
      parseIpcPayload(
        StartInpaintingRequestSchema,
        { chapterId, mode: "page-pattern", pageId, blockId },
        "인페인팅 작업",
      ),
    ).toMatchObject({ mode: "page-pattern", blockId });
    expect(
      parseIpcPayload(
        StartInpaintingRequestSchema,
        {
          chapterId,
          mode: "page-bubble-layout",
          pageId,
          blockId,
          policy: "balanced",
        },
        "인페인팅 작업",
      ),
    ).toMatchObject({ mode: "page-bubble-layout", blockId });
    expect(() =>
      parseIpcPayload(
        StartInpaintingRequestSchema,
        {
          chapterId,
          mode: "page-pattern",
          pageId,
          blockId: "",
        },
        "인페인팅 작업",
      ),
    ).toThrow(/요청 형식/);
  });

  it("accepts exactly one automatic inpainting chapter selection", () => {
    const otherChapterId = "44444444-4444-4444-8444-444444444444";
    const parsed = parseIpcPayload(
      StartInpaintingRequestSchema,
      {
        mode: "selection-pattern",
        workId,
        selections: [{ chapterId, mode: "all" }],
      },
      "인페인팅 작업",
    );

    expect(parsed.mode).toBe("selection-pattern");
    expect(
      parsed.mode === "selection-pattern" ? parsed.selections : [],
    ).toHaveLength(1);
    expect(() =>
      parseIpcPayload(
        StartInpaintingRequestSchema,
        {
          mode: "selection-pattern",
          workId,
          selections: [
            { chapterId, mode: "all" },
            { chapterId: otherChapterId, mode: "all" },
          ],
        },
        "인페인팅 작업",
      ),
    ).toThrow(/요청 형식/);
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
    expect(() =>
      parseIpcPayload(
        StartInpaintingRequestSchema,
        {
          mode: "selection-pattern",
          workId,
          selections: [
            { chapterId, mode: "page-set", pageIds: [pageId, pageId] },
          ],
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

  it("uses the same max token bounds and rejects obsolete Codex fields", () => {
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
      },
      internetResearch: TEST_INTERNET_RESEARCH_SETTINGS,
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
        bubbleLayoutAfterInpainting: true,
        bubbleLayoutPaddingRatio: 0.24,
      },
      ui: {
        autoFontMatchingDefault: false,
        eraseOriginalWorkflowDefault: true,
        bubbleLayoutWorkflowDefault: false,
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
    expect(parsed.inpainting?.bubbleLayoutAfterInpainting).toBe(true);
    expect(parsed.inpainting?.bubbleLayoutPaddingRatio).toBe(0.24);
    expect(parsed.ui?.autoFontMatchingDefault).toBe(false);
    expect(parsed.ui?.eraseOriginalWorkflowDefault).toBe(true);
    expect(parsed.ui?.bubbleLayoutWorkflowDefault).toBe(false);
    expect(
      parseIpcPayload(
        AppSettingsSchema,
        {
          ...payload,
          ocr: {
            ...payload.ocr,
            device: "gpu",
            gpuBackend: "cuda",
            qualityMode: "vl",
          },
        },
        "설정 저장",
      ).ocr.qualityMode,
    ).toBe("full");
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
    for (const bubbleLayoutPaddingRatio of [-0.01, 0.71]) {
      expect(() =>
        parseIpcPayload(
          AppSettingsSchema,
          {
            ...payload,
            inpainting: {
              ...payload.inpainting,
              bubbleLayoutPaddingRatio,
            },
          },
          "설정 저장",
        ),
      ).toThrow(/요청 형식/);
    }
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
        { ...payload, codex: { ...payload.codex, oauthPort: 10531 } },
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
    expect(
      parseIpcPayload(
        AppSettingsSchema,
        {
          ...payload,
          keybindings: {
            "toggle-block-chrome": "ctrl+shift+b",
            "delete-block": "",
          },
        },
        "설정 저장",
      ).keybindings,
    ).toEqual({
      "toggle-block-chrome": "ctrl+shift+b",
      "delete-block": "",
    });
    for (const keybindings of [
      ["ctrl+a"],
      { "removed-action": "ctrl+r" },
      { "toggle-block-chrome": "CTRL+B" },
      { "toggle-block-chrome": "shift+ctrl+b" },
      { "toggle-block-chrome": 42 },
    ]) {
      expect(() =>
        parseIpcPayload(
          AppSettingsSchema,
          { ...payload, keybindings },
          "설정 저장",
        ),
      ).toThrow(/요청 형식/);
    }
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

  it("round-trips a persisted combined-workflow completion receipt", () => {
    const base = makeChapterSnapshot();
    const payload = {
      ...base,
      pages: base.pages.map((page) => ({
        ...page,
        translationCompletion: {
          workflow: "bubble-layout" as const,
          status: "pending" as const,
        },
      })),
    };

    const parsed = parseIpcPayload(ChapterSnapshotSchema, payload, "화 저장");

    expect(parsed.pages[0].translationCompletion).toEqual({
      workflow: "bubble-layout",
      status: "pending",
    });
  });

  it("round-trips partial inpainting block ownership in a completion receipt", () => {
    const base = makeChapterSnapshot();
    const payload = {
      ...base,
      pages: base.pages.map((page) => ({
        ...page,
        translationCompletion: {
          workflow: "erase-original" as const,
          status: "pending" as const,
          erasedBlockIds: [page.blocks[0].id],
        },
      })),
    };

    const parsed = parseIpcPayload(ChapterSnapshotSchema, payload, "화 저장");

    expect(parsed.pages[0].translationCompletion).toEqual({
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: [base.pages[0].blocks[0].id],
    });
  });

  it("rejects duplicate partial inpainting block ownership ids", () => {
    const base = makeChapterSnapshot();
    const blockId = base.pages[0].blocks[0].id;
    const payload = {
      ...base,
      pages: base.pages.map((page) => ({
        ...page,
        translationCompletion: {
          workflow: "erase-original" as const,
          status: "pending" as const,
          erasedBlockIds: [blockId, blockId],
        },
      })),
    };

    expect(ChapterSnapshotSchema.safeParse(payload).success).toBe(false);
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

  it("serializes canonical visual cluster ids and migrates blocks without one", () => {
    const legacyBlock = makeChapterSnapshot().pages[0].blocks[0];
    expect(TranslationBlockSchema.safeParse(legacyBlock).success).toBe(true);

    const serialized = JSON.parse(
      JSON.stringify({
        ...legacyBlock,
        visualClusterId: "  repeat－impact  ",
      }),
    );
    const parsed = parseIpcPayload(TranslationBlockSchema, serialized, "블록");
    expect(parsed.visualClusterId).toBe("repeat-impact");

    for (const visualClusterId of [
      " ",
      "x".repeat(201),
      "../escape",
      "hidden\u0000cluster",
    ]) {
      expect(
        TranslationBlockSchema.safeParse({
          ...legacyBlock,
          visualClusterId,
        }).success,
      ).toBe(false);
    }
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

  it("accepts only supported optional line-breaking modes on translation blocks", () => {
    const block = makeChapterSnapshot().pages[0].blocks[0];

    expect(TranslationBlockSchema.safeParse(block).success).toBe(true);
    for (const wordBreak of [
      "normal",
      "break-all",
      "keep-all",
      "break-word",
      "keep-all-overflow",
    ] as const) {
      const parsed = parseIpcPayload(
        TranslationBlockSchema,
        { ...block, wordBreak },
        "블록",
      );
      expect(parsed.wordBreak).toBe(wordBreak);
    }
    expect(() =>
      parseIpcPayload(
        TranslationBlockSchema,
        { ...block, wordBreak: "anywhere" },
        "블록",
      ),
    ).toThrow(/요청 형식/);
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
        { ...block, fontWidthScale: 5.01 },
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
