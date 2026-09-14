/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useTranslationActions } from "../src/renderer/src/hooks/useTranslationActions";
import { useCodexConnection } from "../src/renderer/src/hooks/useCodexConnection";
import { makeOptions } from "./translationWorkflowFixtures";
const startSoundEffectTranslation = vi.fn();
const notificationMocks = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.mangaApi = createTestMangaGatewayStub();
});
it("resumes saved SFX images during an unrelated local model job without disposing its runtime", async () => {
  window.mangaApi = createTestMangaGatewayStub({ startSoundEffectTranslation });
  const options = makeOptions();
  options.jobActive = true;
  options.beforeTranslate = vi.fn(async () => {});
  options.savePageNow = vi.fn(async () => {});
  startSoundEffectTranslation.mockResolvedValue({
    status: "completed",
    createdBlocksByPage: [],
    translatedRegionCount: 0,
    remainingRegionCount: 0,
  });
  const { result } = renderHook(() =>
    useTranslationActions(options, notificationMocks),
  );
  const targets = [
    {
      pageId: "page-1",
      pageRevision: "page-v1:0000000000000000",
      regionIds: ["FX001"],
    },
  ];
  await act(async () => {
    expect(
      await result.current.translateSoundEffects(targets, true, false),
    ).toBeNull();
    expect(
      await result.current.translateSoundEffects(
        targets,
        true,
        false,
        undefined,
        "image",
        "saved-run",
      ),
    ).toMatchObject({ status: "completed" });
  });
  expect(startSoundEffectTranslation).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ resumeImageRunId: "saved-run" }),
  );
  expect(options.savePageNow).toHaveBeenCalledExactlyOnceWith(
    "chapter-1",
    "page-1",
  );
  expect(options.saveNow).not.toHaveBeenCalled();
  expect(options.beforeTranslate).not.toHaveBeenCalled();
});

it("checks Codex once when a hidden window opens an image action and pauses background polling", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const account = {
    authenticated: true,
    accountKind: "chatgpt" as const,
    email: null,
    planType: "pro",
    requiresOpenaiAuth: true,
    appServerVersion: "test",
    models: [],
  };
  const get = vi.fn(async () => account);
  window.mangaApi = createTestMangaGatewayStub({ getCodexAccount: get });
  const view = renderHook(() => useCodexConnection(true));
  await act(async () => {
    await Promise.resolve();
  });
  expect(get).toHaveBeenCalledOnce();
  expect(view.result.current.account).toEqual(account);
  await act(() => vi.advanceTimersByTimeAsync(120000));
  expect(get).toHaveBeenCalledOnce();
  hidden.mockReturnValue(false);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(get).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(() => vi.advanceTimersByTimeAsync(120000));
  expect(get).toHaveBeenCalledTimes(2);
});
