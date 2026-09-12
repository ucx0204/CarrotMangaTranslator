import { expect, it, vi } from "vitest";
import {
  waitForSoundEffectTextReview,
  confirmSoundEffectTextReview,
} from "../src/main/application/soundEffectTextReview";
import type { CodexPageReading } from "../src/shared/codexTypesettingTypes";
const sessionId = "11111111-1111-4111-8111-111111111111";
const reading: CodexPageReading = {
  summary: "",
  regions: [
    {
      id: "r",
      action: "image",
      sourceText: "ゴ",
      translatedText: "고",
      sourceBbox: { x: 100, y: 100, w: 100, h: 100 },
      renderBbox: { x: 100, y: 100, w: 100, h: 100 },
      role: "sound",
      direction: "horizontal",
      background: "artwork",
      reason: "",
    },
  ],
};

it("validates every page atomically and allows correction after an invalid batch", async () => {
  const signal = new AbortController().signal;
  const resolved = vi.fn();
  const result = waitForSoundEffectTextReview({
    jobId: "batch",
    sessionId,
    signal,
    show: vi.fn(),
    pages: ["a", "b"].map((pageId) => ({
      pageId,
      name: pageId,
      imagePath: pageId,
      width: 800,
      height: 1200,
      reading,
    })),
  }).then((value) => {
    resolved();
    return value;
  });
  const request = {
    jobId: "batch",
    sessionId,
    pages: ["a", "b"].map((pageId) => ({
      pageId,
      translations: [{ regionId: "r", text: "수정" }],
    })),
  };
  expect(() =>
    confirmSoundEffectTextReview({
      ...request,
      pages: [
        request.pages[0],
        { pageId: "b", translations: [{ regionId: "unknown", text: "bad" }] },
      ],
    }),
  ).toThrow();
  expect(() =>
    confirmSoundEffectTextReview({
      ...request,
      pages: [request.pages[0], request.pages[0]],
    }),
  ).toThrow();
  await Promise.resolve();
  expect(resolved).not.toHaveBeenCalled();
  confirmSoundEffectTextReview(request);
  expect(
    [...(await result).values()].every(
      (page) => page.regions[0].translatedText === "수정",
    ),
  ).toBe(true);
  expect(() => confirmSoundEffectTextReview(request)).toThrow("만료");
});

function reviewPage(pageId: string) {
  return {
    pageId,
    name: pageId,
    imagePath: pageId,
    width: 800,
    height: 1200,
    reading,
  };
}

it("rejects a same-sized wrong page set without resolving the pending batch", async () => {
  const resolved = vi.fn();
  const result = waitForSoundEffectTextReview({
    jobId: "wrong-pages",
    sessionId,
    signal: new AbortController().signal,
    pages: [reviewPage("a"), reviewPage("b")],
    show: vi.fn(),
  }).then(resolved);
  const request = {
    jobId: "wrong-pages",
    sessionId,
    pages: ["a", "b"].map((pageId) => ({
      pageId,
      translations: [{ regionId: "r", text: "수정" }],
    })),
  };
  expect(() =>
    confirmSoundEffectTextReview({
      ...request,
      pages: [request.pages[0], { ...request.pages[1], pageId: "different" }],
    }),
  ).toThrow("페이지 목록");
  expect(() =>
    confirmSoundEffectTextReview({
      ...request,
      sessionId: "22222222-2222-4222-8222-222222222222",
    }),
  ).toThrow("만료");
  await Promise.resolve();
  expect(resolved).not.toHaveBeenCalled();
  expect(confirmSoundEffectTextReview(request)).toBe(true);
  await result;
  expect(resolved).toHaveBeenCalledOnce();
});

it("preserves an active waiter on duplicate entry and releases it on cancellation", async () => {
  const controller = new AbortController();
  const options = {
    jobId: "cancelled-batch",
    sessionId,
    signal: controller.signal,
    pages: [reviewPage("a")],
    show: vi.fn(),
  };
  const result = waitForSoundEffectTextReview(options);
  await expect(waitForSoundEffectTextReview(options)).rejects.toThrow("이미");
  expect(options.show).toHaveBeenCalledOnce();
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  const request = {
    jobId: options.jobId,
    sessionId,
    pages: [{ pageId: "a", translations: [{ regionId: "r", text: "수정" }] }],
  };
  expect(() => confirmSoundEffectTextReview(request)).toThrow("만료");
  const retry = waitForSoundEffectTextReview({
    ...options,
    signal: new AbortController().signal,
  });
  confirmSoundEffectTextReview(request);
  expect((await retry).get("a")?.regions[0].translatedText).toBe("수정");
});
