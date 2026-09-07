import type {
  RegionAnalysisRequest,
  StartSoundEffectTranslationRequest,
  StartSoundEffectTranslationResult,
} from "../src/shared/analysisTypes";
import type { BBox } from "../src/shared/textTypes";
import { buildRegionTranslationRequest } from "../src/renderer/src/lib/regionTranslationOptions";
import type { CodexAccountSnapshot } from "../src/shared/codexAccountTypes";
import React from "react";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { RegionTranslationModal } from "../src/renderer/src/components/RegionTranslationModal";
import { codexConnection } from "../src/renderer/src/api/codexConnection";
import { canUseCodexTypesetting } from "../src/shared/codexCapabilities";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import type { JobEvent } from "../src/shared/jobTypes";
/** @vitest-environment jsdom */
import { useRegionTranslationDialog } from "../src/renderer/src/hooks/useRegionTranslationDialog";
import { makePage, makeChapter } from "./unifiedInpaintingUiFixtures";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTranslateSelectedRegionAction } from "../src/renderer/src/hooks/useTranslateSelectedRegionAction";
import { useTranslateSoundEffectsAction } from "../src/renderer/src/hooks/useTranslateSoundEffectsAction";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../src/shared/pageRevision";
import type { MangaPage, ChapterSnapshot } from "../src/shared/libraryTypes";
import type { UseTranslationActionsOptions } from "../src/renderer/src/hooks/translationActionTypes";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  codexConnection.publish(null);
  document
    .querySelectorAll(".work-center-handoff-ghost")
    .forEach((node) => node.remove());
});
it("sends the saved region revision and registers the background/block undo transaction", async () => {
  const page: MangaPage = {
    id: "p",
    name: "page",
    imagePath: "original.png",
    dataUrl: "",
    width: 800,
    height: 1200,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "",
    updatedAt: "",
  };
  const chapter: ChapterSnapshot = {
    id: "c",
    workId: "w",
    title: "chapter",
    pageOrder: [page.id],
    pages: [page],
    sourceKind: "images",
    status: "idle",
    createdAt: "",
    updatedAt: "",
  };
  const saved = {
    ...chapter,
    pages: [{ ...page, imagePath: "saved-new-version.png" }],
  };
  const currentChapterRef = { current: chapter };
  const recordImageEdit = vi.fn();
  const beforeTranslate = vi.fn(async () => {});
  const options: UseTranslationActionsOptions = {
    beforeTranslate,
    clearPageImageCache: vi.fn(),
    clearRetouchHistory: vi.fn(),
    library: { workOrder: [], works: [] },
    setCurrentChapter: vi.fn(),
    setFlowActive: vi.fn(),
    setShowBlockChrome: vi.fn(),
    currentChapter: chapter,
    currentChapterRef,
    selectedPage: page,
    jobActive: false,
    saveNow: async () => {
      currentChapterRef.current = saved;
    },
    recordImageEdit,
    setJobState: vi.fn(),
    mergeLiveChapter: vi.fn(),
    syncSavedPageVersion: vi.fn(),
    refreshLibrary: async () => undefined,
    pushStatus: vi.fn(),
    setSelectedBlockId: vi.fn(),
  };
  const translateRegion = vi.fn(async () => ({
    status: "completed" as const,
    chapter: saved,
    pageId: page.id,
    blockIds: [],
    history: { transactionId: "region-undo" },
  }));
  window.mangaApi = createTestMangaGatewayStub({ translateRegion });
  const { result } = renderHook(() =>
    useTranslateSelectedRegionAction(options, {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
    }),
  );
  await act(async () =>
    expect(
      await result.current(
        { x: 100, y: 100, w: 400, h: 400 },
        { eraseOriginal: true },
      ),
    ).toBe(true),
  );
  expect(translateRegion).toHaveBeenCalledWith(
    expect.objectContaining({
      eraseOriginal: true,
      pageRevision: createPageRevision(saved.pages[0]),
    }),
  );
  expect(recordImageEdit).toHaveBeenCalledWith(
    expect.objectContaining({
      transactionId: "region-undo",
      chapterId: chapter.id,
    }),
  );
  expect(beforeTranslate).toHaveBeenCalledOnce();
  const codexTypesetting = buildRegionTranslationRequest(
    resolveDefaultAppSettings({}),
    { output: "image", eraseOriginal: false },
    false,
  ).codexTypesetting;
  await act(async () => {
    await result.current(
      { x: 100, y: 100, w: 400, h: 400 },
      { codexTypesetting },
    );
  });
  expect(beforeTranslate).toHaveBeenCalledOnce();
});

