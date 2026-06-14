import { describe, expect, it } from "vitest";
import {
  AppSettingsSchema,
  ChapterSnapshotSchema,
  parseIpcPayload,
  SavePageBlocksRequestSchema,
  StartAnalysisRequestSchema,
  StartInpaintingRequestSchema,
  WorkShareImportRequestSchema
} from "../src/shared/ipcSchemas";

const workId = "11111111-1111-4111-8111-111111111111";
const chapterId = "22222222-2222-4222-8222-222222222222";
const pageId = "33333333-3333-4333-8333-333333333333";

describe("IPC schemas", () => {
  it("rejects forged ids before IPC handlers reach filesystem paths", () => {
    expect(() =>
      parseIpcPayload(StartAnalysisRequestSchema, { chapterId: "../outside", runMode: "all" }, "번역 작업")
    ).toThrow(/요청 형식/);
  });

  it("requires pageId only for single-page analysis", () => {
    expect(parseIpcPayload(StartAnalysisRequestSchema, { chapterId, runMode: "pending" }, "번역 작업").runMode).toBe("pending");
    expect(parseIpcPayload(StartAnalysisRequestSchema, { chapterId, runMode: "all" }, "번역 작업").runMode).toBe("all");
    expect(() => parseIpcPayload(StartAnalysisRequestSchema, { chapterId, runMode: "single-page" }, "번역 작업")).toThrow(/요청 형식/);
    const parsed = parseIpcPayload(StartAnalysisRequestSchema, { chapterId, runMode: "single-page", pageId }, "번역 작업");
    expect(parsed.runMode).toBe("single-page");
    if (parsed.runMode !== "single-page") {
      throw new Error("single-page request was not parsed as single-page");
    }
    expect(parsed.pageId).toBe(pageId);
  });

  it("accepts a base page timestamp for conflict-aware block saves", () => {
    const parsed = parseIpcPayload(
      SavePageBlocksRequestSchema,
      {
        chapterId,
        pageId,
        baseUpdatedAt: "2026-01-01T00:00:00.000Z",
        blocks: makeChapterSnapshot().pages[0].blocks
      },
      "페이지 블록 저장"
    );
    expect(parsed.baseUpdatedAt).toBe("2026-01-01T00:00:00.000Z");
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
              unexpected: "renderer should not be able to persist this"
            }
          ]
        },
        "화 저장"
      )
    ).toThrow(/요청 형식/);
  });

  it("accepts a valid share import command but keeps package ids bounded strings", () => {
    const parsed = parseIpcPayload(
      WorkShareImportRequestSchema,
      {
        previewId: "44444444-4444-4444-8444-444444444444",
        target: { mode: "existing", workId },
        entries: [{ source: "package", packageChapterId: "chapter-in-package", title: "1화" }]
      },
      "공유 파일 가져오기"
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
          entries: []
        },
        "공유 파일 가져오기"
      )
    ).toThrow(/요청 형식/);
  });

  it("bounds drawn inpainting masks to runtime stroke limits", () => {
    const point = { x: 1, y: 1 };
    const validStroke = { radiusPx: 12, points: Array.from({ length: 1200 }, () => point) };

    const parsed = parseIpcPayload(
      StartInpaintingRequestSchema,
      {
        chapterId,
        mode: "page-pattern-drawn",
        pageId,
        strokes: Array.from({ length: 200 }, () => validStroke)
      },
      "인페인팅 작업"
    );
    expect(parsed.mode).toBe("page-pattern-drawn");
    expect(parsed.mode === "page-pattern-drawn" ? parsed.strokes : []).toHaveLength(200);

    expect(() =>
      parseIpcPayload(
        StartInpaintingRequestSchema,
        {
          chapterId,
          mode: "page-pattern-drawn",
          pageId,
          strokes: Array.from({ length: 201 }, () => validStroke)
        },
        "인페인팅 작업"
      )
    ).toThrow(/요청 형식/);

    expect(() =>
      parseIpcPayload(
        StartInpaintingRequestSchema,
        {
          chapterId,
          mode: "page-pattern-drawn",
          pageId,
          strokes: [{ radiusPx: 12, points: Array.from({ length: 1201 }, () => point) }]
        },
        "인페인팅 작업"
      )
    ).toThrow(/요청 형식/);
  });

  it("uses the same max token and OAuth port bounds as app settings normalization", () => {
    const payload = {
      modelProvider: "openai-codex",
      gemma: {
        modelSource: "huggingface",
        modelRepo: "owner/repo",
        modelFile: "model.gguf",
        vramMode: "economy",
        llamaRuntimeProfile: "rtx50",
        llamaRocmTarget: "gfx1100"
      },
      codex: {
        model: "gpt-5.5",
        reasoningEffort: "medium",
        oauthPort: 10531
      },
      ocr: {
        device: "cpu"
      },
      inpainting: {
        fluxBackend: "rocm"
      },
      maxTokens: 12000
    };

    const parsed = parseIpcPayload(AppSettingsSchema, payload, "설정 저장");
    expect(parsed.maxTokens).toBe(12000);
    expect(parsed.gemma.vramMode).toBe("economy26b");
    expect(parsed.gemma.llamaRuntimeProfile).toBe("rtx50");
    expect(parsed.gemma.llamaRocmTarget).toBe("gfx110X");
    expect(parsed.inpainting?.fluxBackend).toBe("zluda-native");
    expect(
      parseIpcPayload(
        AppSettingsSchema,
        { ...payload, gemma: { ...payload.gemma, llamaRuntimeProfile: "cuda13.3" } },
        "설정 저장"
      ).gemma.llamaRuntimeProfile
    ).toBe("rtx50");
    expect(() => parseIpcPayload(AppSettingsSchema, { ...payload, maxTokens: 12001 }, "설정 저장")).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(
        AppSettingsSchema,
        { ...payload, gemma: { ...payload.gemma, llamaRuntimeProfile: "metal" } },
        "설정 저장"
      )
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(AppSettingsSchema, { ...payload, gemma: { ...payload.gemma, vramMode: "custom" } }, "설정 저장")
    ).toThrow(/요청 형식/);
    expect(() =>
      parseIpcPayload(AppSettingsSchema, { ...payload, codex: { ...payload.codex, oauthPort: 0 } }, "설정 저장")
    ).toThrow(/요청 형식/);
  });

  it("normalizes obsolete render directions to horizontal when saving chapters", () => {
    const payload = makeChapterSnapshot();
    payload.pages[0].blocks[0].renderDirection = "hidden";

    const parsed = parseIpcPayload(ChapterSnapshotSchema, payload, "화 저장");

    expect(parsed.pages[0].blocks[0].renderDirection).toBe("horizontal");
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
        imagePath: "C:\\library\\works\\work\\chapters\\chapter\\pages\\001.png",
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
            opacity: 0.9
          }
        ],
        analysisStatus: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
