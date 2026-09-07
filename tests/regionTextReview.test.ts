import { expect, it, vi } from "vitest";
import {
  waitForRegionTextReview,
  confirmRegionTranslation,
} from "../src/main/jobs/regionTranslationReview";
import type { CodexPageReading } from "../src/shared/codexTypesettingTypes";
const sessionId = "11111111-1111-4111-8111-111111111111";
const reading: CodexPageReading = {
  summary: "context",
  regions: ["a", "b", "c", "keep"].map((id) => ({
    id,
    action: id === "keep" ? "keep" : "image",
    sourceText: "ゴ",
    translatedText: "고오",
    sourceBbox: { x: 0, y: 0, w: 100, h: 100 },
    renderBbox: { x: 0, y: 0, w: 100, h: 100 },
    role: "sound",
    direction: "horizontal",
    background: "artwork",
    reason: "effect",
  })),
};
function setup(jobId = "job") {
  const controller = new AbortController();
  const show = vi.fn();
  const promise = waitForRegionTextReview({
    jobId,
    sessionId,
    reading,
    signal: controller.signal,
    show,
  });
  return { controller, show, promise };
}
const translations = ["a", "b", "c"].map((regionId) => ({
  regionId,
  text: "고",
}));
it("pauses with all three targets and applies exact user text without trusting client boxes", async () => {
  const { show, promise } = setup();
  const done = vi.fn();
  void promise.then(done);
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  expect(show.mock.calls[0][0].regions).toHaveLength(3);
  expect(
    confirmRegionTranslation({ jobId: "job", sessionId, translations }),
  ).toBe(true);
  const result = await promise;
  expect(
    result.regions
      .slice(0, 3)
      .map((r) => [r.translatedText, r.translationLocked]),
  ).toEqual([
    ["고", true],
    ["고", true],
    ["고", true],
  ]);
  expect(result.regions[3]).toEqual(reading.regions[3]);
  expect(reading.regions[0].translatedText).toBe("고오");
  expect(() =>
    confirmRegionTranslation({ jobId: "job", sessionId, translations }),
  ).toThrow(/만료/);
});
it("rejects stale, missing, duplicate, extra and empty answers while keeping the pending input", async () => {
  const { promise } = setup();
  for (const input of [
    { sessionId: "22222222-2222-4222-8222-222222222222", translations },
    { sessionId, translations: translations.slice(0, 2) },
    {
      sessionId,
      translations: [translations[0], translations[0], translations[1]],
    },
    {
      sessionId,
      translations: [...translations, { regionId: "keep", text: "고" }],
    },
    {
      sessionId,
      translations: translations.map((t) => ({ ...t, text: "  " })),
    },
  ])
    expect(() =>
      confirmRegionTranslation({ jobId: "job", ...input }),
    ).toThrow();
  confirmRegionTranslation({ jobId: "job", sessionId, translations });
  await promise;
});
it("cancels a pending review and rejects late submissions", async () => {
  const { controller, promise } = setup();
  const rejection = expect(promise).rejects.toThrow("stopped");
  controller.abort(new Error("stopped"));
  await rejection;
  expect(() =>
    confirmRegionTranslation({ jobId: "job", sessionId, translations }),
  ).toThrow(/만료/);
});
it("cleans up a failed delivery, rejects duplicate review and handles pre-cancelled or empty readings", async () => {
  const first = setup();
  await expect(
    waitForRegionTextReview({
      jobId: "job",
      sessionId,
      reading,
      signal: first.controller.signal,
      show: vi.fn(),
    }),
  ).rejects.toThrow(/이미/);
  first.controller.abort(new Error("done"));
  await expect(first.promise).rejects.toThrow("done");
  await expect(
    waitForRegionTextReview({
      jobId: "job",
      sessionId,
      reading,
      signal: first.controller.signal,
      show: vi.fn(),
    }),
  ).rejects.toThrow("done");
  await expect(
    waitForRegionTextReview({
      jobId: "job",
      sessionId,
      reading: { summary: "", regions: [] },
      signal: new AbortController().signal,
      show: vi.fn(),
    }),
  ).rejects.toThrow(/찾지/);
  await expect(
    waitForRegionTextReview({
      jobId: "job",
      sessionId,
      reading,
      signal: new AbortController().signal,
      show: () => {
        throw Error("delivery");
      },
    }),
  ).rejects.toThrow("delivery");
  const last = setup();
  confirmRegionTranslation({ jobId: "job", sessionId, translations });
  await last.promise;
});