it("prevents a region request after disconnect and preserves completed choices for the next selection", async () => {
  window.mangaApi = createTestMangaGatewayStub({ onJobEvent: () => () => {} });
  const options = regionOptions();
  const execute = vi.fn(async () => true);
  const { result, rerender } = renderHook(
    ({ offline }) =>
      useRegionTranslationDialog(
        { ...options, codexUnavailable: offline },
        execute,
      ),
    { initialProps: { offline: true } },
  );
  const bbox = { x: 100, y: 100, w: 300, h: 300 };
  await act(() => result.current.open(bbox));
  expect(result.current.dialog).toBeNull();
  rerender({ offline: false });
  await act(() => result.current.open(bbox));
  expect(result.current.dialog?.codexDelegateAll).toBe(true);
  rerender({ offline: true });
  act(() =>
    result.current.dialog?.onRun({ output: "image", eraseOriginal: true }),
  );
  expect(execute).not.toHaveBeenCalled();
  rerender({ offline: false });
  await act(async () =>
    result.current.dialog?.onRun({ output: "image", eraseOriginal: true }),
  );
  expect(execute).toHaveBeenCalledOnce();
  await act(() => result.current.open(bbox));
  expect(result.current.dialog?.initial).toEqual({
    output: "image",
    eraseOriginal: true,
  });
  act(() => result.current.dialog?.onClose());
  expect(result.current.dialog).toBeNull();
});

function regionOptions(): UseTranslationActionsOptions {
  const page = makePage();
  const chapter = makeChapter();
  const noop = () => {};
  const options: UseTranslationActionsOptions = {
    currentChapter: chapter,
    currentChapterRef: { current: chapter },
    selectedPage: page,
    jobActive: false,
    codexDelegationActive: true,
    library: { workOrder: [], works: [] },
    clearPageImageCache: noop,
    clearRetouchHistory: noop,
    mergeLiveChapter: noop,
    pushStatus: noop,
    refreshLibrary: async () => {},
    saveNow: async () => {},
    syncSavedPageVersion: noop,
    recordImageEdit: noop,
    setJobState: noop,
    setCurrentChapter: noop,
    setFlowActive: noop,
    setShowBlockChrome: noop,
    setSelectedBlockId: noop,
  };

  return options;
}

it("routes an explicit SFX output to Codex while preserving ordinary preparation and saved settings", async () => {
  const options = regionOptions();
  const settings = resolveDefaultAppSettings({});
  settings.modelProvider = "openai-api";
  settings.codex.delegateAll = false;
  options.settings = settings;
  options.codexDelegationActive = false;
  options.beforeTranslate = vi.fn(async () => {});
  const chapter = options.currentChapter;
  if (!chapter) throw new Error("Missing fixture chapter");
  const startSoundEffectTranslation = vi.fn<
    (
      request: StartSoundEffectTranslationRequest,
    ) => Promise<StartSoundEffectTranslationResult>
  >(async () => ({
    status: "completed" as const,
    chapter,
    createdBlocksByPage: [],
    translatedRegionCount: 1,
    remainingRegionCount: 0,
  }));
  window.mangaApi = createTestMangaGatewayStub({ startSoundEffectTranslation });
  const original = structuredClone(settings);
  const { result } = renderHook(() =>
    useTranslateSoundEffectsAction(options, {
      success: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    }),
  );
  const targets = [
    {
      pageId: chapter.pages[0].id,
      pageRevision: createSoundEffectReviewPageRevision(chapter.pages[0]),
    },
  ];
  await act(() => result.current(targets, true, false, undefined, "image"));
  expect(startSoundEffectTranslation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      codexTypesetting: expect.objectContaining({ sfxRendering: "image" }),
      inpaintAfterTranslation: true,
    }),
  );
  expect(options.beforeTranslate).not.toHaveBeenCalled();
  await act(() => result.current(targets, false, false, undefined, "font"));
  expect(startSoundEffectTranslation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      codexTypesetting: expect.objectContaining({ sfxRendering: "font" }),
      inpaintAfterTranslation: false,
    }),
  );
  await act(() => result.current(targets));
  expect(options.beforeTranslate).toHaveBeenCalledOnce();
  expect(startSoundEffectTranslation.mock.calls.at(-1)?.[0]).not.toHaveProperty(
    "codexTypesetting",
  );
  expect(settings).toEqual(original);
});

