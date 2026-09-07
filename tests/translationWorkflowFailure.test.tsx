import { makeChapter, makeOptions } from "./translationWorkflowFixtures";
// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { NotificationPort } from "../src/renderer/src/lib/notificationPort";

const startAnalysis = vi.fn();
const startInpainting = vi.fn();
const startSoundEffectTranslation = vi.fn();
const openChapter = vi.fn();
const finishPageTimingSession = vi.fn(async () => ({ updated: true }));
const notificationMocks: NotificationPort = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
};

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
    finishPageTimingSession,
    openChapter,
    startAnalysis,
    startInpainting,
    startSoundEffectTranslation,
  });
});

import { useTranslationActions } from "../src/renderer/src/hooks/useTranslationActions";

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
  vi.clearAllMocks();
});

describe("translation failure propagation", () => {
  it.each(["result", "exception"])(
    "retains the actual translation failure before inpainting starts (%s)",
    async (kind) => {
      const options = makeOptions();
      const message = "자동 폰트 맞춤 실패: source evidence unavailable";
      openChapter.mockResolvedValue(makeChapter());
      if (kind === "result")
        startAnalysis.mockResolvedValue({ status: "failed", error: message });
      else startAnalysis.mockRejectedValue(new Error(message));
      const { result } = renderHook(() =>
        useTranslationActions(options, notificationMocks),
      );
      await act(async () => {
        expect(
          await result.current.runTranslationFlow({
            selection: [{ chapterId: "chapter-1", mode: "pending" }],
            workflowMode: "cumulative",
            blockMode: "auto",
            eraseOriginalWorkflow: true,
            bubbleLayoutWorkflow: true,
          }),
        ).toBe("failed");
      });
      expect(startInpainting).not.toHaveBeenCalled();
      expect(notificationMocks.error).toHaveBeenCalledWith(message);
      expect(options.setJobState).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "failed", detail: message }),
      );
    },
  );
});
