import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import type { AppPaths } from "../src/main/appPaths";
import {
  buildBaseTranslationOptions,
  resolveDefaultAppSettings,
  type TranslationOptions,
} from "../src/main/appSettings";
import type { JobEvent, JobState } from "../src/shared/jobTypes";
import { JobPhaseSchema } from "../src/shared/jobContracts";
import { createFontChapterC18Port } from "../src/main/pipeline/fontChapterC18";
import { createPageWorkflowProgress } from "../src/main/jobs/pageWorkflowProgress";
import { reduceJobEventBatch } from "../src/renderer/src/hooks/jobEventState";
import { resolveProgressSnapshot } from "../src/renderer/src/lib/jobProgress";
import { editingChapter } from "./mcpEditing.fixture";

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  start: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("../src/main/runtimeSupport/modelDownloads", async (original) => ({
  ...(await original<
    typeof import("../src/main/runtimeSupport/modelDownloads")
  >()),
  ensureRemoteFile: mocks.download,
}));
vi.mock("../src/main/pipeline/fontChapterRuntimeAssets", () => ({
  prepareFontChapterRuntime: async () => ({ assets: "assets", manifest: {} }),
}));
vi.mock("../src/main/pipeline/fontChapterC18Worker", () => ({
  prepareFontChapterC18WorkerRuntime: async () => ({
    pythonAbi: "cpython-314",
  }),
  launchFontChapterC18Worker: async () => ({
    startRequest: mocks.start,
    dispose: mocks.dispose,
  }),
}));

const roots: string[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  mocks.start.mockReturnValue({
    response: Promise.resolve({
      ok: true,
      result: {
        version: "c23.0",
        choices: [
          {
            key: "P000001/D000001",
            groupId: "group",
            fontId: "jua",
            fontWeight: 400,
            italic: false,
          },
        ],
      },
    }),
  });
});
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it.each(["downloaded", "unavailable", "gpu"] as const)(
  "replaces download state before chapter inference (%s)",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "font-progress-"));
    roots.push(root);
    const events: JobEvent[] = [];
    const workflow = createPageWorkflowProgress(
      "job",
      { pageCount: 19, stageCount: 7 },
      (event) => events.push(event),
    );
    workflow.prepare("typography", editingChapter());
    const onProgress = vi.fn((event) =>
      workflow.emit({
        id: "job",
        kind: "gemma-analysis",
        status: "running",
        ...event,
      }),
    );
    mocks.download.mockImplementation(async (task) => {
      task.onProgress?.({
        progressText: "Font glyph verification 다운로드 중",
        detail: task.fileName,
        progressMode: "determinate",
        progressPercent: 0,
        progressBytes: 0,
        progressTotalBytes: 21167540,
      });
      if (mode === "unavailable") throw new Error("HTTP 404");
    });
    mocks.start.mockImplementationOnce(() => {
      expect(events.at(-1)?.phase).toBe("font_matching_running");
      expect(events.at(-1)?.progressText).toContain("폰트 분석 중");
      expect(JobPhaseSchema.parse(events.at(-1)?.phase)).toBe(
        "font_matching_running",
      );
      return {
        response: Promise.resolve({
          ok: true,
          result: {
            version: "c23.0",
            choices: [
              {
                key: "P000001/D000001",
                groupId: "group",
                fontId: "jua",
                fontWeight: 400,
                italic: false,
              },
            ],
          },
        }),
      };
    });
    const port = createFontChapterC18Port({
      dataRoot: root,
      runtimeDir: root,
    } as AppPaths);
    await expect(
      port.prepare(
        [
          {
            ...(await sourceEntry(root)),
            pageOptions: {
              ...baseOptions(root),
              autoFontMatching: true,
              sourceLanguage: "ja",
              targetLanguage: "ko",
              ocrDevice: mode === "gpu" ? "gpu" : "cpu",
              onProgress,
            },
          },
        ],
        new AbortController().signal,
      ),
    ).resolves.toBeTypeOf("function");
    const last = events.at(-1);
    if (!last) throw new Error("No analysis progress event");
    expect(last.detail).toContain(
      mode === "unavailable" ? "가속 모델을 준비하지 못해" : "1페이지",
    );
    expect(last.progressText.includes("기본 방식")).toBe(
      mode === "unavailable",
    );
    expect(mocks.download).toHaveBeenCalledTimes(
      mode === "gpu" ? 0 : mode === "unavailable" ? 1 : 2,
    );
    expect(mocks.dispose).toHaveBeenCalledOnce();
    const state = reduceJobEventBatch(
      {
        id: "job",
        kind: "gemma-analysis",
        status: "running",
        progressText: "",
        detail: "manga_rec_v0.2.onnx",
        progressBytes: 0,
        progressTotalBytes: 21167540,
      } as JobState,
      events,
      ((key: string) => key) as TFunction<"renderer">,
    );
    expect(state).toMatchObject({
      phase: "font_matching_running",
      progressCurrent: 0,
      progressTotal: 133,
    });
    expect(state.progressBytes).toBeUndefined();
    expect(state.progressTotalBytes).toBeUndefined();
    expect(state.detail).not.toContain(".onnx");
    expect(resolveProgressSnapshot(state)).toEqual({ mode: "indeterminate" });
  },
);

it("never reports analysis or starts the worker after download cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "font-progress-cancel-"));
  roots.push(root);
  const controller = new AbortController();
  const onProgress = vi.fn();
  mocks.download.mockImplementation(async () => {
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  });
  await expect(
    createFontChapterC18Port({ dataRoot: root } as AppPaths).prepare(
      [
        {
          ...(await sourceEntry(root)),
          pageOptions: {
            ...baseOptions(root),
            autoFontMatching: true,
            sourceLanguage: "ja",
            targetLanguage: "ko",
            ocrDevice: "cpu",
            onProgress,
          },
        },
      ],
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(onProgress).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});

function baseOptions(root: string): TranslationOptions {
  return buildBaseTranslationOptions({
    jobId: "job",
    runDir: root,
    paths: {
      dataRoot: root,
      toolsDir: root,
      llamaServerPath: join(root, "llama.exe"),
    },
    settings: resolveDefaultAppSettings(),
    env: {},
  });
}

async function sourceEntry(root: string) {
  const imagePath = join(root, "source.png");
  await writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  return {
    page: { ...editingChapter().pages[0], imagePath, width: 1, height: 1 },
    items: [
      {
        id: 1,
        bbox: { x: 0, y: 0, w: 1000, h: 1000 },
        sourceText: "待って",
        jp: "待って",
        ko: "기다려",
        direction: "vertical" as const,
        confidence: 1,
        type: "speech" as const,
      },
    ],
  };
}