it("hands off standalone Codex recognition and confirmed generation while retaining the original page and failed edits", async () => {
  const settings = resolveDefaultAppSettings({});
  settings.modelProvider = "openai-api";
  settings.codex.delegateAll = false;
  settings.codex.reasoningEffort = "low";
  const account: CodexAccountSnapshot = {
    authenticated: true,
    accountKind: "chatgpt" as const,
    email: null,
    planType: null,
    requiresOpenaiAuth: true,
    appServerVersion: "test",
    models: [
      {
        id: "gpt-6-astra",
        displayName: "Astra",
        supportedReasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
        isDefault: true,
      },
    ],
  };
  expect(canUseCodexTypesetting(settings, account)).toBe(false);
  expect(canUseCodexTypesetting(settings, account, true)).toBe(true);
  expect(
    canUseCodexTypesetting(settings, { ...account, models: [] }, true),
  ).toBe(false);
  const listeners = new Set<(event: JobEvent) => void>();
  const confirmRegionTranslation = vi
      .fn()
      .mockRejectedValueOnce(Error("offline"))
      .mockResolvedValue(true),
    cancelJob = vi.fn();
  window.mangaApi = createTestMangaGatewayStub({
    getCodexAccount: async () => account,
    getPageImageDataUrl: async () => "data:image/png;base64,cHJldmlldw==",
    onJobEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    confirmRegionTranslation,
    cancelJob,
  });
  codexConnection.publish(account);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(
        this.hasAttribute("data-work-center-handoff-target") ? 900 : 100,
        100,
        300,
        300,
      );
    },
  );
  let finish!: (value: boolean) => void;
  const execute = vi.fn<
    (bbox: BBox, request?: Partial<RegionAnalysisRequest>) => Promise<boolean>
  >(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const options = {
    ...regionOptions(),
    settings,
    codexDelegationActive: false,
  };
  function Harness({ input }: { input: UseTranslationActionsOptions }) {
    const controller = useRegionTranslationDialog(input, execute);
    return (
      <>
        <button
          onClick={() => void controller.open({ x: 0, y: 0, w: 500, h: 500 })}
        >
          select
        </button>
        <button data-work-center-handoff-target="">work center</button>
        {controller.dialog ? (
          <RegionTranslationModal {...controller.dialog} />
        ) : null}
      </>
    );
  }
  const view = render(<Harness input={options} />);
  fireEvent.click(screen.getByText("select"));
  fireEvent.click(await screen.findByRole("radio", { name: "효과음 · Codex" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "실행" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "실행" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.querySelector(".work-center-handoff-ghost")).not.toBeNull();
  document
    .querySelector(".work-center-handoff-ghost")
    ?.dispatchEvent(new Event("animationend"));
  fireEvent.click(screen.getByText("select"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(execute).toHaveBeenCalledOnce();
  const request = execute.mock.calls[0][1];
  if (!request?.textReviewSessionId) throw new Error("Missing review session");
  expect(request.codexTypesetting?.regionOutput).toBe("image");
  view.rerender(
    <Harness
      input={{
        ...options,
        selectedPage: { ...makePage(), id: "another" },
      }}
    />,
  );
  expect(cancelJob).not.toHaveBeenCalled();
  act(() =>
    listeners.forEach((listener) =>
      listener({
        id: "job",
        kind: "gemma-analysis",
        status: "running",
        progressText: "review",
        regionRequestId: request.textReviewSessionId,
        regionTextReview: {
          sessionId: request.textReviewSessionId,
          regions: [
            {
              id: "sfx",
              sourceText: "source",
              translatedText: "draft",
              sourceBbox: { x: 0, y: 0, w: 500, h: 500 },
            },
          ],
        },
      } as JobEvent),
    ),
  );
  expect(await screen.findByRole("dialog")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "confirmed wording" },
  });
  fireEvent.click(screen.getByRole("button", { name: "생성" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "offline",
  );
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
    "confirmed wording",
  );
  expect(document.querySelector(".work-center-handoff-ghost")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "생성" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.querySelector(".work-center-handoff-ghost")).not.toBeNull();
  expect(confirmRegionTranslation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      translations: [{ regionId: "sfx", text: "confirmed wording" }],
    }),
  );
  await act(async () => finish(true));
  expect(cancelJob).not.toHaveBeenCalled();
  expect(settings.codex.delegateAll).toBe(false);
  expect(settings.modelProvider).toBe("openai-api");
});
